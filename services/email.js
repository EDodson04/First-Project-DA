const { Resend } = require('resend');

let _resend;
function getResend() {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// Log config once on first send
let _logged = false;
function logConfigOnce() {
  if (_logged) return;
  _logged = true;
  const key = (process.env.RESEND_API_KEY || '').trim();
  console.log('[email] RESEND_API_KEY:', key ? `"${key.slice(0, 8)}…" (${key.length} chars)` : '(not set)');
  console.log('[email] RESEND_FROM:', FROM());
  console.log('[email] OWNER_EMAIL:', OWNER_EMAIL());
}

const FROM       = () => (process.env.RESEND_FROM || '').trim() || 'Gone by Monday <onboarding@resend.dev>';
const OWNER_EMAIL = () => (process.env.OWNER_EMAIL || '').trim() || (process.env.GMAIL_USER || '').trim();
const BASE       = () => process.env.BASE_URL || 'https://gone-by-monday.onrender.com';

async function sendMail(to, subject, html, attachments = []) {
  logConfigOnce();
  console.log(`[email] sendMail called — to: ${to}, subject: ${subject}`);

  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) {
    console.warn('[email] Skipping — RESEND_API_KEY not set. Subject:', subject);
    return null;
  }

  try {
    const payload = { from: FROM(), to, subject, html };
    if (attachments && attachments.length) payload.attachments = attachments;

    const { data, error } = await getResend().emails.send(payload);

    if (error) {
      console.error(`[email] FAILED — to: ${to}, subject: ${subject}`);
      console.error(`[email] Resend error:`, error);
      throw new Error(error.message || JSON.stringify(error));
    }

    console.log(`[email] SUCCESS — sent to ${to}: ${subject} (id: ${data?.id})`);
    return data;
  } catch (err) {
    console.error(`[email] FAILED — to: ${to}, subject: ${subject}`);
    console.error(`[email] Error message: ${err.message}`);
    console.error(`[email] Full error:`, err);
    throw err;
  }
}

// ── Owner: new quote request notification ─────────────────────────────────────
const DEST_LABELS = {
  disposal: 'Junk removal (haul away)',
  donate_di: '🎁 Donation pickup → Deseret Industries',
  donate_goodwill: '🎁 Donation pickup → Goodwill',
  mix: '⚡ Mixed — some donate, some haul',
};

async function emailOwnerNewRequest({ inquiry, quote, analysis, customer }) {
  const photoRow = inquiry.photo_url
    ? `<tr><td style="padding:8px 0;color:#616161;width:140px">Photo</td><td><a href="${inquiry.photo_url}" style="color:#2d6a4f">View photo →</a></td></tr>`
    : '';
  const destLabel = DEST_LABELS[quote?.destination] || quote?.destination || 'Junk removal';
  const destRow = `<tr><td style="padding:8px 0;color:#616161;width:140px"><strong>Destination</strong></td><td><strong style="color:#1a5c38">${destLabel}</strong></td></tr>`;
  const surveyRow = quote?.storage_survey
    ? `<tr><td style="padding:4px 0;color:#616161">Storage unit interest</td><td>${quote.storage_survey === 'yes' ? '✅ Yes — interested in storage delivery' : quote.storage_survey}</td></tr>`
    : '';

  const materialsRow = analysis?.materials?.length
    ? `<tr><td style="padding:4px 0;color:#616161;width:140px">Materials</td><td>${analysis.materials.join(', ')}</td></tr>`
    : '';

  const html = `
<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#2d6a4f;padding:24px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:1.4rem">🚛 New Quote Request</h1>
  </div>
  <div style="padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:8px 0;color:#616161;width:140px">Name</td><td><strong>${customer?.name || '—'}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#616161">Phone</td><td>${customer?.phone || inquiry.phone || '—'}</td></tr>
      <tr><td style="padding:8px 0;color:#616161">Email</td><td>${customer?.email || '—'}</td></tr>
      <tr><td style="padding:8px 0;color:#616161">Address</td><td>${customer?.address || '—'}</td></tr>
      ${destRow}
      ${surveyRow}
      ${photoRow}
      ${inquiry.message ? `<tr><td style="padding:8px 0;color:#616161">Description</td><td>${inquiry.message}</td></tr>` : ''}
    </table>

    ${analysis ? `
    <div style="background:#f5f5f5;border-radius:6px;padding:16px;margin-top:16px">
      <h3 style="margin:0 0 12px;font-size:1rem;color:#2d6a4f">🤖 AI Estimate</h3>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:4px 0;color:#616161;width:140px">Load size</td><td><strong>${analysis.load_size || '—'}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#616161">Base price</td><td><strong>$${analysis.base_price || 0}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#616161">Est. total</td><td><strong>$${analysis.estimated_total || 0}</strong></td></tr>
        <tr><td style="padding:4px 0;color:#616161">Confidence</td><td>${analysis.confidence || '—'}</td></tr>
        ${materialsRow}
        ${analysis.notes ? `<tr><td style="padding:4px 0;color:#616161">Notes</td><td>${analysis.notes}</td></tr>` : ''}
        ${analysis.hazmat_count > 0 ? `<tr><td style="padding:4px 0;color:#c0392b;font-weight:700">⚠️ Hazmat flag</td><td style="color:#c0392b"><strong>${analysis.hazmat_count} item(s): ${analysis.hazmat_note || 'hazardous materials detected'}</strong><br><span style="font-size:.85rem">Owner-only flag — not visible to customer. Confirm before approving.</span></td></tr>` : ''}
      </table>
    </div>` : ''}

    <div style="margin-top:20px;text-align:center">
      <a href="${BASE()}/quotes.html" style="display:inline-block;background:#2d6a4f;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700">
        Review &amp; Approve in Dashboard →
      </a>
    </div>
  </div>
</div>`;

  return sendMail(OWNER_EMAIL(), `📲 New quote request${customer?.name ? ' from ' + customer.name : ''}`, html);
}

