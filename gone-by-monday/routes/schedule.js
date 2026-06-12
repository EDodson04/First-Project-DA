const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { optimizeRoute } = require('../services/maps');
const { calculateDayCapacity, sendRouteSummary } = require('../services/scheduler');

// GET /api/schedule/:date — capacity info for a date
router.get('/:date', (req, res) => {
  const { date } = req.params;
  const cap = calculateDayCapacity(date);
  res.json(cap);
});

// GET /api/schedule/:date/optimize — optimize route for a date
router.post('/:date/optimize', async (req, res) => {
  const { date } = req.params;
  const jobs = db.getJobsByDate(date);

  if (!jobs.length) return res.json({ jobs: [], message: 'No jobs for this date' });

  const startAddress = process.env.LANDFILL_ADDRESS || 'Logan, UT 84321';

  let optimized;
  try {
    optimized = await optimizeRoute(startAddress, jobs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Persist new order and drive times
  for (const job of optimized) {
    db.updateJobOrder(job.id, job.scheduled_order, job.drive_time_from_prev_minutes || 0);
  }

  res.json({ jobs: optimized, optimized: true });
});

// GET /api/schedule/week/:startDate — week view
router.get('/week/:startDate', (req, res) => {
  const start = new Date(req.params.startDate + 'T12:00:00');
  const days = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const dateStr = d.toLocaleDateString('en-CA');
    days.push(calculateDayCapacity(dateStr));
  }

  res.json(days);
});

// POST /api/schedule/:date/landfill — add a landfill run
router.post('/:date/landfill', (req, res) => {
  const { date } = req.params;
  const existing = db.getLandfillRuns(date);
  const runNumber = existing.length + 1;
  db.addLandfillRun(date, runNumber);
  res.json({ success: true, run_number: runNumber });
});

// POST /api/schedule/:date/summary — trigger route summary SMS
router.post('/:date/summary', async (req, res) => {
  try {
    await sendRouteSummary(req.params.date);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
