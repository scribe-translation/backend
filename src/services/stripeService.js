const Stripe = require('stripe');
const config = require('../config');
const {
  BUNDLES,
  BILLING_TIERS,
  getBundleById,
  normalizeCurrency,
} = require('../billing/constants');

let stripeClient = null;

function getStripe() {
  if (stripeClient) return stripeClient;
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  stripeClient = new Stripe(config.STRIPE_SECRET_KEY, {
    apiVersion: '2026-09-30.endive',
  });
  return stripeClient;
}

function isStripeConfigured() {
  return Boolean(config.STRIPE_SECRET_KEY);
}

function getPriceId(bundleId, currency) {
  const key = `STRIPE_PRICE_${bundleId.toUpperCase()}_${String(currency).toUpperCase()}`;
  const priceId = config[key] || process.env[key];
  if (!priceId) {
    throw new Error(`Missing Stripe price id for ${bundleId} (${currency}). Set ${key}.`);
  }
  return priceId;
}

function listPublicBundles(currency, billingTier) {
  const cur = normalizeCurrency(currency);
  const discounted = billingTier === BILLING_TIERS.DISCOUNT;
  return BUNDLES.map((bundle) => {
    const listCents = bundle.prices[cur];
    const amountCents = discounted ? Math.round(listCents * 0.9) : listCents;
    return {
      id: bundle.id,
      hours: bundle.hours,
      currency: cur,
      amountCents,
      listAmountCents: listCents,
      discounted,
    };
  });
}

async function createCheckoutSession({
  userId,
  userEmail,
  bundleId,
  currency,
  billingTier,
  successUrl,
  cancelUrl,
}) {
  const bundle = getBundleById(bundleId);
  if (!bundle) {
    const err = new Error('Unknown bundle');
    err.code = 'UNKNOWN_BUNDLE';
    throw err;
  }

  const cur = normalizeCurrency(currency);
  const stripe = getStripe();
  const priceId = getPriceId(bundleId, cur);

  const sessionParams = {
    mode: 'payment',
    customer_email: userEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    integration_identifier: `scribe_hours_${Math.random().toString(36).slice(2, 10)}`,
    metadata: {
      userId,
      bundleId,
      hours: String(bundle.hours),
      seconds: String(bundle.seconds),
      currency: cur,
    },
  };

  if (billingTier === BILLING_TIERS.DISCOUNT && config.STRIPE_DISCOUNT_COUPON_ID) {
    sessionParams.discounts = [{ coupon: config.STRIPE_DISCOUNT_COUPON_ID }];
  }

  return stripe.checkout.sessions.create(sessionParams);
}

function constructWebhookEvent(rawBody, signature) {
  const stripe = getStripe();
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    config.STRIPE_WEBHOOK_SECRET
  );
}

module.exports = {
  getStripe,
  isStripeConfigured,
  getPriceId,
  listPublicBundles,
  createCheckoutSession,
  constructWebhookEvent,
};
