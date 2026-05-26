const express = require('express');
const { body, validationResult } = require('express-validator');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const CryptoJS = require('crypto-js');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const PasswordResetToken = require('../models/PasswordResetToken');
const emailService = require('../services/emailService');
const { generateToken, generateRefreshToken, authenticateToken } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

const validateRegistration = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
  body('name')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters')
];

const validateLogin = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
];

const handleGetSessionCode = async (req, res) => {
  try {
    const user = await User.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.json({
      sessionCode: user.sessionCode,
      userCode: user.sessionCode, // backward compat
      hasCode: !!user.sessionCode
    });

  } catch (error) {
    console.error('Get session code error:', error.message);
    res.status(500).json({
      error: 'Failed to get session code',
      message: error.message
    });
  }
};

const handleGenerateSessionCode = async (req, res) => {
  try {
    const userId = req.user.id;

    const sessionCode = await User.generateSessionCode();
    await User.setSessionCode(userId, sessionCode);

    res.json({
      message: 'Session code generated successfully',
      sessionCode,
      userCode: sessionCode, // backward compat
    });

  } catch (error) {
    console.error('Generate session code error:', error.message);
    res.status(500).json({
      error: 'Failed to generate session code',
      message: error.message
    });
  }
};

const setSessionCodeValidation = [
  body('sessionCode').optional().isLength({ min: 3, max: 8 }).matches(/^[A-Z0-9]+$/),
  body('userCode').optional().isLength({ min: 3, max: 8 }).matches(/^[A-Z0-9]+$/),
];

const handleSetSessionCode = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const sessionCode = req.body.sessionCode || req.body.userCode;
    if (!sessionCode) {
      return res.status(400).json({
        error: 'Session code is required',
        code: 'MISSING_SESSION_CODE'
      });
    }

    const userId = req.user.id;
    await User.setSessionCode(userId, sessionCode);

    res.json({
      message: 'Session code set successfully',
      sessionCode,
      userCode: sessionCode, // backward compat
    });

  } catch (error) {
    console.error('Set session code error:', error.message);

    if (error.message === 'Session code is already taken') {
      return res.status(409).json({
        error: 'Session code is already taken',
        code: 'CODE_TAKEN'
      });
    }

    res.status(500).json({
      error: 'Failed to set session code',
      message: error.message
    });
  }
};

const handleClearSessionCode = async (req, res) => {
  try {
    const userId = req.user.id;
    await User.clearSessionCode(userId);

    res.json({
      message: 'Session code cleared successfully'
    });

  } catch (error) {
    console.error('Clear session code error:', error.message);
    res.status(500).json({
      error: 'Failed to clear session code',
      message: error.message
    });
  }
};

const handleGetUserBySessionCode = async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({
        error: 'Session code is required',
        code: 'MISSING_SESSION_CODE'
      });
    }

    const user = await User.findUserBySessionCode(code);
    if (!user) {
      return res.status(404).json({
        error:
          'No active session found for this code. Ask your speaker for the current code and try again.',
        code: 'USER_NOT_FOUND'
      });
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        sessionCode: user.sessionCode,
        userCode: user.sessionCode, // backward compat
      }
    });

  } catch (error) {
    console.error('Get user by session code error:', error.message);
    res.status(500).json({
      error: 'Failed to get user by session code',
      message: error.message
    });
  }
};

router.get('/session-code', authenticateToken, handleGetSessionCode);
router.get('/user-code', authenticateToken, handleGetSessionCode);
router.get('/user-by-session-code', handleGetUserBySessionCode);
router.get('/user-by-code', handleGetUserBySessionCode);

router.post('/generate-session-code', authenticateToken, handleGenerateSessionCode);
router.post('/generate-user-code', authenticateToken, handleGenerateSessionCode);
router.post('/set-session-code', authenticateToken, setSessionCodeValidation, handleSetSessionCode);
router.post('/set-user-code', authenticateToken, setSessionCodeValidation, handleSetSessionCode);

