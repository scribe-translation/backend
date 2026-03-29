const { getDb, dateToTimestamp, timestampToDate } = require('../database/firestore');

const SERMONS_COLLECTION = 'sermons';

class Sermon {
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

  static async create(sermonData) {
    try {
      const db = getDb();
      const sermonsRef = db.collection(SERMONS_COLLECTION);
      
      const now = dateToTimestamp(new Date());
      const newSermon = {
        userId: sermonData.userId,
        fullText: sermonData.fullText,
        summary: sermonData.summary || null,
        facebookPost: sermonData.facebookPost || null,
        sourceLanguage: sermonData.sourceLanguage || 'en-US',
        createdAt: now,
        updatedAt: now,
      };

      const docRef = await sermonsRef.add(newSermon);
      
      return new Sermon({
        id: docRef.id,
        ...newSermon,
      });
    } catch (error) {
      console.error('❌ Error creating sermon:', error);
      throw error;
    }
  }

  static async update(id, updates) {
    try {
      const db = getDb();
      const docRef = db.collection(SERMONS_COLLECTION).doc(id);
      
      updates.updatedAt = dateToTimestamp(new Date());
      await docRef.update(updates);

      const updatedDoc = await docRef.get();
      return new Sermon({
        id: updatedDoc.id,
        ...updatedDoc.data(),
      });
    } catch (error) {
      console.error('❌ Error updating sermon:', error);
      throw error;
    }
  }

  static async findByUserId(userId, limit = 10) {
    try {
      const db = getDb();
      const sermonsRef = db.collection(SERMONS_COLLECTION);
      
      const snapshot = await sermonsRef
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      if (snapshot.empty) {
        return [];
      }

      return snapshot.docs.map(doc => new Sermon({
        id: doc.id,
        ...doc.data(),
      }));
    } catch (error) {
      console.error('❌ Error finding sermons by user:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const db = getDb();
      const doc = await db.collection(SERMONS_COLLECTION).doc(id).get();
      
      if (!doc.exists) {
        return null;
      }

      return new Sermon({
        id: doc.id,
        ...doc.data(),
      });
    } catch (error) {
      console.error('❌ Error finding sermon by ID:', error);
      throw error;
    }
  }

  static async delete(id) {
    try {
      const db = getDb();
      await db.collection(SERMONS_COLLECTION).doc(id).delete();
      return true;
    } catch (error) {
      console.error('❌ Error deleting sermon:', error);
      throw error;
    }
  }
}

module.exports = Sermon;