// ── Customer: quote email with approval link ───────────────────────────────────
async function emailCustomerQuote({ customerEmail, customerName, quote, approveUrl }) {
  const name = customerName || 'there';
  const businessName = process.env.BUSINESS_NAME || 'Gone by Monday';

  const lines = [];
  if (quote.fuel_surcharge > 0)       lines.push(`Fuel: $${quote.fuel_surcharge.toFixed(2)}`);
  if (quote.tire_surcharge > 0)       lines.push(`Tire disposal: $${quote.tire_surcharge.toFixed(2)}`);
  if (quote.appliance_surcharge > 0)  lines.push(`Appliances: $${quote.appliance_surcharge.toFixed(2)}`);
  if (quote.mattress_surcharge > 0)   lines.push(`Mattresses: $${quote.mattress_surcharge.toFixed(2)}`);
  if (quote.electronics_surcharge > 0) lines.push(`Electronics: $${quote.electronics_surcharge.toFixed(2)}`);
  if (quote.hazmat_surcharge > 0)     lines.push(`Hazmat/paint: $${quote.hazmat_surcharge.toFixed(2)}`);
  if (quote.other_surcharge > 0)      lines.push(`Additional fees: $${quote.other_surcharge.toFixed(2)}`);

  const html = `
<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#2d6a4f;padding:24px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:1.4rem">🚛 Your Junk Removal Quote</h1>
  </div>
  <div style="padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
    <p>Hi ${name},</p>
    <p>Thanks for reaching out to ${businessName}! Here's your estimate based on the photo you sent:</p>

    <div style="background:#f5f5f5;border-radius:6px;padding:16px;margin:16px 0">
      <div style="margin-bottom:8px;color:#616161">Load: <strong>${formatLoad(quote.load_size)}</strong></div>
      <div style="margin-bottom:8px;color:#616161">Base price: <strong>$${quote.base_price.toFixed(2)}</strong></div>
      ${lines.map(l => `<div style="margin-bottom:4px;color:#616161">${l}</div>`).join('')}
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #ddd;font-size:1.1rem">
        <strong>Total: $${quote.total_price.toFixed(2)}</strong>
      </div>
      ${quote.owner_notes ? `<div style="margin-top:8px;font-size:.875rem;color:#616161">Note: ${quote.owner_notes}</div>` : ''}
    </div>

    <p>A 50% deposit ($${(quote.total_price / 2).toFixed(2)}) is required to hold your spot. The balance is due on completion.</p>

    <div style="text-align:center;margin:24px 0">
      <a href="${approveUrl}" style="display:inline-block;background:#e76f00;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:1.05rem">
        ✅ Accept Quote &amp; Pay Deposit →
      </a>
    </div>

    <p style="color:#616161;font-size:.875rem">If you have questions or want to decline, just reply to this email.</p>
    <p style="color:#616161;font-size:.875rem">— ${businessName}</p>
  </div>
</div>`;

  return sendMail(customerEmail, `Your Gone by Monday quote: $${quote.total_price.toFixed(2)}`, html);
}

