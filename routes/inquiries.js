const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const { analyzePhoto } = require('../services/claude');
const { emailOwnerNewRequest } = require('../services/email');
const { geocodeAddress, detectZone } = require('../services/maps');

// Store uploads in /tmp (ephemeral on Render — fine for short-lived analysis)
const upload = multer({
  dest: '/tmp/gbm-uploads/',
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|jpg|png|gif|webp|heic)/.test(file.mimetype);
    cb(ok ? null : new Error('Only images allowed'), ok);
  },
});

// POST /api/inquiries — web form photo submission
router.post('/', upload.single('photo'), async (req, res) => {
  const { name, phone, email, address, description } = req.body;

  if (!phone && !email) {
    return res.status(400).json({ error: 'Phone or email required' });
  }

  let photoUrl = null;
  let analysis = null;
  let analysisStr = null;

  // If a photo was uploaded, analyze it with Claude AI
  if (req.file) {
    try {
      // Read file as base64 for Claude
      const buf = fs.readFileSync(req.file.path);
      const base64 = buf.toString('base64');
      const mimeType = req.file.mimetype || 'image/jpeg';

      analysis = await analyzePhoto(null, { base64, mimeType });
      analysisStr = JSON.stringify(analysis);
    } catch (err) {
      console.error('Photo analysis error:', err.message);
      analysisStr = JSON.stringify({ error: err.message, notes: 'Manual review required' });
    } finally {
      // Clean up temp file
      fs.unlink(req.file.path, () => {});
    }
  }

  // Geocode address and detect zone
  let geo = null;
  let zone = 2;
  if (address) {
    try {
      geo = await geocodeAddress(address + ', Cache Valley, UT');
      if (geo) zone = detectZone(geo.formatted || address);
    } catch {}
  }

  // Create inquiry record
  const inquiryId = db.createInquiry(
    phone || email,
    description || null,
    photoUrl,
    null,
    analysisStr
  );

  // Create customer record
  const customerId = db.createCustomer({
    inquiry_id: inquiryId,
    phone: phone || '',
    name: name || null,
    email: email || null,
    address: address || null,
    city: geo?.formatted?.split(',')[1]?.trim() || 'Logan',
    state: 'UT',
    lat: geo?.lat,
    lng: geo?.lng,
  });

  // Auto-create a draft quote if AI analysis is confident
  let quoteId = null;
  if (analysis && analysis.confidence !== 'low') {
    const SURCHARGES = {
      tire_surcharge: (analysis.special_items?.tires || 0) * (parseFloat(process.env.TIRE_SURCHARGE) || 15),
      appliance_surcharge: (analysis.special_items?.appliances || 0) * (parseFloat(process.env.APPLIANCE_SURCHARGE) || 25),
      mattress_surcharge: (analysis.special_items?.mattresses || 0) * (parseFloat(process.env.MATTRESS_SURCHARGE) || 20),
      electronics_surcharge: (analysis.special_items?.electronics || 0) * (parseFloat(process.env.ELECTRONICS_SURCHARGE) || 20),
      hazmat_surcharge: (analysis.special_items?.hazmat || 0) * (parseFloat(process.env.PAINT_HAZMAT_SURCHARGE) || 30),
    };
    quoteId = db.createQuote(inquiryId, {
      load_size: analysis.load_size,
      base_price: analysis.base_price || 0,
      ...SURCHARGES,
      owner_notes: analysis.notes,
    });
  } else {
    quoteId = db.createQuote(inquiryId, {
      load_size: 'half',
      base_price: 0,
      owner_notes: 'Review photo and set price manually.',
    });
  }

  // Email owner
  try {
    await emailOwnerNewRequest({
      inquiry: { id: inquiryId, photo_url: photoUrl, message: description, phone: phone || email },
      quote: quoteId ? db.getQuote(quoteId) : null,
      analysis,
      customer: { name, phone, email: email || null, address },
    });
  } catch (err) {
    console.error('Owner email error:', err.message);
  }

  res.status(201).json({ success: true, inquiry_id: inquiryId, quote_id: quoteId });
});

// GET /api/inquiries/:id/quote — public endpoint used by approve.html
router.get('/:id/quote', (req, res) => {
  const quote = db.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  // Only expose safe fields — no internal notes that contain pricing strategy
  res.json({
    id: quote.id,
    load_size: quote.load_size,
    base_price: quote.base_price,
    total_price: quote.total_price,
    status: quote.status,
    deposit_amount: quote.deposit_amount || Math.ceil(quote.total_price / 2 / 5) * 5,
    stripe_checkout_url: quote.stripe_checkout_url || null,
    owner_notes: quote.owner_notes,
  });
});

module.exports = router;
