const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const db = require('../database/db');
const { analyzePhoto } = require('../services/claude');
const {
  sendSms,
  buildAddressRequestMessage,
} = require('../services/twilio');
const { geocodeAddress, detectZone, calculateMileageSurcharge } = require('../services/maps');
const { createJobEvent } = require('../services/googleCalendar');
const { checkAndNotifyCapacity, calculateDayCapacity } = require('../services/scheduler');

// Validate Twilio signature in production
function validateRequest(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const sig = req.headers['x-twilio-signature'];
  const url = `${process.env.BASE_URL}/webhook/sms`;
  const valid = twilio.validateRequest(authToken, sig, url, req.body);
  if (!valid) return res.status(403).send('Forbidden');
  next();
}

router.post('/sms', validateRequest, async (req, res) => {
  // Always respond fast to avoid Twilio timeout — ack immediately
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = numMedia > 0 ? req.body.MediaUrl0 : null;
  const twilioSid = req.body.MessageSid;

  db.logSms('inbound', from, body, mediaUrl, twilioSid);
  console.log(`SMS from ${from}: "${body}" media:${numMedia}`);

  try {
    await handleConversation(from, body, mediaUrl);
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

async function handleConversation(phone, body, mediaUrl) {
  let conv = db.getConversation(phone);
  const state = conv ? conv.state : 'new';
  const data = conv ? conv.data : {};

  const bodyLower = body.toLowerCase().trim();

  // ── Global shortcuts ──
  if (bodyLower === 'stop' || bodyLower === 'unsubscribe') {
    return; // Twilio handles opt-out
  }

  // ── CLEANOUT keyword detection ──
  if (bodyLower === 'cleanout' || bodyLower.includes('full service') || bodyLower.includes('full-service')) {
    db.createCleanoutRequest({
      customer_phone: phone,
      description: body,
    });
    const ownerPhone = process.env.OWNER_PHONE;
    if (ownerPhone) {
      await sendSms(ownerPhone,
        `🏠 CLEANOUT request from ${phone}!\n\nMessage: "${body}"\n\nReview in dashboard.`
      ).catch(() => {});
    }
    await sendSms(phone,
      `Got it! We received your full-service cleanout request.\n\nOur team will review and reach out within 24 hours to discuss the job and provide a quote. Questions? Call/text ${process.env.BUSINESS_PHONE || ''}.`
    );
    db.upsertConversation(phone, 'new', {});
    return;
  }

  switch (state) {
    case 'new':
    case 'awaiting_photo': {
      if (mediaUrl) {
        await handlePhotoReceived(phone, body, mediaUrl, data);
      } else {
        // No photo yet — prompt for one
        db.upsertConversation(phone, 'awaiting_photo', data);
        await sendSms(phone,
          `Hi! Thanks for reaching out to Gone by Monday — Cache Valley's hauling crew. 📸\n\nPlease send a photo of the items you need removed so we can give you an accurate quote!`
        );
      }
      break;
    }

    case 'quote_sent': {
      if (bodyLower === 'yes' || bodyLower === 'y') {
        await handleQuoteAccepted(phone, data);
      } else if (bodyLower === 'no' || bodyLower === 'n') {
        await handleQuoteDeclined(phone, data);
      } else if (mediaUrl) {
        // Another photo — analyze and update quote
        await handlePhotoReceived(phone, body, mediaUrl, data);
      } else {
        await sendSms(phone, `Reply YES to accept the quote or NO to decline. Need a new quote? Send another photo!`);
      }
      break;
    }

    case 'awaiting_address': {
      if (body.length > 5) {
        await handleAddressReceived(phone, body, data);
      } else {
        await sendSms(phone, buildAddressRequestMessage());
      }
      break;
    }

    case 'confirmed': {
      // Conversation complete — handle follow-ups
      if (mediaUrl) {
        // New inquiry
        await handlePhotoReceived(phone, body, mediaUrl, {});
      } else {
        await sendSms(phone,
          `Your job is already confirmed! 🎉 Questions? Call/text ${process.env.BUSINESS_PHONE || ''}.\n\nNeed to add another pickup? Send a photo!`
        );
      }
      break;
    }

    default: {
      db.upsertConversation(phone, 'new', {});
      if (mediaUrl) {
        await handlePhotoReceived(phone, body, mediaUrl, {});
      } else {
        await sendSms(phone, `Hi! Send us a photo of your items and we'll get you a quote right away! 📸`);
      }
    }
  }
}

async function handlePhotoReceived(phone, body, mediaUrl, existingData) {
  await sendSms(phone, `Thanks! We received your photo and are generating a quote now. We'll text you shortly! 🔍`);

  let analysis = null;
  let analysisStr = null;

  try {
    analysis = await analyzePhoto(mediaUrl);
    analysisStr = JSON.stringify(analysis);
    console.log(`Analysis for ${phone}:`, analysis);
  } catch (err) {
    console.error('Claude analysis error:', err.message);
    analysisStr = JSON.stringify({ error: err.message, notes: 'Manual review required' });
  }

  const inquiryId = db.createInquiry(phone, body, mediaUrl, null, analysisStr);

  // Auto-create a draft quote from AI analysis if confident
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
      owner_notes: 'Low-confidence AI analysis — please review photo and set price manually.',
    });
  }

  db.upsertConversation(phone, 'awaiting_approval', {
    ...existingData,
    inquiry_id: inquiryId,
    quote_id: quoteId,
  });

  // Notify owner
  const ownerPhone = process.env.OWNER_PHONE;
  if (ownerPhone) {
    const dashUrl = process.env.BASE_URL ? `${process.env.BASE_URL}/quotes.html` : 'your dashboard';
    await sendSms(ownerPhone,
      `📲 New quote request from ${phone}!\n\nAI estimate: ${analysis ? '$' + analysis.estimated_total : 'needs review'}\n\nReview & approve at: ${dashUrl}`
    ).catch(e => console.error('Owner notify error:', e.message));
  }
}