// ── Owner: deposit received / job confirmed ────────────────────────────────────
async function emailOwnerJobConfirmed({ job, customer }) {
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#2d6a4f;padding:24px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:1.4rem">✅ Deposit Received — Job Confirmed</h1>
  </div>
  <div style="padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:8px 0;color:#616161;width:140px">Customer</td><td><strong>${customer?.name || '—'}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#616161">Phone</td><td>${customer?.phone || '—'}</td></tr>
      <tr><td style="padding:8px 0;color:#616161">Email</td><td>${customer?.email || job?.customer_email || '—'}</td></tr>
      <tr><td style="padding:8px 0;color:#616161">Address</td><td>${customer?.address || '—'}</td></tr>
      <tr><td style="padding:8px 0;color:#616161">Date</td><td><strong>${job?.scheduled_date || 'TBD'}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#616161">Zone</td><td>Zone ${job?.zone || 2}</td></tr>
      <tr><td style="padding:8px 0;color:#616161">Deposit paid</td><td><strong>$${(job?.deposit_amount || 0).toFixed(2)}</strong></td></tr>
      <tr><td style="padding:8px 0;color:#616161">Balance due</td><td>$${(job?.balance_amount || 0).toFixed(2)}</td></tr>
    </table>
    <div style="margin-top:20px;text-align:center">
      <a href="${BASE()}/schedule.html" style="display:inline-block;background:#2d6a4f;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700">
        View Schedule →
      </a>
    </div>
  </div>
</div>`;

  return sendMail(OWNER_EMAIL(), `✅ Job confirmed — deposit received from ${customer?.name || 'customer'}`, html);
}

// ── Customer: completion receipt ───────────────────────────────────────────────
async function emailCustomerReceipt({ customerEmail, customerName, job, amountCharged }) {
  const name = customerName || 'there';
  const businessName = process.env.BUSINESS_NAME || 'Gone by Monday';
  const total = (job?.deposit_amount || 0) + (amountCharged || 0);

  const html = `
<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#2d6a4f;padding:24px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:1.4rem">🎉 Job Complete — Receipt</h1>
  </div>
  <div style="padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
    <p>Hi ${name},</p>
    <p>Your junk removal is complete! Here's your receipt:</p>

    <div style="background:#f5f5f5;border-radius:6px;padding:16px;margin:16px 0">
      <div style="margin-bottom:8px;color:#616161">Deposit paid: <strong>$${(job?.deposit_amount || 0).toFixed(2)}</strong></div>
      <div style="margin-bottom:8px;color:#616161">Balance charged: <strong>$${(amountCharged || 0).toFixed(2)}</strong></div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #ddd;font-size:1.1rem">
        <strong>Total paid: $${total.toFixed(2)}</strong>
      </div>
    </div>

    <p>Thanks for choosing ${businessName}! If you need us again, visit our website or text us a photo anytime.</p>
    <p style="color:#616161;font-size:.875rem">— ${businessName}</p>
  </div>
</div>`;

  return sendMail(customerEmail, `Your pickup is complete — thank you!`, html);
}

function formatLoad(size) {
  const m = { quarter: '1/4 Load', half: '1/2 Load', three_quarter: '3/4 Load', full: 'Full Load' };
  return m[size] || size || 'Varies';
}

module.exports = {
  sendMail,
  emailOwnerNewRequest,
  emailCustomerQuote,
  emailOwnerJobConfirmed,
  emailCustomerReceipt,
};
