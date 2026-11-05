const { getDb, Collections, dateToTimestamp, timestampToDate } = require('../database/firestore');
const {
  APPLICATION_STATUSES,
  ORGANIZATION_TYPES,
  BILLING_TIERS,
} = require('../billing/constants');

class DiscountApplication {
  constructor(data) {
    this.id = data.id;
    this.userId = data.userId;
    this.organizationType = data.organizationType;
    this.organizationName = data.organizationName;
    this.city = data.city;
    this.role = data.role;
    this.website = data.website || null;
    this.statementOrDescription = data.statementOrDescription;
    this.status = data.status;
    this.reviewedAt = timestampToDate(data.reviewedAt);
    this.reviewedBy = data.reviewedBy || null;
    this.createdAt = timestampToDate(data.createdAt);
    this.updatedAt = timestampToDate(data.updatedAt);
    this.userEmail = data.userEmail || null;
    this.userName = data.userName || null;
  }

  toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      organizationType: this.organizationType,
      organizationName: this.organizationName,
      city: this.city,
      role: this.role,
      website: this.website,
      statementOrDescription: this.statementOrDescription,
      status: this.status,
      reviewedAt: this.reviewedAt,
      reviewedBy: this.reviewedBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      userEmail: this.userEmail,
      userName: this.userName,
    };
  }

  static statusToBillingTier(status) {
    if (status === APPLICATION_STATUSES.COMPLIMENTARY) return BILLING_TIERS.COMPLIMENTARY;
    if (status === APPLICATION_STATUSES.DISCOUNT) return BILLING_TIERS.DISCOUNT;
    return BILLING_TIERS.STANDARD;
  }

  static async findLatestForUser(userId) {
    const db = getDb();
    const snapshot = await db
      .collection(Collections.DISCOUNT_APPLICATIONS)
      .where('userId', '==', userId)
      .get();

    if (snapshot.empty) return null;

    const apps = snapshot.docs
      .map((doc) => new DiscountApplication({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const aTime = a.createdAt ? a.createdAt.getTime() : 0;
        const bTime = b.createdAt ? b.createdAt.getTime() : 0;
        return bTime - aTime;
      });

    return apps[0] || null;
  }

  static async create({
    userId,
    userEmail,
    userName,
    organizationType,
    organizationName,
    city,
    role,
    website,
    statementOrDescription,
  }) {
    if (!Object.values(ORGANIZATION_TYPES).includes(organizationType)) {
      throw new Error('Invalid organization type');
    }
    if (!organizationName?.trim() || !city?.trim() || !role?.trim()) {
      throw new Error('Organization name, city, and role are required');
    }
    const websiteTrimmed = website?.trim() || '';
    const statementTrimmed = statementOrDescription?.trim() || '';
    if (!websiteTrimmed && !statementTrimmed) {
      throw new Error(
        organizationType === ORGANIZATION_TYPES.CHURCH
          ? 'Provide a website or a statement of faith'
          : 'Provide a website or an organization description'
      );
    }

    const existing = await DiscountApplication.findLatestForUser(userId);
    if (existing && existing.status === APPLICATION_STATUSES.IN_REVIEW) {
      const err = new Error('An application is already in review');
      err.code = 'APPLICATION_PENDING';
      throw err;
    }
    if (
      existing &&
      (existing.status === APPLICATION_STATUSES.COMPLIMENTARY ||
        existing.status === APPLICATION_STATUSES.DISCOUNT)
    ) {
      const err = new Error('This account already has an approved discount');
      err.code = 'ALREADY_APPROVED';
      throw err;
    }

    const db = getDb();
    const now = dateToTimestamp(new Date());
    const doc = {
      userId,
      userEmail: userEmail || null,
      userName: userName || null,
      organizationType,
      organizationName: organizationName.trim(),
      city: city.trim(),
      role: role.trim(),
      website: websiteTrimmed || null,
      statementOrDescription: statementTrimmed,
      status: APPLICATION_STATUSES.IN_REVIEW,
      reviewedAt: null,
      reviewedBy: null,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await db.collection(Collections.DISCOUNT_APPLICATIONS).add(doc);
    return new DiscountApplication({ id: docRef.id, ...doc });
  }

  static async list({ status = null, limit = 100 } = {}) {
    const db = getDb();
    let query = db.collection(Collections.DISCOUNT_APPLICATIONS);
    if (status) {
      query = query.where('status', '==', status);
    }
    const snapshot = await query.get();

    return snapshot.docs
      .map((doc) => new DiscountApplication({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const aTime = a.createdAt ? a.createdAt.getTime() : 0;
        const bTime = b.createdAt ? b.createdAt.getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, limit);
  }

  static async findById(id) {
    const db = getDb();
    const doc = await db.collection(Collections.DISCOUNT_APPLICATIONS).doc(id).get();
    if (!doc.exists) return null;
    return new DiscountApplication({ id: doc.id, ...doc.data() });
  }

  static async review(id, { status, reviewedBy }) {
    const allowed = [
      APPLICATION_STATUSES.COMPLIMENTARY,
      APPLICATION_STATUSES.DISCOUNT,
      APPLICATION_STATUSES.DECLINED,
    ];
    if (!allowed.includes(status)) {
      throw new Error('Invalid review status');
    }

    const db = getDb();
    const appRef = db.collection(Collections.DISCOUNT_APPLICATIONS).doc(id);
    const now = dateToTimestamp(new Date());

    return db.runTransaction(async (tx) => {
      const appSnap = await tx.get(appRef);
      if (!appSnap.exists) {
        throw new Error('Application not found');
      }
      const appData = appSnap.data();
      const userRef = db.collection(Collections.USERS).doc(appData.userId);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }

      tx.update(appRef, {
        status,
        reviewedAt: now,
        reviewedBy: reviewedBy || null,
        updatedAt: now,
      });

      tx.update(userRef, {
        billingTier: DiscountApplication.statusToBillingTier(status),
        updatedAt: now,
      });

      return new DiscountApplication({
        id,
        ...appData,
        status,
        reviewedAt: now,
        reviewedBy: reviewedBy || null,
        updatedAt: now,
      });
    });
  }
}

module.exports = DiscountApplication;
