const twilio = require('twilio');
const { logSms } = require('../database/db');

let client;
function getClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

const FROM = process.env.TWILIO_PHONE_NUMBER;

async function sendSms(to, body) {
  try {
    const msg = await getClient().messages.create({ from: FROM, to, body });
    logSms('outbound', to, body, null, msg.sid);
    return msg;
  } catch (err) {
    console.error('SMS send error:', err.message);
    throw err;
  }
}

function buildQuoteMessage(quote, businessName) {
  const name = businessName || process.env.BUSINESS_NAME || 'Gone by Monday';
  const lines = [
    `Hi! This is ${name}.`,
    ``,
    `Based on your photo, here's your estimate:`,
    ``,
    `Load: ${formatLoadSize(quote.load_size)}`,
  ];

  if (quote.fuel_surcharge > 0) lines.push(`Fuel surcharge: $${quote.fuel_surcharge.toFixed(2)}`);
  if (quote.tire_surcharge > 0) lines.push(`Tire disposal: $${quote.tire_surcharge.toFixed(2)}`);
  if (quote.appliance_surcharge > 0) lines.push(`Appliance fee: $${quote.appliance_surcharge.toFixed(2)}`);
  if (quote.mattress_surcharge > 0) lines.push(`Mattress fee: $${quote.mattress_surcharge.toFixed(2)}`);
  if (quote.electronics_surcharge > 0) lines.push(`Electronics fee: $${quote.electronics_surcharge.toFixed(2)}`);
  if (quote.hazmat_surcharge > 0) lines.push(`Hazmat/paint fee: $${quote.hazmat_surcharge.toFixed(2)}`);
  if (quote.other_surcharge > 0) lines.push(`Other fees: $${quote.other_surcharge.toFixed(2)}`);

  lines.push(``, `💰 Total: $${quote.total_price.toFixed(2)}`);

  if (quote.owner_notes) {
    lines.push(``, `Note: ${quote.owner_notes}`);
  }

  lines.push(``, `Reply YES to accept or NO to decline.`);

  return lines.join('\n');
}

function buildAddressRequestMessage() {
  return `Great! We'll get you scheduled.\n\nPlease reply with your full pickup address (street, city, zip).`;
}

function buildDayRequestMessage() {
  return `Got it! What day works best for pickup?\n\nReply with: Monday, Tuesday, Wednesday, Thursday, Friday, or Saturday.`;
}

function buildConfirmationMessage(customerName, date, businessPhone) {
  const phone = businessPhone || process.env.BUSINESS_PHONE || '';
  return `You're all set! 🎉\n\nYour junk removal is confirmed${date ? ` for ${date}` : ''}.\n\nWe'll text you a 30-min heads up before we arrive. Questions? Call/text ${phone}.\n\n- Gone by Monday`;
}

function buildReminderMessage(job) {
  return `Heads up! The Gone by Monday crew is about 30 minutes away for your pickup at ${job.address}. See you soon! 🚛`;
}

function buildDepositReminderMessage(job) {
  const depositAmt = job.deposit_amount ? `$${job.deposit_amount.toFixed(2)}` : 'your deposit';
  return `Reminder: Your Gone by Monday pickup is scheduled for ${job.scheduled_date || 'soon'} but we haven't received your deposit yet (${depositAmt}). Please pay to hold your slot, or reply CANCEL to release it.`;
}

function buildBalanceMessage(job, payLink) {
  const bal = job.balance_amount ? `$${job.balance_amount.toFixed(2)}` : 'your balance';
  const venmo = process.env.VENMO_HANDLE ? `\n\nOr Venmo @${process.env.VENMO_HANDLE}` : '';
  const linkText = payLink ? `\nPay here: ${payLink}` : '';
  return `Job complete! Thanks for choosing Gone by Monday.\n\nBalance due: ${bal}${linkText}${venmo}`;
}

function buildRouteSummary(date, jobs) {
  const lines = [`📋 Route for ${date}:`, ``];
  jobs.forEach((job, i) => {
    lines.push(`${i + 1}. ${job.name || job.phone}`);
    lines.push(`   📍 ${job.address}`);
    if (job.drive_time_from_prev_minutes > 0) {
      lines.push(`   🚗 ${job.drive_time_from_prev_minutes} min from prev stop`);
    }
    lines.push(``);
  });
  lines.push(`Total stops: ${jobs.length}`);
  return lines.join('\n');
}

function formatLoadSize(size) {
  const map = {
    quarter: '1/4 Truck Load',
    half: '1/2 Truck Load',
    three_quarter: '3/4 Truck Load',
    full: 'Full Truck Load',
  };
  return map[size] || size || 'Varies';
}

module.exports = {
  sendSms,
  buildQuoteMessage,
  buildAddressRequestMessage,
  buildDayRequestMessage,
  buildConfirmationMessage,
  buildReminderMessage,
  buildRouteSummary,
  buildDepositReminderMessage,
  buildBalanceMessage,
};
