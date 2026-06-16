const cron = require('node-cron');
const { getJobsByDate, getLandfillRuns, addLandfillRun } = require('../database/db');
const { sendSms } = require('./twilio');
const { optimizeRoute } = require('./maps');

const OWNER_PHONE = () => process.env.OWNER_PHONE;
const MAX_DAILY_JOBS = () => parseInt(process.env.MAX_DAILY_JOBS) || 8;
const LANDFILL_ROUNDTRIP = () => parseInt(process.env.LANDFILL_ROUNDTRIP_MINUTES) || 60;
const DAILY_START = () => process.env.DAILY_START_TIME || '08:00';
const DAILY_END = () => process.env.DAILY_END_TIME || '18:00';
const TZ = () => process.env.BUSINESS_TIMEZONE || 'America/Denver';

function todayMDT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ() });
}

function nextDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toLocaleDateString('en-CA', { timeZone: TZ() });
}

// ─── Capacity Calculator ──────────────────────────────────────────────────────

function calculateDayCapacity(date) {
  const jobs = getJobsByDate(date);
  const landfillRuns = getLandfillRuns(date);

  const [startH, startM] = DAILY_START().split(':').map(Number);
  const [endH, endM] = DAILY_END().split(':').map(Number);
  const totalMinutes = (endH * 60 + endM) - (startH * 60 + startM);

  let usedMinutes = 0;
  for (const job of jobs) {
    usedMinutes += (job.estimated_duration_minutes || 60);
    usedMinutes += (job.drive_time_from_prev_minutes || 10);
  }
  usedMinutes += landfillRuns.length * LANDFILL_ROUNDTRIP();

  const remainingMinutes = totalMinutes - usedMinutes;
  const jobCount = jobs.length;
  const atCapacity = jobCount >= MAX_DAILY_JOBS() || remainingMinutes < 60;

  return {
    date,
    jobCount,
    maxJobs: MAX_DAILY_JOBS(),
    totalMinutes,
    usedMinutes,
    remainingMinutes,
    landfillRuns: landfillRuns.length,
    atCapacity,
    jobs,
  };
}

// ─── Route Summary Builder ────────────────────────────────────────────────────

async function buildRouteSummaryForDate(date) {
  const jobs = getJobsByDate(date);
  if (!jobs.length) return null;

  const startAddress = process.env.LANDFILL_ADDRESS || 'Logan, UT';
  const optimized = await optimizeRoute(startAddress, jobs);

  return { date, jobs: optimized };
}

// ─── Overflow Notification ────────────────────────────────────────────────────

async function checkAndNotifyCapacity(date) {
  const cap = calculateDayCapacity(date);
  if (cap.atCapacity && OWNER_PHONE()) {
    const msg = `⚠️ Heads up: ${date} is at capacity (${cap.jobCount} jobs, ~${cap.remainingMinutes} min left). New requests should be moved to another day.`;
    try {
      await sendSms(OWNER_PHONE(), msg);
    } catch (err) {
      console.error('Overflow SMS error:', err.message);
    }
  }
  return cap;
}

// ─── Cron Jobs ────────────────────────────────────────────────────────────────

function startCronJobs() {
  // Sunday evening (6 PM MDT) — route summary for Monday
  cron.schedule('0 18 * * 0', async () => {
    console.log('Running Sunday route summary...');
    const monday = getNextWeekday('Monday');
    await sendRouteSummary(monday);
  }, { timezone: TZ() });

  // Monday evening (6 PM MDT) — route summary for Tuesday
  cron.schedule('0 18 * * 1', async () => {
    console.log('Running Monday route summary...');
    const tuesday = getNextWeekday('Tuesday');
    await sendRouteSummary(tuesday);
  }, { timezone: TZ() });

  // Daily at 7:30 AM — remind owner of today's jobs
  cron.schedule('30 7 * * *', async () => {
    const today = todayMDT();
    const cap = calculateDayCapacity(today);
    if (cap.jobCount > 0 && OWNER_PHONE()) {
      const msg = `🚛 Good morning! Today (${today}) you have ${cap.jobCount} job(s) scheduled.\nEstimated ${cap.usedMinutes} min of work + ${cap.landfillRuns} landfill run(s).`;
      await sendSms(OWNER_PHONE(), msg).catch(e => console.error(e.message));
    }
  }, { timezone: TZ() });
}

async function sendRouteSummary(date) {
  const owner = OWNER_PHONE();
  if (!owner) return;

  const summary = await buildRouteSummaryForDate(date);
  if (!summary) {
    await sendSms(owner, `No jobs scheduled for ${date}.`).catch(() => {});
    return;
  }

  const lines = [`📋 Route Summary — ${date}\n`];
  summary.jobs.forEach((job, i) => {
    lines.push(`${i + 1}. ${job.name || job.phone}`);
    lines.push(`   📍 ${job.address}${job.city ? ', ' + job.city : ''}`);
    if (job.drive_time_from_prev_minutes > 0) lines.push(`   🚗 +${job.drive_time_from_prev_minutes} min drive`);
    lines.push(`   ⏱ ~${job.estimated_duration_minutes || 60} min job`);
    lines.push('');
  });

  const cap = calculateDayCapacity(date);
  lines.push(`Total: ${summary.jobs.length} stops · ${cap.usedMinutes} min · ${cap.landfillRuns} landfill run(s)`);

  // Split if too long for one SMS
  const full = lines.join('\n');
  const chunks = chunkString(full, 1500);
  for (const chunk of chunks) {
    await sendSms(owner, chunk).catch(e => console.error('Route summary SMS error:', e.message));
    await new Promise(r => setTimeout(r, 500));
  }
}

function getNextWeekday(dayName) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const target = days.indexOf(dayName);
  const now = new Date();
  const current = now.getDay();
  let diff = target - current;
  if (diff <= 0) diff += 7;
  const next = new Date(now);
  next.setDate(now.getDate() + diff);
  return next.toLocaleDateString('en-CA', { timeZone: TZ() });
}

function chunkString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

module.exports = { calculateDayCapacity, buildRouteSummaryForDate, checkAndNotifyCapacity, startCronJobs, sendRouteSummary };
