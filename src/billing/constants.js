const SIGNUP_GRANT_SECONDS = 2 * 60 * 60;

const BILLING_TIERS = Object.freeze({
  STANDARD: 'standard',
  COMPLIMENTARY: 'complimentary',
  DISCOUNT: 'discount',
});

const LEDGER_TYPES = Object.freeze({
  SIGNUP_GRANT: 'signup_grant',
  PURCHASE: 'purchase',
  USAGE: 'usage',
});

const APPLICATION_STATUSES = Object.freeze({
  IN_REVIEW: 'in_review',
  COMPLIMENTARY: 'complimentary',
  DISCOUNT: 'discount',
  DECLINED: 'declined',
});

const ORGANIZATION_TYPES = Object.freeze({
  CHURCH: 'church',
  CHARITY: 'charity',
});

const CURRENCIES = Object.freeze({
  CAD: 'cad',
  USD: 'usd',
});

const BUNDLES = Object.freeze([
  {
    id: 'hours_5',
    hours: 5,
    seconds: 5 * 60 * 60,
    prices: { usd: 6000, cad: 8500 }, // cents
  },
  {
    id: 'hours_10',
    hours: 10,
    seconds: 10 * 60 * 60,
    prices: { usd: 11000, cad: 15500 },
  },
  {
    id: 'hours_20',
    hours: 20,
    seconds: 20 * 60 * 60,
    prices: { usd: 20000, cad: 28000 },
  },
]);

const BALANCE_TICK_SECONDS = 30;
const LOW_BALANCE_WARN_SECONDS = [10 * 60, 2 * 60];

function isValidBillingTier(tier) {
  return Object.values(BILLING_TIERS).includes(tier);
}

function isValidCurrency(currency) {
  return Object.values(CURRENCIES).includes(String(currency || '').toLowerCase());
}

function getBundleById(bundleId) {
  return BUNDLES.find((b) => b.id === bundleId) || null;
}

function normalizeCurrency(currency) {
  const c = String(currency || CURRENCIES.CAD).toLowerCase();
  return isValidCurrency(c) ? c : CURRENCIES.CAD;
}

module.exports = {
  SIGNUP_GRANT_SECONDS,
  BILLING_TIERS,
  LEDGER_TYPES,
  APPLICATION_STATUSES,
  ORGANIZATION_TYPES,
  CURRENCIES,
  BUNDLES,
  BALANCE_TICK_SECONDS,
  LOW_BALANCE_WARN_SECONDS,
  isValidBillingTier,
  isValidCurrency,
  getBundleById,
  normalizeCurrency,
};
