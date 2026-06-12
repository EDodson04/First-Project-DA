const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const db = require('../database/db');
const { analyzePhoto } = require('../services/claude');
const {
  sendSms,
  buildQuoteMessage,
  buildAddressRequestMessage,
  buildDayRequestMessage,
  buildConfirmationMessage,
} = require('../services/twilio');
const { geocodeAddress } = require('../services/maps');
const { createJobEvent } = require('../services/googleCalendar');
const { checkAndNotifyCapacity } = require('../services/scheduler');

const VALID_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

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

    case 'awaiting_day': {
      const dayMatch = VALID_DAYS.find(d => bodyLower.startsWith(d));
      if (dayMatch) {
        await handleDayReceived(phone, dayMatch, data);
      } else {
        await sendSms(phone, `Please reply with a day: Monday, Tuesday, Wednesday, Thursday, Friday, or Saturday.`);
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
  // Geocode the address
  const fullAddress = `${address}, Cache Valley, UT`;
  let geo = null;
  try {
    geo = await geocodeAddress(fullAddress);
  } catch (err) {
    console.error('Geocode error:', err.message);
  }

  const customerData = {
    ...data,
    raw_address: address,
    lat: geo?.lat || null,
    lng: geo?.lng || null,
    formatted_address: geo?.formatted || address,
  };

  db.upsertConversation(phone, 'awaiting_day', customerData);
  await sendSms(phone, buildDayRequestMessage());
}

async function handleDayReceived(phone, day, data) {
  const capitalDay = day.charAt(0).toUpperCase() + day.slice(1);

  // Create customer record
  const customerId = db.createCustomer({
    inquiry_id: data.inquiry_id || null,
    phone,
    address: data.raw_address || data.formatted_address || 'Unknown',
    city: 'Logan',
    state: 'UT',
    preferred_day: capitalDay,
    lat: data.lat,
    lng: data.lng,
  });

  // Create job record
  const scheduledDate = getNextOccurrenceOfDay(capitalDay);
  const jobId = db.createJob(customerId, data.quote_id || null, {
    scheduled_date: scheduledDate,
    estimated_duration_minutes: 60,
  });

  // Create Google Calendar event
  const job = db.getJob(jobId);
  const customer = db.getCustomer(customerId);
  if (job && customer) {
    try {
      const eventId = await createJobEvent({ ...job, load_size: data.load_size }, customer);
      if (eventId) db.updateJobCalendarEvent(jobId, eventId);
    } catch (err) {
      console.error('Calendar event error:', err.message);
    }
  }

  // Check capacity and notify if needed
  if (scheduledDate) {
    await checkAndNotifyCapacity(scheduledDate).catch(e => console.error(e.message));
  }

  db.upsertConversation(phone, 'confirmed', { ...data, customer_id: customerId, job_id: jobId });

  const formatted = scheduledDate
    ? new Date(scheduledDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : capitalDay;

  await sendSms(phone, buildConfirmationMessage(null, formatted, process.env.BUSINESS_PHONE));

  // Notify owner of new confirmed job
  const ownerPhone = process.env.OWNER_PHONE;
  if (ownerPhone) {
    await sendSms(ownerPhone,
      `✅ New job confirmed!\n📍 ${data.raw_address || 'Address TBD'}\n📅 ${formatted}\n📞 ${phone}`
    ).catch(e => console.error(e.message));
  }
}

function getNextOccurrenceOfDay(dayName) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const target = days.indexOf(dayName);
  if (target === -1) return null;
  const now = new Date();
  const tz = process.env.BUSINESS_TIMEZONE || 'America/Denver';
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  const today = new Date(todayStr + 'T12:00:00');
  const current = today.getDay();
  let diff = target - current;
  if (diff <= 0) diff += 7;
  const next = new Date(today);
  next.setDate(today.getDate() + diff);
  return next.toLocaleDateString('en-CA');
}

// ── Status callback (delivery receipts) ──────────────────────────────────────
router.post('/status', (req, res) => {
  res.sendStatus(204);
  const { MessageSid, MessageStatus, To } = req.body;
  console.log(`SMS status ${MessageSid} → ${To}: ${MessageStatus}`);
});

module.exports = router;
