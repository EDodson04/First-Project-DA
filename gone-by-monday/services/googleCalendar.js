const { google } = require('googleapis');

function getCalendarClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    console.error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON');
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth });
}

const CALENDAR_ID = () => process.env.GOOGLE_CALENDAR_ID || 'primary';
const TZ = () => process.env.BUSINESS_TIMEZONE || 'America/Denver';

async function createJobEvent(job, customer) {
  const cal = getCalendarClient();
  if (!cal) {
    console.warn('Google Calendar not configured — skipping event creation');
    return null;
  }

  const date = job.scheduled_date;
  if (!date) return null;

  // Default start 8 AM if no specific time
  const startHour = 8;
  const durationHours = Math.ceil((job.estimated_duration_minutes || 60) / 60);

  const start = new Date(`${date}T${String(startHour).padStart(2, '0')}:00:00`);
  const end = new Date(start.getTime() + durationHours * 3600000);

  const event = {
    summary: `🚛 Gone by Monday — ${customer.name || customer.phone}`,
    location: `${customer.address}, ${customer.city || 'Logan'}, ${customer.state || 'UT'}`,
    description: [
      `Customer: ${customer.name || 'Unknown'}`,
      `Phone: ${customer.phone}`,
      `Load Size: ${job.load_size || 'TBD'}`,
      `Estimated Duration: ${job.estimated_duration_minutes || 60} min`,
      `Job ID: ${job.id}`,
    ].join('\n'),
    start: { dateTime: start.toISOString(), timeZone: TZ() },
    end: { dateTime: end.toISOString(), timeZone: TZ() },
    colorId: '2', // sage green
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 1440 }, // 24 hours
      ],
    },
  };

  try {
    const res = await cal.events.insert({ calendarId: CALENDAR_ID(), requestBody: event });
    return res.data.id;
  } catch (err) {
    console.error('Calendar insert error:', err.message);
    return null;
  }
}

async function updateJobEvent(eventId, updates) {
  const cal = getCalendarClient();
  if (!cal || !eventId) return;
  try {
    await cal.events.patch({
      calendarId: CALENDAR_ID(),
      eventId,
      requestBody: updates,
    });
  } catch (err) {
    console.error('Calendar update error:', err.message);
  }
}

async function deleteJobEvent(eventId) {
  const cal = getCalendarClient();
  if (!cal || !eventId) return;
  try {
    await cal.events.delete({ calendarId: CALENDAR_ID(), eventId });
  } catch (err) {
    console.error('Calendar delete error:', err.message);
  }
}

module.exports = { createJobEvent, updateJobEvent, deleteJobEvent };