router.delete('/session-code', authenticateToken, handleClearSessionCode);
router.delete('/user-code', authenticateToken, handleClearSessionCode);

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user
 * @access  Public
 */
router.post('/register', validateRegistration, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { email, password, name } = req.body;

    const existingUser = await User.findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        error: 'User with this email already exists',
        code: 'USER_EXISTS'
      });
    }

    const salt = CryptoJS.lib.WordArray.random(32).toString();
    const hashedPassword = CryptoJS.PBKDF2(password, salt, {
      keySize: 256 / 32,
      iterations: 10000
    }).toString();
    
    const finalPasswordHash = `${hashedPassword}:${salt}`;
    const user = await User.create(name, email, finalPasswordHash);

    let sessionCode = null;
    try {
      sessionCode = await User.generateSessionCode();
      await User.setSessionCode(user.id, sessionCode);
    } catch (error) {
      console.error('Failed to generate session code for new user:', error);
    }

    const accessToken = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        sessionCode: sessionCode,
        userCode: sessionCode, // backward compat
        createdAt: user.createdAt
      },
      tokens: {
        accessToken,
        refreshToken
      }
    });

  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({
      error: 'Registration failed',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/auth/login
 * @desc    Login user
 * @access  Public
 */
router.post('/login', validateLogin, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { email, password } = req.body;

    const user = await User.findUserByEmail(email);
    if (!user || !user.isActive) {
      return res.status(401).json({
        error: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS'
      });
    }

      if (user.passwordHash.includes(':')) {
        const [storedHash, storedSalt] = user.passwordHash.split(':');
        
        const providedHash = CryptoJS.PBKDF2(password, storedSalt, {
          keySize: 256 / 32,
          iterations: 10000
        }).toString();
      
        
        const isValidPassword = (providedHash === storedHash);
      
      if (!isValidPassword) {
        return res.status(401).json({
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS'
        });
      }
    } else {
      const isValidPassword = await bcrypt.compare(password, user.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS'
        });
      }
    }

    let sessionCode = user.sessionCode;
    if (!sessionCode) {
      try {
        sessionCode = await User.generateSessionCode();
        await User.setSessionCode(user.id, sessionCode);
      } catch (error) {
        console.error('Failed to generate session code for existing user:', error);
      }
    }

    const accessToken = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        sessionCode: sessionCode,
        userCode: sessionCode, // backward compat
        createdAt: user.createdAt,
        totpEnabled: user.totpEnabled,
        totalSessions: user.totalSessions || 0,
        totalUsageMinutes: user.totalUsageMinutes || 0
      },
      tokens: {
        accessToken,
        refreshToken
      }
    });

  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({
      error: 'Login failed',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: 'Refresh token is required',
        code: 'MISSING_REFRESH_TOKEN'
      });
    }

    const { verifyRefreshToken, generateToken } = require('../middleware/auth');
    const decoded = verifyRefreshToken(refreshToken);
    
    const user = await User.findUserById(decoded.userId);
    if (!user || !user.isActive) {
      return res.status(403).json({
        error: 'User not found or deactivated',
        code: 'USER_NOT_FOUND'
      });
    }

    const newAccessToken = generateToken(user);

    res.json({
      message: 'Token refreshed successfully',
      tokens: {
        accessToken: newAccessToken,
        refreshToken
      }
    });

  } catch (error) {
    console.error('Token refresh error:', error.message);
    
    res.status(403).json({
      error: 'Invalid refresh token',
      code: 'INVALID_REFRESH_TOKEN'
    });
  }
});

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user (client-side token removal)
 * @access  Private
 */
router.post('/logout', authenticateToken, (req, res) => {
  res.json({
    message: 'Logout successful'
  });
});

