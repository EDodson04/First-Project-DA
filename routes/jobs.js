const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { createJobEvent, deleteJobEvent } = require('../services/googleCalendar');
const { sendSms } = require('../services/twilio');

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

// PUT /api/jobs/:id — update job
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

// POST /api/jobs/:id/complete
router.post('/:id/complete', (req, res) => {
  db.updateJobStatus(req.params.id, 'completed');
  res.json({ success: true });
});

// POST /api/jobs/:id/remind — send 30-min heads-up SMS
router.post('/:id/remind', async (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const msg = `Heads up! The Gone by Monday crew is about 30 minutes away for your pickup at ${job.address}. See you soon! 🚛`;
  try {
    await sendSms(job.phone, msg);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
