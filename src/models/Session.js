const { getDb, dateToTimestamp, timestampToDate } = require('../database/firestore');

const SESSIONS_COLLECTION = 'sessions';

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
  }

  static async create(sessionData) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(SESSIONS_COLLECTION);
      
      const now = dateToTimestamp(new Date());
      const newSession = {
        userId: sessionData.userId,
        fullText: sessionData.fullText,
        summary: sessionData.summary || null,
        facebookPost: sessionData.facebookPost || null,
        sourceLanguage: sessionData.sourceLanguage || 'en-US',
        createdAt: now,
        updatedAt: now,
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
      const docRef = db.collection(SESSIONS_COLLECTION).doc(id);
      
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
      const sessionsRef = db.collection(SESSIONS_COLLECTION);
      
      const snapshot = await sessionsRef
        .where('userId', '==', userId)
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
      const doc = await db.collection(SESSIONS_COLLECTION).doc(id).get();
      
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
      await db.collection(SESSIONS_COLLECTION).doc(id).delete();
      return true;
    } catch (error) {
      console.error('❌ Error deleting session:', error);
      throw error;
    }
  }
}

module.exports = Session;
