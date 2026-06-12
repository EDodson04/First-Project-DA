require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const webhookRoutes = require('./routes/webhook');
const quotesRoutes = require('./routes/quotes');
const jobsRoutes = require('./routes/jobs');
const scheduleRoutes = require('./routes/schedule');
const dashboardRoutes = require('./routes/dashboard');
const { requireAuth } = require('./middleware/auth');
const { startCronJobs } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Twilio Webhooks (no auth — Twilio signature validates these) ──────────────
app.use('/webhook', webhookRoutes);

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const pwd = process.env.DASHBOARD_PASSWORD || '';
  if (!pwd || req.body.password === pwd) {
    res.json({ token: pwd });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ── Protected API ─────────────────────────────────────────────────────────────
app.use('/api/quotes', requireAuth, quotesRoutes);
app.use('/api/jobs', requireAuth, jobsRoutes);
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Gone by Monday' }));

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚛 Gone by Monday server running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Twilio webhook: http://localhost:${PORT}/webhook/sms`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
  startCronJobs();
});

module.exports = app;
