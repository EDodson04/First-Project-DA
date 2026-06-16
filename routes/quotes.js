const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { sendSms, buildQuoteMessage } = require('../services/twilio');

// GET /api/quotes — all pending review
router.get('/', (req, res) => {
  const status = req.query.status;
  let quotes;
  if (status) {
    quotes = db.db.prepare(`
      SELECT q.*, i.phone, i.message, i.photo_url, i.analysis
      FROM quotes q JOIN inquiries i ON q.inquiry_id = i.id
      WHERE q.status = ?
      ORDER BY q.created_at DESC
    `).all(status);
  } else {
    quotes = db.db.prepare(`
      SELECT q.*, i.phone, i.message, i.photo_url, i.analysis
      FROM quotes q JOIN inquiries i ON q.inquiry_id = i.id
      ORDER BY q.created_at DESC
      LIMIT 100
    `).all();
  }
  res.json(quotes.map(q => ({ ...q, analysis: tryParse(q.analysis) })));
});

// GET /api/quotes/pending — shortcut
router.get('/pending', (req, res) => {
  const quotes = db.getPendingReviewQuotes();
  res.json(quotes.map(q => ({ ...q, analysis: tryParse(q.analysis) })));
});

// GET /api/quotes/:id
router.get('/:id', (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  res.json({ ...quote, analysis: tryParse(quote.analysis) });
});

// PUT /api/quotes/:id — update fields
router.put('/:id', (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });

  const fields = {
    load_size: req.body.load_size ?? quote.load_size,
    base_price: req.body.base_price ?? quote.base_price,
    fuel_surcharge: req.body.fuel_surcharge ?? quote.fuel_surcharge,
    tire_surcharge: req.body.tire_surcharge ?? quote.tire_surcharge,
    appliance_surcharge: req.body.appliance_surcharge ?? quote.appliance_surcharge,
    mattress_surcharge: req.body.mattress_surcharge ?? quote.mattress_surcharge,
    electronics_surcharge: req.body.electronics_surcharge ?? quote.electronics_surcharge,
    hazmat_surcharge: req.body.hazmat_surcharge ?? quote.hazmat_surcharge,
    other_surcharge: req.body.other_surcharge ?? quote.other_surcharge,
    other_surcharge_note: req.body.other_surcharge_note ?? quote.other_surcharge_note,
    owner_notes: req.body.owner_notes ?? quote.owner_notes,
  };

  db.updateQuote(req.params.id, fields);
  res.json(db.getQuote(req.params.id));
});

// POST /api/quotes/:id/approve — approve and send quote to customer
router.post('/:id/approve', async (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  if (quote.status !== 'pending_review') {
    return res.status(400).json({ error: `Quote is already ${quote.status}` });
  }

  db.approveQuote(req.params.id);

  // Send quote to customer
  try {
    const msg = buildQuoteMessage(quote, process.env.BUSINESS_NAME);
    await sendSms(quote.phone, msg);
    db.markQuoteSent(req.params.id);

    // Update conversation state
    const conv = db.getConversation(quote.phone);
    const convData = conv ? conv.data : {};
    db.upsertConversation(quote.phone, 'quote_sent', { ...convData, quote_id: parseInt(req.params.id) });

    res.json({ success: true, message: 'Quote approved and sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send SMS: ' + err.message });
  }
});

// POST /api/quotes/:id/reject
router.post('/:id/reject', (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });

  db.rejectQuote(req.params.id);
  if (quote.inquiry_id) db.updateInquiryStatus(quote.inquiry_id, 'declined');

  res.json({ success: true });
});

// POST /api/quotes/:id/resend — resend an already-sent quote
router.post('/:id/resend', async (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });

  try {
    const msg = buildQuoteMessage(quote, process.env.BUSINESS_NAME);
    await sendSms(quote.phone, msg);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function tryParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

module.exports = router;
