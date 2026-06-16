const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET /api/dashboard/stats
router.get('/stats', (req, res) => {
  res.json(db.getDashboardStats());
});

// GET /api/dashboard/activity — recent SMS log
router.get('/activity', (req, res) => {
  const rows = db.db.prepare(`
    SELECT * FROM sms_log ORDER BY created_at DESC LIMIT 50
  `).all();
  res.json(rows);
});

// GET /api/customers
router.get('/customers', (req, res) => {
  const customers = db.db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  res.json(customers);
});

module.exports = router;
