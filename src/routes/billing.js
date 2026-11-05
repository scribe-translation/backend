const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const CreditLedger = require('../models/CreditLedger');
const DiscountApplication = require('../models/DiscountApplication');
const emailService = require('../services/emailService');
const config = require('../config');
const {
  BUNDLES,
  APPLICATION_STATUSES,
  ORGANIZATION_TYPES,
  LEDGER_TYPES,
  BILLING_TIERS,
  normalizeCurrency,
  getBundleById,
} = require('../billing/constants');
const stripeService = require('../services/stripeService');

const router = express.Router();

/**
 * @route GET /billing/balance
 */
router.get('/balance', async (req, res) => {
  try {
    const balance = await User.getBalance(req.user.id);
    if (!balance) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(balance);
  } catch (error) {
    console.error('Balance error:', error.message);
    res.status(500).json({ error: 'Failed to load balance' });
  }
});

/**
 * @route GET /billing/bundles
 */
router.get('/bundles', async (req, res) => {
  try {
    const user = await User.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const currency = normalizeCurrency(req.query.currency || user.preferredCurrency);
    res.json({
      currency,
      billingTier: user.billingTier,
      bundles: stripeService.listPublicBundles(currency, user.billingTier),
      stripeConfigured: stripeService.isStripeConfigured(),
    });
  } catch (error) {
    console.error('Bundles error:', error.message);
    res.status(500).json({ error: 'Failed to load bundles' });
  }
});

/**
 * @route PATCH /billing/currency
 */
router.patch(
  '/currency',
  body('currency').isIn(['cad', 'usd', 'CAD', 'USD']),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid currency', details: errors.array() });
      }
      const preferredCurrency = await User.setPreferredCurrency(req.user.id, req.body.currency);
      res.json({ preferredCurrency });
    } catch (error) {
      console.error('Currency update error:', error.message);
      res.status(500).json({ error: 'Failed to update currency' });
    }
  }
);

/**
 * @route POST /billing/checkout
 */
function resolveCheckoutReturnBase(returnOrigin) {
  const fallback = (config.FRONTEND_URL || 'https://speaker.scribe-ai.ca').replace(/\/$/, '');
  if (!returnOrigin || typeof returnOrigin !== 'string') {
    return fallback;
  }

  let origin;
  try {
    origin = new URL(returnOrigin).origin;
  } catch {
    return fallback;
  }

  const allowed = String(config.CORS_ORIGIN || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      try {
        return [new URL(entry).origin];
      } catch {
        return [];
      }
    });

  if (config.FRONTEND_URL) {
    try {
      allowed.push(new URL(config.FRONTEND_URL).origin);
    } catch {
      /* ignore */
    }
  }

  // Never send purchasers to the listener host after checkout.
  const listenerOrigin = (() => {
    try {
      return config.TRANSLATION_URL ? new URL(config.TRANSLATION_URL).origin : null;
    } catch {
      return null;
    }
  })();
  if (listenerOrigin && origin === listenerOrigin) {
    return fallback;
  }

  if (allowed.length === 0 || allowed.includes(origin)) {
    return origin;
  }
  return fallback;
}

router.post(
  '/checkout',
  body('bundleId').isIn(BUNDLES.map((b) => b.id)),
  body('currency').optional().isIn(['cad', 'usd', 'CAD', 'USD']),
  body('returnOrigin').optional().isString().isLength({ max: 500 }),
  async (req, res) => {
    try {
      if (!stripeService.isStripeConfigured()) {
        return res.status(503).json({
          error: 'Payments are not configured yet',
          code: 'STRIPE_NOT_CONFIGURED',
        });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid request', details: errors.array() });
      }

      const user = await User.findUserById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.billingTier === BILLING_TIERS.COMPLIMENTARY) {
        return res.status(400).json({
          error: 'Complimentary accounts do not need to purchase hours',
          code: 'COMPLIMENTARY',
        });
      }

      const currency = normalizeCurrency(req.body.currency || user.preferredCurrency);
      if (currency !== user.preferredCurrency) {
        await User.setPreferredCurrency(user.id, currency);
      }

      const frontendBase = resolveCheckoutReturnBase(req.body.returnOrigin);
      const session = await stripeService.createCheckoutSession({
        userId: user.id,
        userEmail: user.email,
        bundleId: req.body.bundleId,
        currency,
        billingTier: user.billingTier,
        successUrl: `${frontendBase}/profile?purchase=success`,
        cancelUrl: `${frontendBase}/profile?purchase=cancelled`,
      });

      res.json({ url: session.url, sessionId: session.id });
    } catch (error) {
      console.error('Checkout error:', error.message);
      res.status(500).json({ error: error.message || 'Failed to start checkout' });
    }
  }
);

