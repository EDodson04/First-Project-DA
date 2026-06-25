const Stripe = require('stripe');

let _stripe;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

const BASE = () => process.env.BASE_URL || 'https://gone-by-monday.onrender.com';

// Create a Checkout Session for a deposit payment.
// Uses setup_future_usage so the card is saved for the balance charge.
async function createDepositSession(amountDollars, description, metadata = {}) {
  if (!process.env.STRIPE_SECRET_KEY) return null;

  const stripe = getStripe();

  // Create or reuse a Stripe Customer keyed on job_id so we can save their card
  let customerId;
  if (metadata.stripe_customer_id) {
    customerId = metadata.stripe_customer_id;
  } else {
    const customer = await stripe.customers.create({
      name: metadata.customer_name || undefined,
      email: metadata.customer_email || undefined,
      metadata: { job_id: String(metadata.job_id || '') },
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(amountDollars * 100),
        product_data: { name: description },
      },
      quantity: 1,
    }],
    payment_intent_data: {
      setup_future_usage: 'off_session', // save card for balance charge
      metadata: { ...metadata, payment_type: 'deposit' },
    },
    metadata: { ...metadata, payment_type: 'deposit' },
    success_url: `${BASE()}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE()}/approve.html?quote_id=${metadata.quote_id || ''}`,
  });

  return { url: session.url, customerId, sessionId: session.id };
}

// Charge the stored card off-session for the balance amount.
async function chargeStoredCard(amountDollars, description, stripeCustomerId, stripePaymentMethodId, metadata = {}) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeCustomerId || !stripePaymentMethodId) return null;

  const stripe = getStripe();

  const intent = await stripe.paymentIntents.create({
    amount: Math.round(amountDollars * 100),
    currency: 'usd',
    customer: stripeCustomerId,
    payment_method: stripePaymentMethodId,
    off_session: true,
    confirm: true,
    description,
    metadata,
  });

  return intent;
}

// Fallback payment link (no saved card — used for manual balance collection)
async function createPaymentLink(amountDollars, description, metadata = {}) {
  if (!process.env.STRIPE_SECRET_KEY) return null;

  const stripe = getStripe();
  const price = await stripe.prices.create({
    unit_amount: Math.round(amountDollars * 100),
    currency: 'usd',
    product_data: { name: description },
  });

  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata,
    after_completion: {
      type: 'redirect',
      redirect: { url: `${BASE()}/payment-success.html` },
    },
  });

  return link.url;
}

// Verify a Stripe webhook signature
function constructWebhookEvent(rawBody, signature, secret) {
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = { getStripe, createDepositSession, chargeStoredCard, createPaymentLink, constructWebhookEvent };
