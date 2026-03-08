const { Resend } = require('resend');
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = null;
    this.resend = null;
    this.initializeService();
  }

  initializeService() {
    // Resend (preferred when configured - reliable, free tier: 3000/month)
    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey) {
      this.resend = new Resend(resendApiKey);
      console.log('Resend email service initialized');
    }

    // SendGrid (production)
    const sendGridApiKey = process.env.SENDGRID_API_KEY;
    if (sendGridApiKey) {
      sgMail.setApiKey(sendGridApiKey);
      console.log('SendGrid email service initialized');
    }

    // Fallback to SMTP (development/production)
    const smtpConfig = {
      host: process.env.SMTP_HOST || 'smtpout.secureserver.net',
      port: process.env.SMTP_PORT || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER || process.env.EMAIL_USER,
        pass: process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.EMAIL_APP_PASSWORD
      },
      // GoDaddy specific settings
      name: 'scribe-ai.ca',
      tls: {
        rejectUnauthorized: false,
        ciphers: 'SSLv3'
      },
      // Additional GoDaddy requirements
      requireTLS: true,
      connectionTimeout: 60000,
      greetingTimeout: 30000,
      socketTimeout: 60000
    };

    // Check if we have SMTP credentials
    if (smtpConfig.auth.user && smtpConfig.auth.pass) {
      this.transporter = nodemailer.createTransport(smtpConfig);
      console.log('SMTP email service initialized');
    } else if (!this.resend && !sendGridApiKey) {
      console.warn('No email credentials found. Set RESEND_API_KEY, SENDGRID_API_KEY, or SMTP_USER/SMTP_PASS. Email service will log to console.');
    }
  }

  /**
   * Send password reset email
   * @param {string} to - Recipient email
   * @param {string} resetToken - Password reset token
   * @param {string} userName - User's name
   * @param {string} subdomain - Subdomain (speaker or listener)
   * @returns {Promise<Object>}
   */
  async sendPasswordResetEmail(to, resetToken, userName, subdomain = 'speaker') {
    try {
      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      
      // Handle production URLs properly
      let resetUrl;
      if (baseUrl.includes('localhost')) {
        // Development: replace localhost with subdomain.localhost
        resetUrl = `${baseUrl.replace('localhost', `${subdomain}.localhost`)}/reset-password?token=${resetToken}`;
      } else {
        // Production: use subdomain.scribe-ai.ca
        resetUrl = `https://${subdomain}.scribe-ai.ca/reset-password?token=${resetToken}`;
      }
      
      const msg = {
        to: to,
        from: process.env.FROM_EMAIL || 'noreply@scribe-ai.ca',
        subject: 'Password Reset Request - Scribe AI',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Password Reset</title>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #f8f9fa; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }                                                                                                           
              .content { background: #ffffff; padding: 30px; border: 1px solid #e9ecef; }
              .footer { background: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 14px; color: #6c757d; }                                                                          
              .button { 
                display: inline-block; 
                background: #007bff; 
                color: white; 
                padding: 12px 24px; 
                text-decoration: none; 
                border-radius: 5px; 
                margin: 20px 0;
              }
              .button:hover { background: #0056b3; }
              .warning { 
                background: #fff3cd; 
                border: 1px solid #ffeaa7; 
                color: #856404; 
                padding: 15px; 
                border-radius: 5px; 
                margin: 20px 0;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🔐 Password Reset Request</h1>
              </div>
              <div class="content">
                <h2>Hello ${userName}!</h2>
                <p>We received a request to reset your password for your Scribe AI account.</p>
                <p>Click the button below to reset your password:</p>
                <div style="text-align: center;">
                  <a href="${resetUrl}" class="button">Reset My Password</a>
                </div>
                <p>Or copy and paste this link into your browser:</p>
                <p style="word-break: break-all; background: #f8f9fa; padding: 10px; border-radius: 5px;">
                  ${resetUrl}
                </p>
                <div class="warning">
                  <strong>⚠️ Important:</strong>
                  <ul>
                    <li>This link will expire in 1 hour</li>
                    <li>If you didn't request this reset, please ignore this email</li>
                    <li>For security, this link can only be used once</li>
                  </ul>
                </div>
              </div>
              <div class="footer">
                <p>This email was sent from Scribe AI. If you have any questions, please contact support.</p>                                                                                                           
                <p>&copy; ${new Date().getFullYear()} Scribe AI. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `,
        text: `
          Password Reset Request - Scribe AI
          
          Hello ${userName}!
          
          We received a request to reset your password for your Scribe AI account.
          
          Click the link below to reset your password:
          ${resetUrl}
          
          This link will expire in 1 hour.
          If you didn't request this reset, please ignore this email.
          For security, this link can only be used once.
          
          Best regards,
          The Scribe AI Team
        `
      };

      // Try Resend first (reliable, free tier)
      if (this.resend) {
        const { data, error } = await this.resend.emails.send({
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text
        });
        if (error) throw error;
        console.log('Password reset email sent via Resend:', data?.id);
        return data;
      }

      // Try SendGrid (production)
      if (process.env.SENDGRID_API_KEY) {
        const info = await sgMail.send(msg);
        console.log('Password reset email sent via SendGrid:', info[0].headers['x-message-id']);
        return info[0];
      }

      // Try SMTP (development)
      if (this.transporter) {
        const info = await this.transporter.sendMail(msg);
        console.log('Password reset email sent via SMTP:', info.messageId);
        return info;
      }

      // Fallback: log to console
      console.log('📧 EMAIL (No credentials - Development Mode):');
      console.log('To:', to);
      console.log('Subject:', msg.subject);
      console.log('Reset URL:', resetUrl);
      console.log('---');
      return { messageId: 'dev-' + Date.now() };
    } catch (error) {
      console.error('Error sending password reset email:', error);
      throw error;
    }
  }

  /**
   * Send welcome email (optional)
   * @param {string} to - Recipient email
   * @param {string} userName - User's name
   * @returns {Promise<Object>}
   */
  async sendWelcomeEmail(to, userName) {
    try {
      const msg = {
        to: to,
        from: process.env.FROM_EMAIL || 'noreply@scribe-ai.ca',
        subject: 'Welcome to Scribe AI!',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Welcome to Scribe AI</title>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #f8f9fa; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }                                                                                                           
              .content { background: #ffffff; padding: 30px; border: 1px solid #e9ecef; }
              .footer { background: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 14px; color: #6c757d; }                                                                          
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🎉 Welcome to Scribe AI!</h1>
              </div>
              <div class="content">
                <h2>Hello ${userName}!</h2>
                <p>Thank you for joining Scribe AI! We're excited to have you on board.</p>
                <p>You can now start using all the features of our platform.</p>
                <p>If you have any questions, feel free to reach out to our support team.</p>
              </div>
              <div class="footer">
                <p>&copy; ${new Date().getFullYear()} Scribe AI. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `
      };

      // Try Resend first
      if (this.resend) {
        const { data, error } = await this.resend.emails.send({
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html
        });
        if (error) throw error;
        console.log('Welcome email sent via Resend:', data?.id);
        return data;
      }

      // Try SendGrid (production)
      if (process.env.SENDGRID_API_KEY) {
        const info = await sgMail.send(msg);
        console.log('Welcome email sent via SendGrid:', info[0].headers['x-message-id']);
        return info[0];
      }

      // Try SMTP (development)
      if (this.transporter) {
        const info = await this.transporter.sendMail(msg);
        console.log('Welcome email sent via SMTP:', info.messageId);
        return info;
      }

      // Fallback: log to console
      console.log('📧 WELCOME EMAIL (No credentials - Development Mode):');
      console.log('To:', to);
      console.log('Subject:', msg.subject);
      console.log('---');
      return { messageId: 'dev-' + Date.now() };
    } catch (error) {
      console.error('Error sending welcome email:', error);
      throw error;
    }
  }

  /**
   * Test email configuration
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      const from = process.env.FROM_EMAIL || 'noreply@scribe-ai.ca';

      if (this.resend) {
        const { error } = await this.resend.emails.send({
          from,
          to: 'test@example.com',
          subject: 'Test Email',
          text: 'This is a test email'
        });
        if (error) throw error;
        console.log('Email service is ready (Resend)');
        return true;
      }

      if (process.env.SENDGRID_API_KEY) {
        await sgMail.send({
          to: 'test@example.com',
          from,
          subject: 'Test Email',
          text: 'This is a test email'
        });
        console.log('Email service is ready (SendGrid)');
        return true;
      }

      console.log('Email service ready (development mode)');
      return true;
    } catch (error) {
      console.error('Email service connection failed:', error);
      return false;
    }
  }
}

module.exports = new EmailService();