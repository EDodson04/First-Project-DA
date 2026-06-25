const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Light materials: furniture, yard waste, general debris
const PRICING_LIGHT = {
  quarter:       parseFloat(process.env.BASE_QUARTER_LOAD)        || 100,
  half:          parseFloat(process.env.BASE_HALF_LOAD)           || 200,
  three_quarter: parseFloat(process.env.BASE_THREE_QUARTER_LOAD)  || 300,
  full:          parseFloat(process.env.BASE_FULL_LOAD)           || 400,
};

// Heavy materials: concrete, brick, dirt, rock, tile, gravel
const PRICING_HEAVY = {
  quarter:       parseFloat(process.env.HEAVY_QUARTER_LOAD)       || 150,
  half:          parseFloat(process.env.HEAVY_HALF_LOAD)          || 275,
  three_quarter: parseFloat(process.env.HEAVY_THREE_QUARTER_LOAD) || 375,
  full:          parseFloat(process.env.HEAVY_FULL_LOAD)          || 450,
};

const SURCHARGES = {
  tire:        parseFloat(process.env.TIRE_SURCHARGE)        || 15,
  appliance:   parseFloat(process.env.APPLIANCE_SURCHARGE)   || 25,
  mattress:    parseFloat(process.env.MATTRESS_SURCHARGE)    || 20,
  electronics: parseFloat(process.env.ELECTRONICS_SURCHARGE) || 20,
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

// photoUrl: Twilio MMS URL (fetched with basic auth)
// preloaded: { base64, mimeType } for web form uploads already in memory
async function analyzePhoto(photoUrl, preloaded = null) {
  let imageContent;

  if (preloaded?.base64) {
    imageContent = {
      type: 'image',
      source: { type: 'base64', media_type: preloaded.mimeType || 'image/jpeg', data: preloaded.base64 },
    };
  } else {
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
  }

  const systemPrompt = `You are an expert estimator for a hauling and junk removal company in Cache Valley, Utah called "Gone by Monday."
Your job is to analyze customer photos of junk/debris and provide structured pricing estimates.

MATERIAL WEIGHT CLASSIFICATION:
- "light": furniture, yard waste, general household junk, wood, drywall, carpet, general debris
- "heavy": concrete, brick, dirt, rock, tile, gravel, asphalt, sand (significantly heavier per cubic foot)
Set material_weight to "heavy" only if the majority of the load is heavy dense materials.

PRICING — Light materials:
- Quarter load: $${PRICING_LIGHT.quarter}
- Half load: $${PRICING_LIGHT.half}
- Three-quarter load: $${PRICING_LIGHT.three_quarter}
- Full load: $${PRICING_LIGHT.full}

PRICING — Heavy materials (concrete, dirt, rock, etc.):
- Quarter load: $${PRICING_HEAVY.quarter}
- Half load: $${PRICING_HEAVY.half}
- Three-quarter load: $${PRICING_HEAVY.three_quarter}
- Full load: $${PRICING_HEAVY.full}

NEVER quote a base_price below the minimum for the load size and weight category above.

Special item surcharges (per item, added on top of base price):
- Tire: $${SURCHARGES.tire} each
- Appliance (fridge, washer, dryer, dishwasher, AC unit): $${SURCHARGES.appliance} each
- Mattress/box spring: $${SURCHARGES.mattress} each
- Electronics (TV, computer, monitor): $${SURCHARGES.electronics} each

HAZARDOUS MATERIALS (INTERNAL FLAG — NOT FOR CUSTOMER):
If you see paint cans, chemicals, solvents, propane tanks, motor oil, batteries, or other hazmat:
- Quote the load normally based on volume — do NOT mention hazmat in the "notes" field
- Set hazmat_count to the number of hazmat items/containers visible
- Set hazmat_note to a brief private description for the owner only (e.g. "3 paint cans, 1 chemical jug")
- This flag is shown only in the owner dashboard — the customer never sees it

Always respond with ONLY valid JSON in this exact structure, no other text:
{
  "load_size": "quarter|half|three_quarter|full",
  "load_percentage": 25,
  "material_weight": "light|heavy",
  "base_price": ${PRICING_LIGHT.quarter},
  "materials": ["furniture", "yard waste", "construction debris"],
  "special_items": {
    "tires": 0,
    "appliances": 0,
    "mattresses": 0,
    "electronics": 0
  },
  "hazmat_count": 0,
  "hazmat_note": "",
  "surcharge_total": 0,
  "estimated_total": ${PRICING_LIGHT.quarter},
  "estimated_duration_minutes": 60,
  "needs_landfill_run": true,
  "difficulty": "easy|medium|hard",
  "notes": "Brief description of what you see — do NOT mention hazmat here",
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

    // Enforce minimum base price based on load size and weight
    const pricingTable = parsed.material_weight === 'heavy' ? PRICING_HEAVY : PRICING_LIGHT;
    const minPrice = pricingTable[parsed.load_size] || pricingTable.quarter;
    if ((parsed.base_price || 0) < minPrice) parsed.base_price = minPrice;

    // Recalculate surcharge total (no hazmat surcharge — owner decides after reviewing the flag)
    parsed.surcharge_total =
      (parsed.special_items.tires || 0) * SURCHARGES.tire +
      (parsed.special_items.appliances || 0) * SURCHARGES.appliance +
      (parsed.special_items.mattresses || 0) * SURCHARGES.mattress +
      (parsed.special_items.electronics || 0) * SURCHARGES.electronics;

    parsed.estimated_total = parsed.base_price + parsed.surcharge_total;

    return parsed;
  } catch {
    return {
      load_size: 'half',
      load_percentage: 50,
      material_weight: 'light',
      base_price: PRICING_LIGHT.half,
      materials: ['mixed debris'],
      special_items: { tires: 0, appliances: 0, mattresses: 0, electronics: 0 },
      hazmat_count: 0,
      hazmat_note: '',
      surcharge_total: 0,
      estimated_total: PRICING_LIGHT.half,
      estimated_duration_minutes: 60,
      needs_landfill_run: true,
      difficulty: 'medium',
      notes: raw.slice(0, 500),
      confidence: 'low',
    };
  }
}

module.exports = { analyzePhoto };