/**
 * @route   GET /api/auth/me
 * @desc    Get current user profile
 * @access  Private
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        sessionCode: user.sessionCode,
        userCode: user.sessionCode, // backward compat
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        totpEnabled: user.totpEnabled,
        totalSessions: user.totalSessions || 0,
        totalUsageMinutes: user.totalUsageMinutes || 0
      }
    });
  } catch (error) {
    console.error('Get user profile error:', error.message);
    res.status(500).json({
      error: 'Failed to get user profile',
      message: error.message
    });
  }
});


/**
 * @route   POST /api/auth/forgot-password-totp
 * @desc    Initiate TOTP-based password reset
 * @access  Public
 */
router.post('/forgot-password-totp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email is required',
        code: 'MISSING_EMAIL'
      });
    }

    // Check if user exists and has TOTP enabled
    const user = await User.findUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    // Check if user has TOTP enabled
    if (!user.totpSecret) {
      return res.status(400).json({
        error: 'TOTP not enabled for this account',
        code: 'TOTP_NOT_ENABLED',
        message: 'Please enable two-factor authentication in your profile first'
      });
    }

    // Store the session temporarily for password reset
    if (!global.totpSecrets) {
      global.totpSecrets = new Map();
    }
    global.totpSecrets.set(email, {
      secret: user.totpSecret,
      expires: Date.now() + 10 * 60 * 1000 // 10 minutes
    });

    res.json({
      message: 'TOTP verification initiated'
    });

  } catch (error) {
    console.error('TOTP forgot password error:', error.message);
    res.status(500).json({
      error: 'Failed to initiate TOTP password reset',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/auth/verify-totp
 * @desc    Verify TOTP code for password reset
 * @access  Public
 */
router.post('/verify-totp', async (req, res) => {
  try {
    const { email, totpCode } = req.body;

    if (!email || !totpCode) {
      return res.status(400).json({
        error: 'Email and TOTP code are required',
        code: 'MISSING_FIELDS'
      });
    }

    // Get stored secret
    if (!global.totpSecrets || !global.totpSecrets.has(email)) {
      return res.status(400).json({
        error: 'TOTP session expired or not found',
        code: 'SESSION_EXPIRED'
      });
    }

    const totpData = global.totpSecrets.get(email);
    
    // Check if session expired
    if (Date.now() > totpData.expires) {
      global.totpSecrets.delete(email);
      return res.status(400).json({
        error: 'TOTP session expired',
        code: 'SESSION_EXPIRED'
      });
    }

    // Verify TOTP code
    const verified = speakeasy.totp.verify({
      secret: totpData.secret,
      encoding: 'base32',
      token: totpCode,
      window: 2 // Allow 2 time steps (60 seconds) tolerance
    });

    if (!verified) {
      return res.status(400).json({
        error: 'Invalid TOTP code',
        code: 'INVALID_TOTP'
      });
    }

    // Mark as verified
    totpData.verified = true;
    global.totpSecrets.set(email, totpData);

    res.json({
      message: 'TOTP code verified successfully'
    });

  } catch (error) {
    console.error('TOTP verification error:', error.message);
    res.status(500).json({
      error: 'Failed to verify TOTP code',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/auth/reset-password-totp
 * @desc    Reset password using verified TOTP
 * @access  Public
 */
router.post('/reset-password-totp', async (req, res) => {
  try {
    const { email, totpCode, password } = req.body;

    if (!email || !totpCode || !password) {
      return res.status(400).json({
        error: 'Email, TOTP code, and password are required',
        code: 'MISSING_FIELDS'
      });
    }

    if (!global.totpSecrets || !global.totpSecrets.has(email)) {
      return res.status(400).json({
        error: 'TOTP session expired or not found',
        code: 'SESSION_EXPIRED'
      });
    }

    const totpData = global.totpSecrets.get(email);
    
    if (Date.now() > totpData.expires) {
      global.totpSecrets.delete(email);
      return res.status(400).json({
        error: 'TOTP session expired',
        code: 'SESSION_EXPIRED'
      });
    }

    const verified = speakeasy.totp.verify({
      secret: totpData.secret,
      encoding: 'base32',
      token: totpCode,
      window: 2
    });

    if (!verified) {
      return res.status(400).json({
        error: 'Invalid TOTP code',
        code: 'INVALID_TOTP'
      });
    }

    const user = await User.findUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

      const salt = CryptoJS.lib.WordArray.random(32).toString();
      const hashedPassword = CryptoJS.PBKDF2(password, salt, {
        keySize: 256 / 32,
        iterations: 10000
      }).toString();
      
      const finalPasswordHash = `${hashedPassword}:${salt}`;
      
      await User.updatePassword(user.id, finalPasswordHash);

    global.totpSecrets.delete(email);

    res.json({
      message: 'Password reset successfully'
    });

  } catch (error) {
    console.error('TOTP password reset error:', error.message);
    res.status(500).json({
      error: 'Failed to reset password',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/auth/setup-totp
 * @desc    Generate TOTP secret for user setup
 * @access  Private
 */
router.post('/setup-totp', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    // Check if user already has TOTP enabled
    const user = await User.findUserById(userId);
    if (user && user.totpEnabled) {
      return res.status(400).json({
        error: 'TOTP already enabled for this account',
        code: 'TOTP_ALREADY_ENABLED'
      });
    }

    // Generate TOTP secret
    const secret = speakeasy.generateSecret({
      name: `Scribe (${userEmail})`,
      issuer: 'Scribe AI',
      length: 32
    });

    // Generate QR code
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    // Store the secret temporarily for verification
    if (!global.totpSecrets) {
      global.totpSecrets = new Map();
    }
    global.totpSecrets.set(`setup_${userId}`, {
      secret: secret.base32,
      expires: Date.now() + 10 * 60 * 1000 // 10 minutes
    });

    res.json({
      message: 'TOTP secret generated',
      qrCodeUrl,
      secretKey: secret.base32
    });

  } catch (error) {
    console.error('TOTP setup error:', error.message);
    res.status(500).json({
      error: 'Failed to generate TOTP secret',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/auth/verify-totp-setup
 * @desc    Verify TOTP code and enable TOTP for user
 * @access  Private
 */
router.post('/verify-totp-setup', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        error: 'Verification code is required',
        code: 'MISSING_CODE'
      });
    }

    // Get stored secret
    const setupKey = `setup_${userId}`;
    if (!global.totpSecrets || !global.totpSecrets.has(setupKey)) {
      return res.status(400).json({
        error: 'TOTP setup session expired',
        code: 'SESSION_EXPIRED'
      });
    }

    const totpData = global.totpSecrets.get(setupKey);
    
    // Check if session expired
    if (Date.now() > totpData.expires) {
      global.totpSecrets.delete(setupKey);
      return res.status(400).json({
        error: 'TOTP setup session expired',
        code: 'SESSION_EXPIRED'
      });
    }

    // Verify TOTP code
    const verified = speakeasy.totp.verify({
      secret: totpData.secret,
      encoding: 'base32',
      token: code,
      window: 2
    });

    if (!verified) {
      return res.status(400).json({
        error: 'Invalid verification code',
        code: 'INVALID_TOTP'
      });
    }

    // Generate backup codes
    const backupCodes = Array.from({ length: 10 }, () => 
      Math.random().toString(36).substring(2, 8).toUpperCase()
    );

    // Enable TOTP for user
    await User.enableTOTP(userId, totpData.secret, backupCodes);

    // Clean up setup session
    global.totpSecrets.delete(setupKey);

    res.json({
      message: 'TOTP enabled successfully',
      backupCodes
    });

  } catch (error) {
    console.error('TOTP verification error:', error.message);
    res.status(500).json({
      error: 'Failed to verify TOTP setup',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/auth/forgot-password-email
 * @desc    Send password reset email
 * @access  Public
 */
router.post('/forgot-password-email', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email is required',
        code: 'MISSING_EMAIL'
      });
    }

    // Check if user exists
    const user = await User.findUserByEmail(email);
    if (!user || !user.isActive) {
      // Don't reveal if user exists or not for security
      return res.json({
        message: 'If an account with that email exists, a password reset link has been sent.'
      });
    }

    // Create password reset token
    const resetToken = await PasswordResetToken.create(user.id, 60); // 1 hour expiry

    // Determine subdomain from request origin
    const origin = req.get('Origin') || req.get('Referer') || '';
    const subdomain = origin.includes('speaker.localhost') ? 'speaker' : 
                     origin.includes('listener.localhost') ? 'listener' : 'speaker';

    // Send email
    await emailService.sendPasswordResetEmail(user.email, resetToken.token, user.name, subdomain);

    res.json({
      message: 'If an account with that email exists, a password reset link has been sent.'
    });

  } catch (error) {
    console.error('Email password reset error:', error.message);
    res.status(500).json({
      error: 'Failed to send password reset email',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/auth/reset-password-email
 * @desc    Reset password using email token
 * @access  Public
 */
router.post('/reset-password-email', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        error: 'Token and password are required',
        code: 'MISSING_FIELDS'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long',
        code: 'INVALID_PASSWORD'
      });
    }

    // Find valid token
    const resetToken = await PasswordResetToken.findByToken(token);
    if (!resetToken) {
      return res.status(400).json({
        error: 'Invalid or expired reset token',
        code: 'INVALID_TOKEN'
      });
    }

    // Get user
    const user = await User.findUserById(resetToken.userId);
    if (!user) {
      return res.status(400).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    // Generate new salt and hash the password
    const salt = CryptoJS.lib.WordArray.random(32).toString();
    const hashedPassword = CryptoJS.PBKDF2(password, salt, {
      keySize: 256 / 32,
      iterations: 10000
    }).toString();
    
    const finalPasswordHash = `${hashedPassword}:${salt}`;

    // Update password
    await User.updatePassword(user.id, finalPasswordHash);

    // Mark token as used
    await PasswordResetToken.markAsUsed(token);

    res.json({
      message: 'Password reset successfully'
    });

  } catch (error) {
    console.error('Email password reset error:', error.message);
    res.status(500).json({
      error: 'Failed to reset password',
      message: error.message
    });
  }
});

/**
 * @route   GET /api/auth/verify-reset-token
 * @desc    Verify if reset token is valid
 * @access  Public
 */
router.get('/verify-reset-token', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        error: 'Token is required',
        code: 'MISSING_TOKEN'
      });
    }

    const resetToken = await PasswordResetToken.findByToken(token);
    if (!resetToken) {
      return res.status(400).json({
        error: 'Invalid or expired reset token',
        code: 'INVALID_TOKEN'
      });
    }

    res.json({
      valid: true,
      message: 'Token is valid'
    });

  } catch (error) {
    console.error('Token verification error:', error.message);
    res.status(500).json({
      error: 'Failed to verify token',
      message: error.message
    });
  }
});

/**
 * @route   GET /api/auth/connection-info
 * @desc    Get connection information for QR code and sharing
 * @access  Private
 */
router.get('/connection-info', authenticateToken, async (req, res) => {
  try {
    const user = await User.findUserById(req.user.id);
    if (!user || !user.sessionCode) {
      return res.status(404).json({
        error: 'Session code not found',
        code: 'NO_SESSION_CODE'
      });
    }

    const translationUrl = config.TRANSLATION_URL || `${req.protocol}://${req.get('host')}`;
    const connectionUrl = `${translationUrl}?code=${user.sessionCode}`;
    
    const QRCode = require('qrcode');
    const qrCodeUrl = await QRCode.toDataURL(connectionUrl);

    res.json({
      sessionCode: user.sessionCode,
      userCode: user.sessionCode, // backward compat
      connectionUrl,
      qrCodeUrl,
      shareText: `Join my Scribe session: ${connectionUrl}`
    });

  } catch (error) {
    console.error('Get connection info error:', error.message);
    res.status(500).json({
      error: 'Failed to get connection info',
      message: error.message
    });
  }
});

module.exports = router;
