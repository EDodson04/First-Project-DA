const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'gonebymondaydb.sqlite');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    state TEXT NOT NULL DEFAULT 'new',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    message TEXT,
    photo_url TEXT,
    photo_data TEXT,
    analysis TEXT,
    status TEXT NOT NULL DEFAULT 'pending_quote',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
    load_size TEXT,
    base_price REAL NOT NULL DEFAULT 0,
    fuel_surcharge REAL NOT NULL DEFAULT 0,
    tire_surcharge REAL NOT NULL DEFAULT 0,
    appliance_surcharge REAL NOT NULL DEFAULT 0,
    mattress_surcharge REAL NOT NULL DEFAULT 0,
    electronics_surcharge REAL NOT NULL DEFAULT 0,
    hazmat_surcharge REAL NOT NULL DEFAULT 0,
    other_surcharge REAL NOT NULL DEFAULT 0,
    other_surcharge_note TEXT,
    total_price REAL NOT NULL DEFAULT 0,
    owner_notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending_review',
    sent_at TEXT,
    responded_at TEXT,
    customer_response TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id INTEGER REFERENCES inquiries(id),
    phone TEXT NOT NULL,
    name TEXT,
    address TEXT,
    city TEXT DEFAULT 'Logan',
    state TEXT DEFAULT 'UT',
    zip TEXT,
    preferred_day TEXT,
    lat REAL,
    lng REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    quote_id INTEGER REFERENCES quotes(id),
    scheduled_date TEXT,
    scheduled_order INTEGER DEFAULT 0,
    estimated_duration_minutes INTEGER DEFAULT 60,
    drive_time_from_prev_minutes INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'scheduled',
    notes TEXT,
    calendar_event_id TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS landfill_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    run_number INTEGER NOT NULL DEFAULT 1,
    estimated_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, run_number)
  );

  CREATE TABLE IF NOT EXISTS sms_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    phone TEXT NOT NULL,
    body TEXT,
    media_url TEXT,
    twilio_sid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── Conversations ────────────────────────────────────────────────────────────

