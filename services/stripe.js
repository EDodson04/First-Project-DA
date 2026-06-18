const Stripe = require('stripe');

let _stripe;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// Create a payment link for a given amount (in dollars)
async function createPaymentLink(amountDollars, description, metadata = {}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return null; // Stripe not configured
  }

  const stripe = getStripe();

  // Create a price dynamically
  const price = await stripe.prices.create({
    unit_amount: Math.round(amountDollars * 100), // convert to cents
    currency: 'usd',
    product_data: { name: description },
  });

  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata,
    after_completion: {
      type: 'redirect',
      redirect: { url: (process.env.BASE_URL || '') + '/payment-success.html' },
    },
  });

  return link.url;
}

// Verify a Stripe webhook signature
function constructWebhookEvent(rawBody, signature, secret) {
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = { createPaymentLink, constructWebhookEvent };
