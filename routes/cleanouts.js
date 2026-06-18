const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { detectZone, geocodeAddress } = require('../services/maps');
const { sendSms } = require('../services/twilio');

// GET /api/cleanouts
router.get('/', (req, res) => {
  const { status } = req.query;
  res.json(db.getCleanoutRequests(status || null));
});

// GET /api/cleanouts/:id
router.get('/:id', (req, res) => {
  const req_ = db.getCleanoutRequest(req.params.id);
  if (!req_) return res.status(404).json({ error: 'Not found' });
  res.json({ ...req_, photos: JSON.parse(req_.photos || '[]') });
});

// POST /api/cleanouts — from web form
router.post('/', async (req, res) => {
  const { customer_phone, customer_name, address, description, preferred_week } = req.body;
  if (!customer_phone || !address) {
    return res.status(400).json({ error: 'customer_phone and address required' });
  }

  let zone = 2;
  try {
    const geo = await geocodeAddress(address + ', Cache Valley, UT');
    if (geo) zone = detectZone(geo.formatted || address);
  } catch {}

  const id = db.createCleanoutRequest({
    customer_phone,
    customer_name: customer_name || null,
    address,
    zone,
    description: description || null,
    preferred_week: preferred_week || null,
  });

  // Notify owner
  const ownerPhone = process.env.OWNER_PHONE;
  if (ownerPhone) {
    await sendSms(ownerPhone,
      `🏠 Full-service cleanout request!\n📞 ${customer_phone}\n${customer_name ? '👤 ' + customer_name + '\n' : ''}📍 ${address}\n${description ? '📝 ' + description.slice(0, 100) + '\n' : ''}Zone ${zone} | Review in dashboard`
    ).catch(e => console.error('Cleanout notify error:', e.message));
  }

  res.status(201).json({ id, success: true });
});

// PUT /api/cleanouts/:id/quote — owner sets quote price
router.put('/:id/quote', async (req, res) => {
  const { quoted_price, deposit_amount, estimated_hours } = req.body;
  if (!quoted_price) return res.status(400).json({ error: 'quoted_price required' });

  db.updateCleanoutStatus(req.params.id, 'quoted', {
    quoted_price,
    deposit_amount: deposit_amount || Math.round(quoted_price / 2),
    estimated_hours: estimated_hours || null,
  });
  res.json({ success: true });
});

// POST /api/cleanouts/:id/complete
router.post('/:id/complete', (req, res) => {
  db.updateCleanoutStatus(req.params.id, 'completed', {});
  res.json({ success: true });
});

module.exports = router;
