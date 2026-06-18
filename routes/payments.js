const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { sendSms } = require('../services/twilio');
const { constructWebhookEvent } = require('../services/stripe');

// POST /api/payments/webhook — Stripe webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) return res.sendStatus(200); // Not configured

  let event;
  try {
    event = constructWebhookEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed' || event.type === 'payment_link.payment_completed') {
    const session = event.data.object;
    const { job_id, payment_type } = session.metadata || {};

    if (job_id) {
      const now = new Date().toISOString();
      const amountPaid = session.amount_total / 100;

      if (payment_type === 'deposit') {
        db.updateJobPayment(job_id, {
          deposit_paid_at: now,
          deposit_stripe_id: session.id,
          status: 'confirmed',
        });
        const job = db.getJob(job_id);
        if (job?.phone) {
          await sendSms(job.phone,
            `✅ Deposit received! Your Gone by Monday pickup is confirmed.\n\nWe'll text you 30 min before we arrive. See you ${job.scheduled_date ? 'on ' + job.scheduled_date : 'soon'}!`
          ).catch(() => {});
        }
      } else if (payment_type === 'balance') {
        db.updateJobPayment(job_id, {
          balance_paid_at: now,
          balance_stripe_id: session.id,
          status: 'paid',
        });
      }
    }
  }

  res.sendStatus(200);
});

module.exports = router;