/**
 * @route GET /billing/application
 */
router.get('/application', async (req, res) => {
  try {
    const application = await DiscountApplication.findLatestForUser(req.user.id);
    res.json({ application: application ? application.toJSON() : null });
  } catch (error) {
    console.error('Get application error:', error.message);
    res.status(500).json({ error: 'Failed to load application' });
  }
});

/**
 * @route POST /billing/application
 */
router.post(
  '/application',
  body('organizationType').isIn(Object.values(ORGANIZATION_TYPES)),
  body('organizationName').trim().isLength({ min: 2, max: 200 }),
  body('city').trim().isLength({ min: 2, max: 100 }),
  body('role').trim().isLength({ min: 2, max: 100 }),
  body('website')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .customSanitizer((value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      if (!trimmed) return '';
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      return `https://${trimmed}`;
    })
    .custom((value) => {
      if (!value) return true;
      try {
        const parsed = new URL(value);
        if (!parsed.hostname || !parsed.hostname.includes('.')) {
          throw new Error('Website must be a valid URL');
        }
        return true;
      } catch {
        throw new Error('Website must be a valid URL (e.g. https://yourchurch.org)');
      }
    }),
  body('statementOrDescription').custom((value, { req }) => {
    const website = typeof req.body.website === 'string' ? req.body.website.trim() : '';
    const statement = typeof value === 'string' ? value.trim() : '';
    if (statement.length > 10000) {
      throw new Error('Statement/description is too long');
    }
    if (website) return true;
    if (statement.length >= 20) return true;
    throw new Error(
      'Provide a website or a statement/description (at least 20 characters)'
    );
  }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const details = errors.array();
        const first = details[0]?.msg || 'Validation failed';
        return res.status(400).json({ error: first, details });
      }

      const user = await User.findUserById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const application = await DiscountApplication.create({
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        organizationType: req.body.organizationType,
        organizationName: req.body.organizationName,
        city: req.body.city,
        role: req.body.role,
        website: req.body.website || null,
        statementOrDescription: req.body.statementOrDescription || '',
      });

      const adminEmails = config.ADMIN_EMAILS || [];
      for (const adminEmail of adminEmails) {
        try {
          await emailService.sendDiscountApplicationNotification({
            to: adminEmail,
            applicantName: user.name,
            applicantEmail: user.email,
            organizationType: application.organizationType,
            organizationName: application.organizationName,
            city: application.city,
          });
        } catch (mailErr) {
          console.error('Failed to email admin about application:', mailErr.message);
        }
      }

      res.status(201).json({
        message: 'Application submitted',
        application: application.toJSON(),
      });
    } catch (error) {
      if (error.code === 'APPLICATION_PENDING' || error.code === 'ALREADY_APPROVED') {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      console.error('Application submit error:', error.message);
      res.status(500).json({ error: error.message || 'Failed to submit application' });
    }
  }
);

async function fulfillCheckoutSession(session) {
  if (!session || session.payment_status === 'unpaid') {
    return { fulfilled: false, reason: 'unpaid' };
  }

  const userId = session.metadata?.userId || session.client_reference_id;
  const bundleId = session.metadata?.bundleId;
  const bundle = getBundleById(bundleId);
  if (!userId || !bundle) {
    console.error('Checkout fulfillment missing userId or bundle', {
      sessionId: session.id,
      metadata: session.metadata,
    });
    return { fulfilled: false, reason: 'invalid_metadata' };
  }

  const currency = normalizeCurrency(session.metadata?.currency || session.currency);
  const result = await CreditLedger.grantSeconds({
    userId,
    seconds: bundle.seconds,
    type: LEDGER_TYPES.PURCHASE,
    stripeCheckoutSessionId: session.id,
    bundleId: bundle.id,
    currency,
    note: `Purchase ${bundle.hours}h via Checkout ${session.id}`,
  });

  return {
    fulfilled: !result.alreadyFulfilled,
    alreadyFulfilled: result.alreadyFulfilled,
    balanceAfter: result.ledger.balanceAfter,
  };
}

module.exports = router;
module.exports.fulfillCheckoutSession = fulfillCheckoutSession;
