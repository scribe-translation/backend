const { getDb, Collections, dateToTimestamp, timestampToDate } = require('../database/firestore');
const { LEDGER_TYPES, BILLING_TIERS } = require('../billing/constants');

class CreditLedger {
  constructor(data) {
    this.id = data.id;
    this.userId = data.userId;
    this.type = data.type;
    this.secondsDelta = data.secondsDelta || 0;
    this.balanceAfter = data.balanceAfter ?? null;
    this.stripeCheckoutSessionId = data.stripeCheckoutSessionId || null;
    this.bundleId = data.bundleId || null;
    this.currency = data.currency || null;
    this.note = data.note || null;
    this.createdAt = timestampToDate(data.createdAt);
  }

  static purchaseDocId(checkoutSessionId) {
    return `purchase_${checkoutSessionId}`;
  }

  static signupGrantDocId(userId) {
    return `signup_${userId}`;
  }

  static async findByCheckoutSessionId(checkoutSessionId) {
    if (!checkoutSessionId) return null;
    const db = getDb();
    const doc = await db
      .collection(Collections.CREDIT_LEDGER)
      .doc(CreditLedger.purchaseDocId(checkoutSessionId))
      .get();

    if (!doc.exists) return null;
    return new CreditLedger({ id: doc.id, ...doc.data() });
  }

  static async listForUser(userId, limit = 50) {
    const db = getDb();
    const snapshot = await db
      .collection(Collections.CREDIT_LEDGER)
      .where('userId', '==', userId)
      .get();

    return snapshot.docs
      .map((doc) => new CreditLedger({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const aTime = a.createdAt ? a.createdAt.getTime() : 0;
        const bTime = b.createdAt ? b.createdAt.getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, limit);
  }

  static async grantSeconds({
    userId,
    seconds,
    type,
    stripeCheckoutSessionId = null,
    bundleId = null,
    currency = null,
    note = null,
  }) {
    if (!seconds || seconds <= 0) {
      throw new Error('seconds must be positive');
    }

    const db = getDb();
    const userRef = db.collection(Collections.USERS).doc(userId);
    const isPurchase = type === LEDGER_TYPES.PURCHASE && stripeCheckoutSessionId;
    const isSignup = type === LEDGER_TYPES.SIGNUP_GRANT;
    const ledgerRef = isPurchase
      ? db.collection(Collections.CREDIT_LEDGER).doc(CreditLedger.purchaseDocId(stripeCheckoutSessionId))
      : isSignup
        ? db.collection(Collections.CREDIT_LEDGER).doc(CreditLedger.signupGrantDocId(userId))
        : db.collection(Collections.CREDIT_LEDGER).doc();

    return db.runTransaction(async (tx) => {
      if (isPurchase || isSignup) {
        const existing = await tx.get(ledgerRef);
        if (existing.exists) {
          return {
            ledger: new CreditLedger({ id: existing.id, ...existing.data() }),
            alreadyFulfilled: true,
          };
        }
      }

      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }
      const data = userSnap.data();
      const current = typeof data.balanceSeconds === 'number' ? data.balanceSeconds : 0;
      const balanceAfter = current + seconds;
      const now = dateToTimestamp(new Date());

      tx.update(userRef, {
        balanceSeconds: balanceAfter,
        updatedAt: now,
      });

      const ledgerDoc = {
        userId,
        type,
        secondsDelta: seconds,
        balanceAfter,
        stripeCheckoutSessionId: stripeCheckoutSessionId || null,
        bundleId: bundleId || null,
        currency: currency || null,
        note: note || null,
        createdAt: now,
      };
      tx.set(ledgerRef, ledgerDoc);

      return {
        ledger: new CreditLedger({ id: ledgerRef.id, ...ledgerDoc }),
        alreadyFulfilled: false,
      };
    });
  }

  static async spendSeconds(userId, seconds, { note = null } = {}) {
    if (!seconds || seconds <= 0) {
      throw new Error('seconds must be positive');
    }

    const db = getDb();
    const userRef = db.collection(Collections.USERS).doc(userId);
    const ledgerRef = db.collection(Collections.CREDIT_LEDGER).doc();

    return db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }
      const data = userSnap.data();
      const current = typeof data.balanceSeconds === 'number' ? data.balanceSeconds : 0;

      if (data.billingTier === BILLING_TIERS.COMPLIMENTARY) {
        return {
          skipped: true,
          complimentary: true,
          balanceSeconds: current,
          spent: 0,
          depleted: false,
        };
      }

      const spent = Math.min(current, seconds);
      const balanceAfter = Math.max(0, current - spent);
      const now = dateToTimestamp(new Date());

      if (spent > 0) {
        tx.update(userRef, {
          balanceSeconds: balanceAfter,
          lastActiveAt: now,
          updatedAt: now,
        });

        tx.set(ledgerRef, {
          userId,
          type: LEDGER_TYPES.USAGE,
          secondsDelta: -spent,
          balanceAfter,
          stripeCheckoutSessionId: null,
          bundleId: null,
          currency: null,
          note: note || null,
          createdAt: now,
        });
      }

      return {
        skipped: false,
        complimentary: false,
        balanceSeconds: balanceAfter,
        spent,
        depleted: balanceAfter <= 0,
      };
    });
  }
}

module.exports = CreditLedger;
