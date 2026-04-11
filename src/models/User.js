const bcrypt = require('bcrypt');
const { getDb, Collections, timestampToDate, dateToTimestamp } = require('../database/firestore');
const { FieldValue } = require('@google-cloud/firestore');

class User {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.email = data.email;
    this.passwordHash = data.passwordHash || data.password_hash;
    this.isActive = data.isActive !== undefined ? data.isActive : data.is_active;
    this.sessionCode = data.sessionCode || data.session_code || data.userCode || data.user_code;
    this.totpSecret = data.totpSecret || data.totp_secret;
    this.totpEnabled = data.totpEnabled !== undefined ? data.totpEnabled : data.totp_enabled;
    this.totpBackupCodes = data.totpBackupCodes || data.totp_backup_codes;
    this.createdAt = timestampToDate(data.createdAt || data.created_at);
    this.updatedAt = timestampToDate(data.updatedAt || data.updated_at);
    this.totalUsageMinutes = data.totalUsageMinutes || 0;
    this.totalSessions = data.totalSessions || 0;
    this.lastActiveAt = timestampToDate(data.lastActiveAt);
  }

  static async create(name, email, password) {
    try {
      const db = getDb();
      const usersRef = db.collection(Collections.USERS);
      
      const hashedPassword = password.includes(':') ? password : await bcrypt.hash(password, 12);
      
      const now = dateToTimestamp(new Date());
      const userData = {
        name,
        email,
        passwordHash: hashedPassword,
        isActive: true,
        sessionCode: null,
        totpSecret: null,
        totpEnabled: false,
        totpBackupCodes: null,
        createdAt: now,
        updatedAt: now,
        totalUsageMinutes: 0,
        totalSessions: 0,
        lastActiveAt: null,
      };

      const docRef = await usersRef.add(userData);
      
      return new User({
        id: docRef.id,
        ...userData,
      });
    } catch (error) {
      console.error('Error creating user:', error);
      throw error;
    }
  }

  async comparePassword(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.passwordHash);
  }

  static async findUserByEmail(email) {
    try {
      const db = getDb();
      const usersRef = db.collection(Collections.USERS);
      
      const snapshot = await usersRef
        .where('email', '==', email)
        .where('isActive', '==', true)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return null;
      }

      const doc = snapshot.docs[0];
      return new User({
        id: doc.id,
        ...doc.data(),
      });
    } catch (error) {
      console.error('Error finding user by email:', error);
      throw error;
    }
  }

  static async findUserById(id) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(id);
      const doc = await docRef.get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      if (!data.isActive) {
        return null;
      }

      return new User({
        id: doc.id,
        ...data,
      });
    } catch (error) {
      console.error('Error finding user by ID:', error);
      throw error;
    }
  }

  static async getAllUsers() {
    try {
      const db = getDb();
      const usersRef = db.collection(Collections.USERS);
      
      const snapshot = await usersRef.orderBy('createdAt', 'desc').get();

      return snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name,
          email: data.email,
          isActive: data.isActive,
          createdAt: timestampToDate(data.createdAt),
          updatedAt: timestampToDate(data.updatedAt),
        };
      });
    } catch (error) {
      console.error('Error getting all users:', error);
      throw error;
    }
  }

  static async updateUser(id, updateData) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(id);
      
      const allowedFields = ['name', 'email'];
      const updates = {};

      for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
          updates[field] = updateData[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        throw new Error('No valid fields to update');
      }

      updates.updatedAt = dateToTimestamp(new Date());

      await docRef.update(updates);

      const updatedDoc = await docRef.get();
      return new User({
        id: updatedDoc.id,
        ...updatedDoc.data(),
      });
    } catch (error) {
      console.error('Error updating user:', error);
      throw error;
    }
  }

  static async deactivateUser(id) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(id);
      
      await docRef.update({
        isActive: false,
        updatedAt: dateToTimestamp(new Date()),
      });

      const updatedDoc = await docRef.get();
      return new User({
        id: updatedDoc.id,
        ...updatedDoc.data(),
      });
    } catch (error) {
      console.error('Error deactivating user:', error);
      throw error;
    }
  }

  static async updatePassword(id, hashedPassword) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(id);
      
      await docRef.update({
        passwordHash: hashedPassword,
        updatedAt: dateToTimestamp(new Date()),
      });

      return true;
    } catch (error) {
      console.error('Error updating password:', error);
      throw error;
    }
  }

  static async enableTOTP(id, secret, backupCodes) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(id);
      
      await docRef.update({
        totpSecret: secret,
        totpEnabled: true,
        totpBackupCodes: backupCodes,
        updatedAt: dateToTimestamp(new Date()),
      });

      return true;
    } catch (error) {
      console.error('Error enabling TOTP:', error);
      throw error;
    }
  }

  static async disableTOTP(id) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(id);
      
      await docRef.update({
        totpSecret: null,
        totpEnabled: false,
        totpBackupCodes: null,
        updatedAt: dateToTimestamp(new Date()),
      });

      return true;
    } catch (error) {
      console.error('Error disabling TOTP:', error);
      throw error;
    }
  }

  static async verifyTOTP(id, code) {
    try {
      const user = await User.findUserById(id);
      if (!user || !user.totpSecret) {
        return false;
      }

      const speakeasy = require('speakeasy');
      return speakeasy.totp.verify({
        secret: user.totpSecret,
        encoding: 'base32',
        token: code,
        window: 2
      });
    } catch (error) {
      console.error('Error verifying TOTP:', error);
      return false;
    }
  }

  static async generateSessionCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 100;

    const db = getDb();
    const usersRef = db.collection(Collections.USERS);

    while (!isUnique && attempts < maxAttempts) {
      const length = Math.floor(Math.random() * 6) + 3;
      code = '';
      for (let i = 0; i < length; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
      }

      const snapshot = await usersRef
        .where('sessionCode', '==', code)
        .limit(1)
        .get();

      if (snapshot.empty) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      throw new Error('Unable to generate unique session code after maximum attempts');
    }

    return code;
  }

  static async findUserBySessionCode(sessionCode) {
    try {
      const db = getDb();
      const usersRef = db.collection(Collections.USERS);
      
      const snapshot = await usersRef
        .where('sessionCode', '==', sessionCode)
        .where('isActive', '==', true)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return null;
      }

      const doc = snapshot.docs[0];
      return new User({
        id: doc.id,
        ...doc.data(),
      });
    } catch (error) {
      console.error('Error finding user by session code:', error);
      throw error;
    }
  }

  static async setSessionCode(userId, sessionCode) {
    try {
      if (!sessionCode || sessionCode.length < 3 || sessionCode.length > 8) {
        throw new Error('Session code must be between 3 and 8 characters');
      }

      const db = getDb();
      const usersRef = db.collection(Collections.USERS);

      const snapshot = await usersRef
        .where('sessionCode', '==', sessionCode)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const existingDoc = snapshot.docs[0];
        if (existingDoc.id !== userId) {
          throw new Error('Session code is already taken');
        }
      }

      const docRef = usersRef.doc(userId);
      await docRef.update({
        sessionCode,
        updatedAt: dateToTimestamp(new Date()),
      });

      return true;
    } catch (error) {
      console.error('Error setting session code:', error);
      throw error;
    }
  }

  static async clearSessionCode(userId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(userId);
      
      await docRef.update({
        sessionCode: null,
        updatedAt: dateToTimestamp(new Date()),
      });

      return true;
    } catch (error) {
      console.error('Error clearing session code:', error);
      throw error;
    }
  }

  /**
   * Add usage minutes to user's total
   * @param {string} userId - User ID
   * @param {number} minutes - Minutes to add
   */
  static async addUsageMinutes(userId, minutes) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(userId);
      
      await docRef.update({
        totalUsageMinutes: FieldValue.increment(minutes),
        lastActiveAt: dateToTimestamp(new Date()),
      });

      return true;
    } catch (error) {
      console.error('Error adding usage minutes:', error);
      return false;
    }
  }

  /**
   * Increment session count for user
   * @param {string} userId - User ID
   */
  static async incrementSessionCount(userId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(userId);
      
      await docRef.update({
        totalSessions: FieldValue.increment(1),
        lastActiveAt: dateToTimestamp(new Date()),
      });

      return true;
    } catch (error) {
      console.error('Error incrementing session count:', error);
      return false;
    }
  }

  /**
   * Update last active timestamp
   * @param {string} userId - User ID
   */
  static async updateLastActive(userId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(userId);
      
      await docRef.update({
        lastActiveAt: dateToTimestamp(new Date()),
      });

      return true;
    } catch (error) {
      console.error('Error updating last active:', error);
      return false;
    }
  }

  /**
   * Get usage stats for a user
   * @param {string} userId - User ID
   */
  static async getUsageStats(userId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.USERS).doc(userId);
      const doc = await docRef.get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      return {
        totalUsageMinutes: data.totalUsageMinutes || 0,
        totalSessions: data.totalSessions || 0,
        lastActiveAt: timestampToDate(data.lastActiveAt),
      };
    } catch (error) {
      console.error('Error getting usage stats:', error);
      throw error;
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      isActive: this.isActive,
      sessionCode: this.sessionCode,
      userCode: this.sessionCode, // backward compat for old frontend
      totpEnabled: this.totpEnabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      totalUsageMinutes: this.totalUsageMinutes,
      totalSessions: this.totalSessions,
      lastActiveAt: this.lastActiveAt,
    };
  }
}

module.exports = User;
