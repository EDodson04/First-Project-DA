const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { createJobEvent, deleteJobEvent } = require('../services/googleCalendar');
const { emailCustomerReceipt } = require('../services/email');
const { chargeStoredCard, createPaymentLink } = require('../services/stripe');

// GET /api/jobs
router.get('/', (req, res) => {
  const { status, date } = req.query;
  let jobs;
  if (date) {
    jobs = db.getJobsByDate(date);
  } else {
    jobs = db.getAllJobs(status || null);
  }
  res.json(jobs);
});

// GET /api/jobs/:id
router.get('/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// POST /api/jobs — manual job creation
router.post('/', async (req, res) => {
  const { customer_id, quote_id, scheduled_date, estimated_duration_minutes, notes } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'customer_id required' });

  const jobId = db.createJob(customer_id, quote_id || null, {
    scheduled_date,
    estimated_duration_minutes: estimated_duration_minutes || 60,
    notes,
  });

  const job = db.getJob(jobId);
  const customer = db.getCustomer(customer_id);

  if (job && customer) {
    try {
      const eventId = await createJobEvent(job, customer);
      if (eventId) db.updateJobCalendarEvent(jobId, eventId);
    } catch (err) {
      console.error('Calendar error:', err.message);
    }
  }

  res.status(201).json(db.getJob(jobId));
});

// PUT /api/jobs/:id
router.put('/:id', async (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const { scheduled_date, estimated_duration_minutes, notes, status } = req.body;

  if (scheduled_date && scheduled_date !== job.scheduled_date) {
    db.updateJobDate(req.params.id, scheduled_date);
  }
  if (status) {
    db.updateJobStatus(req.params.id, status);
  }
  if (estimated_duration_minutes || notes) {
    db.db.prepare('UPDATE jobs SET estimated_duration_minutes=COALESCE(?,estimated_duration_minutes), notes=COALESCE(?,notes) WHERE id=?')
      .run(estimated_duration_minutes || null, notes || null, req.params.id);
  }

  res.json(db.getJob(req.params.id));
});

// DELETE /api/jobs/:id
router.delete('/:id', async (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  if (job.calendar_event_id) {
    await deleteJobEvent(job.calendar_event_id).catch(e => console.error(e.message));
  }

  db.updateJobStatus(req.params.id, 'cancelled');
  res.json({ success: true });
});

// POST /api/jobs/:id/complete — charge balance and email receipt
router.post('/:id/complete', async (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  db.updateJobStatus(req.params.id, 'completed');

  const balanceAmount = job.balance_amount || 0;
  const customerEmail = job.customer_email || getCustomerEmailFromJob(job);
  const customerName  = job.name || null;
  let amountCharged = 0;

  if (balanceAmount > 0) {
    // Try auto-charge via saved card
    if (job.stripe_customer_id && job.stripe_payment_method_id) {
      try {
        await chargeStoredCard(
          balanceAmount,
          'Gone by Monday — Balance Payment',
          job.stripe_customer_id,
          job.stripe_payment_method_id,
          { job_id: String(job.id), payment_type: 'balance' }
        );
        amountCharged = balanceAmount;
        db.updateJobPayment(job.id, {
          balance_paid_at: new Date().toISOString(),
          status: 'paid',
        });
      } catch (chargeErr) {
        console.error('Auto-charge failed, falling back to payment link:', chargeErr.message);
        // Fall through to send a payment link instead
        await sendBalanceLink(job, balanceAmount, customerEmail);
      }
    } else {
      // No saved card — send a payment link
      await sendBalanceLink(job, balanceAmount, customerEmail);
    }
  } else {
    db.updateJobPayment(job.id, { status: 'paid' });
  }

  // Email receipt to customer
  if (customerEmail) {
    try {
      await emailCustomerReceipt({
        customerEmail,
        customerName,
        job,
        amountCharged,
      });
    } catch (err) {
      console.error('Receipt email error:', err.message);
    }
  }

  res.json({ success: true, amount_charged: amountCharged });
});

// POST /api/jobs/:id/payment — manually record payment
router.post('/:id/payment', (req, res) => {
  const { payment_type, method } = req.body;
  const now = new Date().toISOString();
  const fields = {};
  if (payment_type === 'deposit') {
    fields.deposit_paid_at = now;
    fields.payment_method = method || 'manual';
    fields.status = 'confirmed';
  } else {
    fields.balance_paid_at = now;
    fields.status = 'paid';
  }
  db.updateJobPayment(req.params.id, fields);
  res.json({ success: true });
});

// POST /api/jobs/:id/remind — placeholder (owner texts manually per spec)
router.post('/:id/remind', (req, res) => {
  res.json({ success: true, message: 'Reminder logged — owner sends text manually' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendBalanceLink(job, amount, customerEmail) {
  if (!customerEmail) return;
  try {
    const link = await createPaymentLink(
      amount,
      'Gone by Monday — Balance Payment',
      { job_id: String(job.id), payment_type: 'balance' }
    );
    if (link) {
      const { sendMail } = require('../services/email');
      const venmo = process.env.VENMO_HANDLE ? `<p>Or pay via Venmo: <strong>@${process.env.VENMO_HANDLE}</strong></p>` : '';
      await sendMail(
        customerEmail,
        `Gone by Monday — Balance payment of $${amount.toFixed(2)} due`,
        `<div style="font-family:system-ui,sans-serif;max-width:560px">
          <h2 style="color:#2d6a4f">Job Complete!</h2>
          <p>Balance due: <strong>$${amount.toFixed(2)}</strong></p>
          <p><a href="${link}" style="background:#e76f00;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block">Pay Now →</a></p>
          ${venmo}
          <p style="color:#616161">Thanks for choosing Gone by Monday!</p>
        </div>`
      );
    }
  } catch (err) {
    console.error('Balance link email error:', err.message);
  }
}

function getCustomerEmailFromJob(job) {
  if (!job.customer_id) return null;
  const c = db.db.prepare('SELECT email FROM customers WHERE id = ?').get(job.customer_id);
  return c?.email || null;
}

module.exports = router;
