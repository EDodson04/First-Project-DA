const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { emailCustomerQuote } = require('../services/email');
const { createDepositSession } = require('../services/stripe');

// GET /api/quotes
router.get('/', (req, res) => {
  const status = req.query.status;
  let quotes;
  if (status) {
    quotes = db.db.prepare(`
      SELECT q.*, i.phone, i.message, i.photo_url, i.analysis
      FROM quotes q JOIN inquiries i ON q.inquiry_id = i.id
      WHERE q.status = ?
      ORDER BY q.created_at DESC
    `).all(status);
  } else {
    quotes = db.db.prepare(`
      SELECT q.*, i.phone, i.message, i.photo_url, i.analysis
      FROM quotes q JOIN inquiries i ON q.inquiry_id = i.id
      ORDER BY q.created_at DESC
      LIMIT 100
    `).all();
  }
  res.json(quotes.map(q => ({ ...q, analysis: tryParse(q.analysis) })));
});

// GET /api/quotes/pending
router.get('/pending', (req, res) => {
  const quotes = db.getPendingReviewQuotes();
  res.json(quotes.map(q => ({ ...q, analysis: tryParse(q.analysis) })));
});

// GET /api/quotes/:id
router.get('/:id', (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  res.json({ ...quote, analysis: tryParse(quote.analysis) });
});

// PUT /api/quotes/:id
router.put('/:id', (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });

  const fields = {
    load_size: req.body.load_size ?? quote.load_size,
    base_price: req.body.base_price ?? quote.base_price,
    fuel_surcharge: req.body.fuel_surcharge ?? quote.fuel_surcharge,
    tire_surcharge: req.body.tire_surcharge ?? quote.tire_surcharge,
    appliance_surcharge: req.body.appliance_surcharge ?? quote.appliance_surcharge,
    mattress_surcharge: req.body.mattress_surcharge ?? quote.mattress_surcharge,
    electronics_surcharge: req.body.electronics_surcharge ?? quote.electronics_surcharge,
    hazmat_surcharge: req.body.hazmat_surcharge ?? quote.hazmat_surcharge,
    other_surcharge: req.body.other_surcharge ?? quote.other_surcharge,
    other_surcharge_note: req.body.other_surcharge_note ?? quote.other_surcharge_note,
    owner_notes: req.body.owner_notes ?? quote.owner_notes,
  };

  db.updateQuote(req.params.id, fields);
  res.json(db.getQuote(req.params.id));
});

// POST /api/quotes/:id/approve — approve and email customer
router.post('/:id/approve', async (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  if (quote.status !== 'pending_review') {
    return res.status(400).json({ error: `Quote is already ${quote.status}` });
  }

  db.approveQuote(req.params.id);

  // Look up customer email
  const customerEmail = req.body.customer_email || getCustomerEmail(quote);
  const customerName  = req.body.customer_name  || getCustomerName(quote);

  // Create a pending_deposit job immediately so it appears in the jobs dashboard
  // and schedule view right away — without waiting for the Stripe webhook
  const depositAmount = Math.ceil((quote.total_price || 0) / 2 / 5) * 5;
  const balanceAmount = Math.max(0, (quote.total_price || 0) - depositAmount);
  const customer = getCustomerRecord(quote);
  if (customer?.id) {
    const existingJob = db.db.prepare('SELECT id FROM jobs WHERE quote_id = ?').get(req.params.id);
    if (!existingJob) {
      const jobId = db.createJob(customer.id, parseInt(req.params.id), {
        estimated_duration_minutes: 60,
        deposit_amount: depositAmount,
        balance_amount: balanceAmount,
      });
      db.updateJobPayment(jobId, {
        customer_email: customerEmail || null,
        status: 'pending_deposit',
      });
    }
  }

  if (!customerEmail) {
    db.markQuoteSent(req.params.id);
    return res.json({ success: true, message: 'Quote approved — no customer email on file, send manually.' });
  }

  try {
    // Create Stripe Checkout Session (saves card for later balance charge)
    let checkoutUrl = null;
    let stripeCustomerId = null;

    try {
      const session = await createDepositSession(
        depositAmount,
        `Gone by Monday — 50% Deposit`,
        {
          job_id: '', // will be filled when job is created on deposit payment
          quote_id: String(req.params.id),
          customer_name: customerName || '',
          customer_email: customerEmail,
          payment_type: 'deposit',
        }
      );
      checkoutUrl = session?.url || null;
      stripeCustomerId = session?.customerId || null;
    } catch (stripeErr) {
      console.error('Stripe session error (non-fatal):', stripeErr.message);
    }

    // Store checkout URL + deposit amount on the quote
    if (checkoutUrl || depositAmount) {
      db.updateQuoteStripe(req.params.id, { stripe_checkout_url: checkoutUrl, deposit_amount: depositAmount });
    }

    const BASE = process.env.BASE_URL || 'https://gone-by-monday.onrender.com';
    const approveUrl = checkoutUrl || `${BASE}/approve.html?quote_id=${req.params.id}`;

    await emailCustomerQuote({ customerEmail, customerName, quote, approveUrl });
    db.markQuoteSent(req.params.id);

    res.json({
      success: true,
      message: 'Quote approved and emailed to customer',
      checkout_url: checkoutUrl,
      approve_url: approveUrl,
      customer_name: customerName || null,
      total_price: quote.total_price,
      deposit_amount: depositAmount,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// POST /api/quotes/:id/reject
router.post('/:id/reject', (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  db.rejectQuote(req.params.id);
  if (quote.inquiry_id) db.updateInquiryStatus(quote.inquiry_id, 'declined');
  res.json({ success: true });
});

// POST /api/quotes/:id/resend — resend email
router.post('/:id/resend', async (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });

  const customerEmail = req.body.customer_email || getCustomerEmail(quote);
  const customerName  = req.body.customer_name  || getCustomerName(quote);
  if (!customerEmail) return res.status(400).json({ error: 'No customer email on file' });

  try {
    const BASE = process.env.BASE_URL || 'https://gone-by-monday.onrender.com';
    const approveUrl = quote.stripe_checkout_url || `${BASE}/approve.html?quote_id=${quote.id}`;
    await emailCustomerQuote({ customerEmail, customerName, quote, approveUrl });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCustomerRecord(quote) {
  if (!quote.inquiry_id) return null;
  return db.db.prepare(
    'SELECT * FROM customers WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1'
  ).get(quote.inquiry_id) || null;
}

function getCustomerEmail(quote) {
  if (!quote.inquiry_id) return null;
  const customer = db.db.prepare(
    'SELECT email FROM customers WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1'
  ).get(quote.inquiry_id);
  return customer?.email || null;
}

function getCustomerName(quote) {
  if (!quote.inquiry_id) return null;
  const customer = db.db.prepare(
    'SELECT name FROM customers WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1'
  ).get(quote.inquiry_id);
  return customer?.name || null;
}

function tryParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

module.exports = router;