function getConversation(phone) {
  const row = db.prepare('SELECT * FROM conversations WHERE phone = ?').get(phone);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

function upsertConversation(phone, state, data = {}) {
  db.prepare(`
    INSERT INTO conversations (phone, state, data, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      state = excluded.state,
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(phone, state, JSON.stringify(data));
}

// ─── Inquiries ────────────────────────────────────────────────────────────────

function createInquiry(phone, message, photoUrl, photoData, analysis) {
  const r = db.prepare(`
    INSERT INTO inquiries (phone, message, photo_url, photo_data, analysis)
    VALUES (?, ?, ?, ?, ?)
  `).run(phone, message, photoUrl, photoData, analysis);
  return r.lastInsertRowid;
}

function getInquiry(id) {
  return db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id);
}

function updateInquiryStatus(id, status) {
  db.prepare("UPDATE inquiries SET status = ? WHERE id = ?").run(status, id);
}

function getPendingInquiries() {
  return db.prepare("SELECT * FROM inquiries WHERE status = 'pending_quote' ORDER BY created_at DESC").all();
}

// ─── Quotes ───────────────────────────────────────────────────────────────────

function createQuote(inquiryId, fields) {
  const total = computeTotal(fields);
  const r = db.prepare(`
    INSERT INTO quotes (
      inquiry_id, load_size, base_price, fuel_surcharge, tire_surcharge,
      appliance_surcharge, mattress_surcharge, electronics_surcharge,
      hazmat_surcharge, other_surcharge, other_surcharge_note, total_price, owner_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    inquiryId,
    fields.load_size || null,
    fields.base_price || 0,
    fields.fuel_surcharge || 0,
    fields.tire_surcharge || 0,
    fields.appliance_surcharge || 0,
    fields.mattress_surcharge || 0,
    fields.electronics_surcharge || 0,
    fields.hazmat_surcharge || 0,
    fields.other_surcharge || 0,
    fields.other_surcharge_note || null,
    total,
    fields.owner_notes || null
  );
  return r.lastInsertRowid;
}

function updateQuote(id, fields) {
  const total = computeTotal(fields);
  db.prepare(`
    UPDATE quotes SET
      load_size = ?, base_price = ?, fuel_surcharge = ?, tire_surcharge = ?,
      appliance_surcharge = ?, mattress_surcharge = ?, electronics_surcharge = ?,
      hazmat_surcharge = ?, other_surcharge = ?, other_surcharge_note = ?,
      total_price = ?, owner_notes = ?
    WHERE id = ?
  `).run(
    fields.load_size || null,
    fields.base_price || 0,
    fields.fuel_surcharge || 0,
    fields.tire_surcharge || 0,
    fields.appliance_surcharge || 0,
    fields.mattress_surcharge || 0,
    fields.electronics_surcharge || 0,
    fields.hazmat_surcharge || 0,
    fields.other_surcharge || 0,
    fields.other_surcharge_note || null,
    total,
    fields.owner_notes || null,
    id
  );
}

function computeTotal(fields) {
  return (
    (parseFloat(fields.base_price) || 0) +
    (parseFloat(fields.fuel_surcharge) || 0) +
    (parseFloat(fields.tire_surcharge) || 0) +
    (parseFloat(fields.appliance_surcharge) || 0) +
    (parseFloat(fields.mattress_surcharge) || 0) +
    (parseFloat(fields.electronics_surcharge) || 0) +
    (parseFloat(fields.hazmat_surcharge) || 0) +
    (parseFloat(fields.other_surcharge) || 0)
  );
}

function approveQuote(id) {
  db.prepare("UPDATE quotes SET status = 'approved' WHERE id = ?").run(id);
}

function rejectQuote(id) {
  db.prepare("UPDATE quotes SET status = 'rejected' WHERE id = ?").run(id);
}

function markQuoteSent(id) {
  db.prepare("UPDATE quotes SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(id);
}

function markQuoteResponse(id, response) {
  db.prepare("UPDATE quotes SET status = ?, customer_response = ?, responded_at = datetime('now') WHERE id = ?")
    .run(response === 'YES' ? 'accepted' : 'declined', response, id);
}

function getPendingReviewQuotes() {
  return db.prepare(`
    SELECT q.*, i.phone, i.message, i.photo_url, i.analysis
    FROM quotes q JOIN inquiries i ON q.inquiry_id = i.id
    WHERE q.status = 'pending_review'
    ORDER BY q.created_at DESC
  `).all();
}

function getQuote(id) {
  return db.prepare(`
    SELECT q.*, i.phone, i.message, i.photo_url, i.analysis
    FROM quotes q JOIN inquiries i ON q.inquiry_id = i.id
    WHERE q.id = ?
  `).get(id);
}

function getQuoteByInquiry(inquiryId) {
  return db.prepare('SELECT * FROM quotes WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1').get(inquiryId);
}

// ─── Customers ────────────────────────────────────────────────────────────────

function createCustomer(fields) {
  const r = db.prepare(`
    INSERT INTO customers (inquiry_id, phone, name, address, city, state, zip, preferred_day, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.inquiry_id || null,
    fields.phone,
    fields.name || null,
    fields.address || null,
    fields.city || 'Logan',
    fields.state || 'UT',
    fields.zip || null,
    fields.preferred_day || null,
    fields.lat || null,
    fields.lng || null
  );
  return r.lastInsertRowid;
}

function updateCustomer(id, fields) {
  db.prepare(`
    UPDATE customers SET name=?, address=?, city=?, state=?, zip=?, preferred_day=?, lat=?, lng=?
    WHERE id=?
  `).run(fields.name, fields.address, fields.city, fields.state, fields.zip, fields.preferred_day, fields.lat, fields.lng, id);
}

function getCustomerByPhone(phone) {
  return db.prepare('SELECT * FROM customers WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phone);
}

function getCustomer(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

function createJob(customerId, quoteId, fields) {
  const r = db.prepare(`
    INSERT INTO jobs (customer_id, quote_id, scheduled_date, estimated_duration_minutes, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    customerId,
    quoteId || null,
    fields.scheduled_date || null,
    fields.estimated_duration_minutes || 60,
    fields.notes || null
  );
  return r.lastInsertRowid;
}

function getJob(id) {
  return db.prepare(`
    SELECT j.*, c.name, c.phone, c.address, c.city, c.state, c.lat, c.lng,
           q.total_price, q.load_size
    FROM jobs j
    JOIN customers c ON j.customer_id = c.id
    LEFT JOIN quotes q ON j.quote_id = q.id
    WHERE j.id = ?
  `).get(id);
}

function getJobsByDate(date) {
  return db.prepare(`
    SELECT j.*, c.name, c.phone, c.address, c.city, c.state, c.lat, c.lng,
           q.total_price, q.load_size
    FROM jobs j
    JOIN customers c ON j.customer_id = c.id
    LEFT JOIN quotes q ON j.quote_id = q.id
    WHERE j.scheduled_date = ? AND j.status != 'cancelled'
    ORDER BY j.scheduled_order ASC, j.id ASC
  `).all(date);
}

function getAllJobs(status) {
  const where = status ? "WHERE j.status = ?" : "";
  const query = `
    SELECT j.*, c.name, c.phone, c.address, c.city, c.state,
           q.total_price, q.load_size
    FROM jobs j
    JOIN customers c ON j.customer_id = c.id
    LEFT JOIN quotes q ON j.quote_id = q.id
    ${where}
    ORDER BY j.scheduled_date ASC, j.scheduled_order ASC
  `;
  return status
    ? db.prepare(query).all(status)
    : db.prepare(query).all();
}

function updateJobCalendarEvent(id, eventId) {
  db.prepare('UPDATE jobs SET calendar_event_id = ? WHERE id = ?').run(eventId, id);
}

function updateJobStatus(id, status) {
  const extra = status === 'completed' ? ", completed_at = datetime('now')" : '';
  db.prepare(`UPDATE jobs SET status = ?${extra} WHERE id = ?`).run(status, id);
}

function updateJobOrder(id, order, driveTime) {
  db.prepare('UPDATE jobs SET scheduled_order = ?, drive_time_from_prev_minutes = ? WHERE id = ?')
    .run(order, driveTime, id);
}

function updateJobDate(id, date) {
  db.prepare('UPDATE jobs SET scheduled_date = ? WHERE id = ?').run(date, id);
}

// ─── Landfill Runs ────────────────────────────────────────────────────────────

function getLandfillRuns(date) {
  return db.prepare('SELECT * FROM landfill_runs WHERE date = ? ORDER BY run_number').all(date);
}

function addLandfillRun(date, runNumber) {
  db.prepare('INSERT OR IGNORE INTO landfill_runs (date, run_number) VALUES (?, ?)').run(date, runNumber);
}

// ─── SMS Log ──────────────────────────────────────────────────────────────────

function logSms(direction, phone, body, mediaUrl, twilioSid) {
  db.prepare(`
    INSERT INTO sms_log (direction, phone, body, media_url, twilio_sid)
    VALUES (?, ?, ?, ?, ?)
  `).run(direction, phone, body, mediaUrl || null, twilioSid || null);
}

// ─── Dashboard Queries ────────────────────────────────────────────────────────

function getDashboardStats() {
  return {
    pending_review: db.prepare("SELECT COUNT(*) as n FROM quotes WHERE status='pending_review'").get().n,
    pending_quote: db.prepare("SELECT COUNT(*) as n FROM inquiries WHERE status='pending_quote'").get().n,
    scheduled_today: db.prepare("SELECT COUNT(*) as n FROM jobs WHERE scheduled_date=date('now') AND status='scheduled'").get().n,
    total_jobs_month: db.prepare("SELECT COUNT(*) as n FROM jobs WHERE strftime('%Y-%m', scheduled_date)=strftime('%Y-%m','now') AND status!='cancelled'").get().n,
    revenue_month: db.prepare("SELECT COALESCE(SUM(q.total_price),0) as n FROM jobs j JOIN quotes q ON j.quote_id=q.id WHERE strftime('%Y-%m', j.scheduled_date)=strftime('%Y-%m','now') AND j.status='completed'").get().n,
  };
}

module.exports = {
  db,
  getConversation, upsertConversation,
  createInquiry, getInquiry, updateInquiryStatus, getPendingInquiries,
  createQuote, updateQuote, approveQuote, rejectQuote, markQuoteSent,
  markQuoteResponse, getPendingReviewQuotes, getQuote, getQuoteByInquiry,
  createCustomer, updateCustomer, getCustomerByPhone, getCustomer,
  createJob, getJob, getJobsByDate, getAllJobs, updateJobCalendarEvent,
  updateJobStatus, updateJobOrder, updateJobDate,
  getLandfillRuns, addLandfillRun,
  logSms,
  getDashboardStats,
};