async function handleQuoteAccepted(phone, data) {
  const quoteId = data.quote_id;
  if (quoteId) {
    db.markQuoteResponse(quoteId, 'YES');
  }
  db.upsertConversation(phone, 'awaiting_address', data);
  await sendSms(phone, buildAddressRequestMessage());
}

async function handleQuoteDeclined(phone, data) {
  const quoteId = data.quote_id;
  if (quoteId) {
    db.markQuoteResponse(quoteId, 'NO');
    db.rejectQuote(quoteId);
  }
  if (data.inquiry_id) {
    db.updateInquiryStatus(data.inquiry_id, 'declined');
  }
  db.upsertConversation(phone, 'new', {});
  await sendSms(phone,
    `No problem! We appreciate you reaching out. If you change your mind or have other items, just send another photo anytime. 👍`
  );
}

async function handleAddressReceived(phone, address, data) {
  const fullAddress = `${address}, Cache Valley, UT`;
  let geo = null;
  try { geo = await geocodeAddress(fullAddress); } catch {}

  const zone = geo ? detectZone(geo.formatted || address) : 2;
  const { miles, surcharge } = await calculateMileageSurcharge(fullAddress).catch(() => ({ miles: 0, surcharge: 0 }));

  // Find best day for this zone this week
  const scheduledDate = await findBestZoneDay(zone);
  const timeWindow = 'morning'; // default; refined by optimizer later

  const customerId = db.createCustomer({
    inquiry_id: data.inquiry_id || null,
    phone,
    address,
    city: geo?.formatted?.split(',')[1]?.trim() || '',
    state: 'UT',
    lat: geo?.lat,
    lng: geo?.lng,
  });

  // Update quote with mileage surcharge if applicable
  let totalPrice = data.quote_total || 0;
  if (data.quote_id && surcharge > 0) {
    const quote = db.getQuote(data.quote_id);
    if (quote) {
      totalPrice = quote.total_price + surcharge;
      // Mileage is silently folded into other_surcharge
      db.updateQuote(data.quote_id, { ...quote, other_surcharge: (quote.other_surcharge || 0) + surcharge, other_surcharge_note: 'mileage' });
    }
  } else if (data.quote_id) {
    const quote = db.getQuote(data.quote_id);
    if (quote) totalPrice = quote.total_price;
  }

  const depositAmount = Math.ceil(totalPrice / 2 / 5) * 5; // round up to nearest $5
  const balanceAmount = Math.max(0, totalPrice - depositAmount);

  const jobId = db.createJob(customerId, data.quote_id || null, {
    scheduled_date: scheduledDate,
    estimated_duration_minutes: data.estimated_duration_minutes || 60,
    zone,
    service_type: 'curb_pickup',
    time_window: timeWindow,
    mileage_miles: miles,
    mileage_surcharge: surcharge,
    deposit_amount: depositAmount,
    balance_amount: balanceAmount,
  });

  // Create deposit payment link
  let depositLink = null;
  try {
    const { createPaymentLink } = require('../services/stripe');
    depositLink = await createPaymentLink(
      depositAmount,
      'Gone by Monday — Pickup Deposit',
      { job_id: String(jobId), payment_type: 'deposit' }
    );
  } catch (err) {
    console.error('Stripe deposit link error:', err.message);
  }

  // Calendar event
  const job = db.getJob(jobId);
  const customer = db.getCustomer(customerId);
  if (job && customer) {
    try {
      const eventId = await createJobEvent(job, customer);
      if (eventId) db.updateJobCalendarEvent(jobId, eventId);
    } catch (err) {
      console.error('Calendar error:', err.message);
    }
  }

  // Check capacity
  if (scheduledDate) {
    await checkAndNotifyCapacity(scheduledDate).catch(() => {});
  }

  db.upsertConversation(phone, 'confirmed', { ...data, customer_id: customerId, job_id: jobId });

  const dateDisplay = scheduledDate
    ? new Date(scheduledDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'next available date';

  const windowText = timeWindow === 'morning' ? '8am–noon' : 'noon–4pm';

  let msg = `Thanks for confirming! Your pickup is scheduled for ${dateDisplay} between ${windowText}. We'll text you when we're on our way.`;
  if (depositLink) {
    msg += `\n\nYour deposit ($${depositAmount}): ${depositLink}`;
  }
  msg += `\n\n— Gone by Monday`;

  await sendSms(phone, msg);

  // Notify owner
  const ownerPhone = process.env.OWNER_PHONE;
  if (ownerPhone) {
    await sendSms(ownerPhone,
      `✅ New job confirmed!\n📍 ${address}\n📅 ${dateDisplay} (${windowText})\n🗺 Zone ${zone}\n📞 ${phone}\n💰 Deposit: $${depositAmount} ${depositLink ? '(link sent)' : '(no link)'}`
    ).catch(() => {});
  }
}

async function findBestZoneDay(zone) {
  const tz = process.env.BUSINESS_TIMEZONE || 'America/Denver';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const todayDate = new Date(today + 'T12:00:00');

  // Look at next 10 weekdays
  const candidates = [];
  let d = new Date(todayDate);
  d.setDate(d.getDate() + 1); // start tomorrow

  while (candidates.length < 10) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) { // Mon–Fri
      candidates.push(d.toLocaleDateString('en-CA'));
    }
    d.setDate(d.getDate() + 1);
  }

  // Find a day that already has jobs in this zone and has capacity
  for (const date of candidates) {
    const cap = calculateDayCapacity(date);
    if (!cap.atCapacity) {
      const zoneJobs = cap.jobs.filter(j => (j.zone || 2) === zone);
      if (zoneJobs.length > 0) return date; // existing zone day
    }
  }

  // No existing zone day — return first available empty weekday
  for (const date of candidates) {
    const cap = calculateDayCapacity(date);
    if (!cap.atCapacity && cap.jobCount === 0) return date;
  }

  // All days have jobs — pick least loaded
  const caps = candidates.map(date => ({ date, cap: calculateDayCapacity(date) }));
  const sorted = caps.filter(c => !c.cap.atCapacity).sort((a, b) => a.cap.jobCount - b.cap.jobCount);
  return sorted[0]?.date || candidates[0];
}

// ── Status callback (delivery receipts) ──────────────────────────────────────
router.post('/status', (req, res) => {
  res.sendStatus(204);
  const { MessageSid, MessageStatus, To } = req.body;
  console.log(`SMS status ${MessageSid} → ${To}: ${MessageStatus}`);
});

module.exports = router;
