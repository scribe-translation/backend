const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SIGNUP_GRANT_SECONDS,
  BUNDLES,
  getBundleById,
  normalizeCurrency,
  isValidBillingTier,
  BILLING_TIERS,
} = require('./constants');

describe('billing constants', () => {
  it('grants two hours on signup', () => {
    assert.equal(SIGNUP_GRANT_SECONDS, 7200);
  });

  it('lists three bundles with usd and cad prices in cents', () => {
    assert.equal(BUNDLES.length, 3);
    for (const bundle of BUNDLES) {
      assert.ok(bundle.prices.usd > 0);
      assert.ok(bundle.prices.cad > 0);
      assert.equal(bundle.seconds, bundle.hours * 3600);
    }
  });

  it('resolves bundles by id', () => {
    assert.equal(getBundleById('hours_5').hours, 5);
    assert.equal(getBundleById('missing'), null);
  });

  it('normalizes currency to cad by default', () => {
    assert.equal(normalizeCurrency('USD'), 'usd');
    assert.equal(normalizeCurrency('garbage'), 'cad');
    assert.equal(normalizeCurrency(null), 'cad');
  });

  it('validates billing tiers', () => {
    assert.equal(isValidBillingTier(BILLING_TIERS.DISCOUNT), true);
    assert.equal(isValidBillingTier('vip'), false);
  });
});
