const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PRICING = {
  quarter: parseFloat(process.env.BASE_QUARTER_LOAD) || 75,
  half: parseFloat(process.env.BASE_HALF_LOAD) || 125,
  three_quarter: parseFloat(process.env.BASE_THREE_QUARTER_LOAD) || 175,
  full: parseFloat(process.env.BASE_FULL_LOAD) || 225,
};

const SURCHARGES = {
  tire: parseFloat(process.env.TIRE_SURCHARGE) || 15,
  appliance: parseFloat(process.env.APPLIANCE_SURCHARGE) || 25,
  mattress: parseFloat(process.env.MATTRESS_SURCHARGE) || 20,
  electronics: parseFloat(process.env.ELECTRONICS_SURCHARGE) || 20,
  hazmat: parseFloat(process.env.PAINT_HAZMAT_SURCHARGE) || 30,
};

async function downloadImageAsBase64(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
    timeout: 15000,
  });
  const contentType = response.headers['content-type'] || 'image/jpeg';
  const base64 = Buffer.from(response.data).toString('base64');
  return { base64, contentType: contentType.split(';')[0] };
}

async function analyzePhoto(photoUrl) {
  let imageContent;

  try {
    const { base64, contentType } = await downloadImageAsBase64(photoUrl);
    imageContent = {
      type: 'image',
      source: { type: 'base64', media_type: contentType, data: base64 },
    };
  } catch (err) {
    console.error('Image download failed, using URL:', err.message);
    imageContent = {
      type: 'image',
      source: { type: 'url', url: photoUrl },
    };
  }

  const systemPrompt = `You are an expert estimator for a hauling and junk removal company in Cache Valley, Utah called "Gone by Monday."
Your job is to analyze customer photos of junk/debris and provide structured pricing estimates.

Pricing reference:
- Quarter load: $${PRICING.quarter}
- Half load: $${PRICING.half}
- Three-quarter load: $${PRICING.three_quarter}
- Full load: $${PRICING.full}

Special item surcharges (per item):
- Tire: $${SURCHARGES.tire} each
- Appliance (fridge, washer, dryer, dishwasher, AC unit): $${SURCHARGES.appliance} each
- Mattress/box spring: $${SURCHARGES.mattress} each
- Electronics (TV, computer, monitor): $${SURCHARGES.electronics} each
- Hazmat/paint/chemicals: $${SURCHARGES.hazmat} per container

Always respond with ONLY valid JSON in this exact structure, no other text:
{
  "load_size": "quarter|half|three_quarter|full",
  "load_percentage": 25,
  "base_price": 75,
  "materials": ["furniture", "yard waste", "construction debris"],
  "special_items": {
    "tires": 0,
    "appliances": 0,
    "mattresses": 0,
    "electronics": 0,
    "hazmat": 0
  },
  "surcharge_total": 0,
  "estimated_total": 75,
  "estimated_duration_minutes": 60,
  "needs_landfill_run": true,
  "difficulty": "easy|medium|hard",
  "notes": "Brief description of what you see and any special considerations",
  "confidence": "high|medium|low"
}`;

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          imageContent,
          {
            type: 'text',
            text: 'Please analyze this junk removal job photo and provide your pricing estimate as JSON.',
          },
        ],
      },
    ],
  });

  const raw = response.content[0].text.trim();

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);

    // Recalculate surcharge total from special items
    parsed.surcharge_total =
      (parsed.special_items.tires || 0) * SURCHARGES.tire +
      (parsed.special_items.appliances || 0) * SURCHARGES.appliance +
      (parsed.special_items.mattresses || 0) * SURCHARGES.mattress +
      (parsed.special_items.electronics || 0) * SURCHARGES.electronics +
      (parsed.special_items.hazmat || 0) * SURCHARGES.hazmat;

    parsed.estimated_total = (parsed.base_price || 0) + parsed.surcharge_total;

    return parsed;
  } catch {
    return {
      load_size: 'half',
      load_percentage: 50,
      base_price: PRICING.half,
      materials: ['mixed debris'],
      special_items: { tires: 0, appliances: 0, mattresses: 0, electronics: 0, hazmat: 0 },
      surcharge_total: 0,
      estimated_total: PRICING.half,
      estimated_duration_minutes: 60,
      needs_landfill_run: true,
      difficulty: 'medium',
      notes: raw.slice(0, 500),
      confidence: 'low',
    };
  }
}

module.exports = { analyzePhoto };
