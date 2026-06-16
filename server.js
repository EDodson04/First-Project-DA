require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Health check — registered first so Render's health probe always works ─────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Gone by Monday' }));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Lazy-load routes so a bad import doesn't kill the health check ────────────
const webhookRoutes  = require('./routes/webhook');
const quotesRoutes   = require('./routes/quotes');
const jobsRoutes     = require('./routes/jobs');
const scheduleRoutes = require('./routes/schedule');
const dashboardRoutes = require('./routes/dashboard');
const { requireAuth } = require('./middleware/auth');

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
app.use('/api/quotes',   requireAuth, quotesRoutes);
app.use('/api/jobs',     requireAuth, jobsRoutes);
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.status(404).json({ error: 'Not found' });
  });
});

// ── Catch unhandled errors so the process stays alive ────────────────────────
process.on('uncaughtException',  (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// ── Start — bind to 0.0.0.0 so Render's proxy can reach the container ────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚛 Gone by Monday running on 0.0.0.0:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Twilio webhook URL: <BASE_URL>/webhook/sms\n`);

  // Start cron jobs after server is confirmed listening
  try {
    const { startCronJobs } = require('./services/scheduler');
    startCronJobs();
  } catch (err) {
    console.error('Cron job init error (non-fatal):', err.message);
  }
});

module.exports = app;
