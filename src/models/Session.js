const { getDb, Collections, timestampToDate, dateToTimestamp } = require('../database/firestore');
const { FieldValue } = require('@google-cloud/firestore');

class Session {
  constructor(data) {
    this.id = data.id;
    this.userId = data.userId;
    this.fullText = data.fullText;
    this.summary = data.summary;
    this.facebookPost = data.facebookPost;
    this.sourceLanguage = data.sourceLanguage;
    this.createdAt = timestampToDate(data.createdAt);
    this.updatedAt = timestampToDate(data.updatedAt);
    this.characterCount = data.characterCount || 0;
    this.isActive = data.isActive !== undefined ? data.isActive : true;
  }

  static async create(sessionData) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const now = dateToTimestamp(new Date());
      const newSession = {
        userId: sessionData.userId,
        fullText: sessionData.fullText,
        summary: sessionData.summary || null,
        facebookPost: sessionData.facebookPost || null,
        sourceLanguage: sessionData.sourceLanguage || 'en-US',
        createdAt: now,
        updatedAt: now,
        characterCount: sessionData.characterCount || 0,
        isActive: true,
      };

      const docRef = await sessionsRef.add(newSession);
      
      return new Session({
        id: docRef.id,
        ...newSession,
      });
    } catch (error) {
      console.error('❌ Error creating session:', error);
      throw error;
    }
  }

  static async update(id, updates) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.SESSIONS).doc(id);
      
      updates.updatedAt = dateToTimestamp(new Date());
      await docRef.update(updates);

      const updatedDoc = await docRef.get();
      return new Session({
        id: updatedDoc.id,
        ...updatedDoc.data(),
      });
    } catch (error) {
      console.error('❌ Error updating session:', error);
      throw error;
    }
  }

  static async findByUserId(userId, limit = 10) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const snapshot = await sessionsRef
        .where('userId', '==', userId)
        .where('isActive', '==', true)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      if (snapshot.empty) {
        return [];
      }

      return snapshot.docs.map(doc => new Session({
        id: doc.id,
        ...doc.data(),
      }));
    } catch (error) {
      console.error('❌ Error finding sessions by user:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const db = getDb();
      const doc = await db.collection(Collections.SESSIONS).doc(id).get();
      
      if (!doc.exists) {
        return null;
      }

      return new Session({
        id: doc.id,
        ...doc.data(),
      });
    } catch (error) {
      console.error('❌ Error finding session by ID:', error);
      throw error;
    }
  }

  static async delete(id) {
    try {
      const db = getDb();
      await db.collection(Collections.SESSIONS).doc(id).delete();
      return true;
    } catch (error) {
      console.error('❌ Error deleting session:', error);
      throw error;
    }
  }

  static async updateCharacterCount(characterCount, sessionId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.SESSIONS).doc(sessionId);
      
      await docRef.update({
        characterCount: FieldValue.increment(characterCount),
        updatedAt: dateToTimestamp(new Date()),
      });
      
      return true;
    } catch (error) {
      console.error('❌ Error updating character count:', error);
      return false;
    }
  }

  static async deactivate(sessionId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.SESSIONS).doc(sessionId);
      
      await docRef.update({
        isActive: false,
        updatedAt: dateToTimestamp(new Date()),
      });
      
      return true;
    } catch (error) {
      console.error('❌ Error deactivating session:', error);
      return false;
    }
  }

  static async deactivateAllForUser(userId) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const snapshot = await sessionsRef
        .where('userId', '==', userId)
        .where('isActive', '==', true)
        .get();

      if (snapshot.empty) return true;

      const batch = db.batch();
      const now = dateToTimestamp(new Date());
      snapshot.docs.forEach(doc => {
        batch.update(doc.ref, { 
          isActive: false,
          updatedAt: now
        });
      });
      
      await batch.commit();
      return true;
    } catch (error) {
      console.error('❌ Error deactivating sessions for user:', error);
      return false;
    }
  }

  static async deactivateAllForUserExcept(userId, exceptSessionId) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const snapshot = await sessionsRef
        .where('userId', '==', userId)
        .where('isActive', '==', true)
        .get();

      if (snapshot.empty) return true;

      const batch = db.batch();
      const now = dateToTimestamp(new Date());
      snapshot.docs.forEach(doc => {
        if (doc.id !== exceptSessionId) {
          batch.update(doc.ref, { 
            isActive: false,
            updatedAt: now
          });
        }
      });
      
      await batch.commit();
      return true;
    } catch (error) {
      console.error('❌ Error deactivating sessions for user except current:', error);
      return false;
    }
  }
}

module.exports = Session;
