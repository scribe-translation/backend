const express = require('express');
const User = require('../models/User');
const Session = require('../models/Session');
const AppSettings = require('../models/AppSettings');
const { getLiveConnectionsSnapshot } = require('../services/connectionRegistry');

const router = express.Router();

/**
 * @route GET /admin/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const userStats = await User.getAdminStats();
    const live = getLiveConnectionsSnapshot();

    res.json({
      ...userStats,
      liveConnectionCount: live.totalConnections,
      streamingCount: live.streamingCount,
      activeSessionGroups: live.groups.length,
    });
  } catch (error) {
    console.error('Admin stats error:', error.message);
    res.status(500).json({ error: 'Failed to load admin stats', message: error.message });
  }
});

/**
 * @route GET /admin/users
 */
router.get('/users', async (req, res) => {
  try {
    const users = await User.getAllUsers();
    res.json({ users });
  } catch (error) {
    console.error('Admin users error:', error.message);
    res.status(500).json({ error: 'Failed to load users', message: error.message });
  }
});

/**
 * @route PATCH /admin/users/:id
 * Body: { isActive?: boolean, clearSessionCode?: boolean, confirm?: boolean }
 */
router.patch('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive, clearSessionCode, confirm } = req.body;

    if (id === req.user.id && isActive === false) {
      return res.status(400).json({
        error: 'Cannot deactivate your own admin account',
        code: 'SELF_DEACTIVATE',
      });
    }

    const target = await User.findUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    if (clearSessionCode === true) {
      if (confirm !== true) {
        return res.status(400).json({
          error: 'Confirmation required to clear session code',
          code: 'CONFIRM_REQUIRED',
        });
      }
      await User.clearSessionCode(id);
    }

    if (isActive === false) {
      await User.deactivateUser(id);
    } else if (isActive === true) {
      await User.reactivateUser(id);
    }

    const updated = await User.findUserById(id);
    res.json({
      message: 'User updated',
      user: updated.toJSON(),
    });
  } catch (error) {
    console.error('Admin patch user error:', error.message);
    res.status(500).json({ error: 'Failed to update user', message: error.message });
  }
});

/**
 * @route GET /admin/live-connections
 */
router.get('/live-connections', (req, res) => {
  try {
    const snapshot = getLiveConnectionsSnapshot();
    res.json(snapshot);
  } catch (error) {
    console.error('Admin live connections error:', error.message);
    res.status(500).json({ error: 'Failed to load live connections', message: error.message });
  }
});

/**
 * @route GET /admin/sessions
 * Query: email or userId, limit, startDate, endDate
 */
router.get('/sessions', async (req, res) => {
  try {
    const { email, userId: userIdQuery, limit, startDate, endDate } = req.query;

    let userId = userIdQuery;
    if (!userId && email) {
      const user = await User.findUserByEmail(String(email));
      if (!user) {
        return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      }
      userId = user.id;
    }

    if (!userId) {
      return res.status(400).json({
        error: 'email or userId query parameter is required',
        code: 'MISSING_USER',
      });
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);
    const sessions = await Session.findForAdmin({
      userId,
      limit: parsedLimit,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });

    res.json({
      userId,
      sessions: sessions.map((s) => ({
        id: s.id,
        userId: s.userId,
        fullText: s.fullText,
        summary: s.summary,
        sourceLanguage: s.sourceLanguage,
        characterCount: s.characterCount,
        isActive: s.isActive,
        createdAt: s.createdAt,
      })),
    });
  } catch (error) {
    console.error('Admin sessions error:', error.message);
    res.status(500).json({ error: 'Failed to load sessions', message: error.message });
  }
});

/**
 * @route GET /admin/settings
 */
router.get('/settings', async (req, res) => {
  try {
    const settings = await AppSettings.getAll();
    res.json({ settings });
  } catch (error) {
    console.error('Admin get settings error:', error.message);
    res.status(500).json({ error: 'Failed to load settings', message: error.message });
  }
});

/**
 * @route PATCH /admin/settings
 */
router.patch('/settings', async (req, res) => {
  try {
    const { interimTranslationEnabled } = req.body;
    if (interimTranslationEnabled === undefined) {
      return res.status(400).json({
        error: 'No settings provided',
        code: 'MISSING_SETTINGS',
      });
    }

    const settings = await AppSettings.update({ interimTranslationEnabled });
    res.json({ message: 'Settings updated', settings });
  } catch (error) {
    console.error('Admin patch settings error:', error.message);
    res.status(500).json({ error: 'Failed to update settings', message: error.message });
  }
});

module.exports = router;
