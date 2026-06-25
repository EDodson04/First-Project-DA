const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { emailOwnerJobConfirmed, emailCustomerReceipt } = require('../services/email');
const { constructWebhookEvent } = require('../services/stripe');
const { detectZone, calculateMileageSurcharge } = require('../services/maps');
const { geocodeAddress } = require('../services/maps');

// POST /api/payments/webhook — Stripe webhook (raw body — registered before bodyParser)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.warn('STRIPE_WEBHOOK_SECRET not set — accepting webhook without verification');
    return handleWebhookPayload(req.body, res);
  }

  let event;
  try {
    event = constructWebhookEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  await handleWebhookPayload(event, res);
});

async function handleWebhookPayload(eventOrBody, res) {
  let event = eventOrBody;

  // If raw body was passed (no signature check), parse it
  if (Buffer.isBuffer(event)) {
    try { event = JSON.parse(event.toString()); } catch { return res.sendStatus(200); }
  }

  const type = event.type;
  const obj  = event.data?.object;
  if (!obj) return res.sendStatus(200);

  if (type === 'checkout.session.completed') {
    await onCheckoutComplete(obj);
  } else if (type === 'payment_intent.succeeded') {
    await onPaymentIntentSucceeded(obj);
  }

  res.sendStatus(200);
}

async function onCheckoutComplete(session) {
  const { quote_id, payment_type, customer_name, customer_email } = session.metadata || {};

  if (payment_type !== 'deposit' || !quote_id) return;

  const quote = db.getQuote(quote_id);
  if (!quote) return;

  const now = new Date().toISOString();
  const amountPaid = (session.amount_total || 0) / 100;
  const stripeCustomerId = session.customer || null;
  const depositAmount = amountPaid;
  const totalPrice = quote.total_price || amountPaid * 2;
  const balanceAmount = Math.max(0, totalPrice - depositAmount);

  // Look up customer from inquiry
  let customer = null;
  if (quote.inquiry_id) {
    customer = db.db.prepare(
      'SELECT * FROM customers WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1'
    ).get(quote.inquiry_id);
  }

  // Determine scheduled date via zone logic
  let zone = 2;
  let scheduledDate = null;
  if (customer?.address) {
    try {
      const geo = await geocodeAddress(customer.address + ', Cache Valley, UT');
      if (geo) zone = detectZone(geo.formatted || customer.address);
    } catch {}
    scheduledDate = await findBestZoneDay(zone);
  }

  // If a job was pre-created at quote approval time, upgrade it; otherwise create fresh
  let jobId = findJobByQuote(quote_id);
  if (jobId) {
    // Upgrade the pending_deposit job to confirmed and fill in schedule details
    db.updateJobDate(jobId, scheduledDate);
    db.db.prepare('UPDATE jobs SET zone=?, service_type=?, time_window=? WHERE id=?')
      .run(zone, 'curb_pickup', 'morning', jobId);
    db.updateJobPayment(jobId, {
      deposit_paid_at: now,
      deposit_stripe_id: session.id,
      deposit_amount: depositAmount,
      balance_amount: balanceAmount,
      status: 'confirmed',
      stripe_customer_id: stripeCustomerId,
      customer_email: customer_email || customer?.email || null,
    });
  } else {
    // No pre-existing job — create one now
    jobId = db.createJob(customer?.id || 0, parseInt(quote_id), {
      scheduled_date: scheduledDate,
      estimated_duration_minutes: 60,
      zone,
      service_type: 'curb_pickup',
      time_window: 'morning',
      deposit_amount: depositAmount,
      balance_amount: balanceAmount,
    });
    db.updateJobPayment(jobId, {
      deposit_paid_at: now,
      deposit_stripe_id: session.id,
      status: 'confirmed',
      stripe_customer_id: stripeCustomerId,
      customer_email: customer_email || customer?.email || null,
    });
  }

  // Retrieve PaymentIntent to capture saved payment method for off-session balance charge
  if (session.payment_intent) {
    try {
      const { getStripe } = require('../services/stripe');
      const stripe = getStripe();
      const intent = await stripe.paymentIntents.retrieve(session.payment_intent);
      if (intent.payment_method) {
        db.updateJobPayment(jobId, { stripe_payment_method_id: intent.payment_method });
        console.log('[webhook] Saved stripe_payment_method_id:', intent.payment_method, 'for job', jobId);
      } else {
        console.warn('[webhook] PaymentIntent has no payment_method yet for job', jobId);
      }
    } catch (pmErr) {
      console.error('[webhook] Could not retrieve payment method:', pmErr.message);
    }
  }

  const job = db.getJob(jobId);

  // Email owner
  try {
    await emailOwnerJobConfirmed({ job, customer });
  } catch (err) {
    console.error('Owner confirm email error:', err.message);
  }
}

async function onPaymentIntentSucceeded(intent) {
  const { job_id, quote_id, payment_type } = intent.metadata || {};

  // Store payment method for off-session balance charge
  if (intent.customer && intent.payment_method && (job_id || quote_id)) {
    const resolvedJobId = job_id || findJobByQuote(quote_id);
    if (resolvedJobId) {
      db.updateJobPayment(resolvedJobId, {
        stripe_customer_id: intent.customer,
        stripe_payment_method_id: intent.payment_method,
      });
    }
  }

  // Handle explicit balance payment
  if (payment_type === 'balance' && job_id) {
    db.updateJobPayment(job_id, {
      balance_paid_at: new Date().toISOString(),
      balance_stripe_id: intent.id,
      status: 'paid',
    });
  }
}

function findJobByQuote(quoteId) {
  if (!quoteId) return null;
  const job = db.db.prepare('SELECT id FROM jobs WHERE quote_id = ? ORDER BY id DESC LIMIT 1').get(quoteId);
  return job?.id || null;
}

// ── Zone scheduling helper (duplicated from webhook.js for self-containment) ──
async function findBestZoneDay(zone) {
  const { calculateDayCapacity } = require('../services/scheduler');
  const tz = process.env.BUSINESS_TIMEZONE || 'America/Denver';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const todayDate = new Date(today + 'T12:00:00');

  const candidates = [];
  const d = new Date(todayDate);
  d.setDate(d.getDate() + 1);
  while (candidates.length < 10) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) candidates.push(d.toLocaleDateString('en-CA'));
    d.setDate(d.getDate() + 1);
  }

  for (const date of candidates) {
    const cap = calculateDayCapacity(date);
    if (!cap.atCapacity) {
      const zoneJobs = cap.jobs.filter(j => (j.zone || 2) === zone);
      if (zoneJobs.length > 0) return date;
    }
  }
  for (const date of candidates) {
    const cap = calculateDayCapacity(date);
    if (!cap.atCapacity && cap.jobCount === 0) return date;
  }
  return candidates[0];
}

module.exports = router;
