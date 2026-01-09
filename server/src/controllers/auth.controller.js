const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const isProduction = process.env.NODE_ENV === 'production';

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
};

// Cookie options for httpOnly token
const getCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/'
});

const authController = {
  // Register new user
  async register(req, res, next) {
    try {
      const { email, password, name, phone } = req.body;

      // Check if user exists
      const existingUser = await prisma.user.findUnique({
        where: { email }
      });

      if (existingUser) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 12);

      // Create user with wallet
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          phone,
          wallet: {
            create: {
              balance: 0
            }
          }
        },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          createdAt: true
        }
      });

      const token = generateToken(user.id);

      // Set httpOnly cookie
      res.cookie('token', token, getCookieOptions());

      res.status(201).json({
        message: 'Registration successful',
        user,
        token // Also return token for backward compatibility
      });
    } catch (error) {
      next(error);
    }
  },

  // Login user with account lockout protection
  async login(req, res, next) {
    try {
      const { email, password } = req.body;

      const user = await prisma.user.findUnique({
        where: { email },
        include: {
          wallet: {
            select: { balance: true }
          }
        }
      });

      if (!user) {
        // Don't reveal if email exists or not
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check if account is locked
      if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
        const remainingMinutes = Math.ceil((new Date(user.lockedUntil) - new Date()) / 60000);
        return res.status(423).json({ 
          error: `Account locked. Try again in ${remainingMinutes} minutes.` 
        });
      }

      if (!user.isActive) {
        return res.status(403).json({ error: 'Account is deactivated' });
      }

      const isValidPassword = await bcrypt.compare(password, user.password);

      if (!isValidPassword) {
        // Track failed login attempts
        const failedAttempts = (user.failedLoginAttempts || 0) + 1;
        const MAX_ATTEMPTS = 5;
        
        if (failedAttempts >= MAX_ATTEMPTS) {
          // Lock account for 15 minutes
          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedLoginAttempts: failedAttempts,
              lockedUntil: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
            }
          });
          return res.status(423).json({ 
            error: 'Account locked due to too many failed attempts. Try again in 15 minutes.' 
          });
        } else {
          await prisma.user.update({
            where: { id: user.id },
            data: { failedLoginAttempts: failedAttempts }
          });
        }
        
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Reset failed attempts on successful login
      if (user.failedLoginAttempts > 0 || user.lockedUntil) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: 0,
            lockedUntil: null
          }
        });
      }

      const token = generateToken(user.id);

      // Set httpOnly cookie
      res.cookie('token', token, getCookieOptions());

      res.json({
        message: 'Login successful',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          balance: user.wallet?.balance || 0
        },
        token // Also return token for backward compatibility
      });
    } catch (error) {
      next(error);
    }
  },

  // Refresh token
  async refreshToken(req, res, next) {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ error: 'Token required' });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const newToken = generateToken(decoded.userId);

      res.json({ token: newToken });
    } catch (error) {
      next(error);
    }
  },

  // Logout (clears httpOnly cookie)
  async logout(req, res) {
    res.clearCookie('token', {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      path: '/'
    });
    res.json({ message: 'Logged out successfully' });
  },

  // Get current user info
  async getMe(req, res, next) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true
        }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(user);
    } catch (error) {
      next(error);
    }
  },

  // Request password reset
  async forgotPassword(req, res, next) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() }
      });

      // Always return success to prevent email enumeration
      if (!user) {
        return res.json({ 
          message: 'If an account exists with this email, a reset link has been sent.' 
        });
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Save hashed token to database
      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetToken: resetTokenHash,
          resetTokenExpiry
        }
      });

      // In production, send email with reset link
      // For now, log the token (remove in production!)
      const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/pages/reset-password.html?token=${resetToken}`;
      
      console.log('Password reset requested for:', email);
      console.log('Reset URL:', resetUrl);

      // TODO: Integrate email service (SendGrid, Mailgun, etc.)
      // await sendEmail({
      //   to: user.email,
      //   subject: 'Password Reset - KemDataplus',
      //   html: `<p>Click <a href="${resetUrl}">here</a> to reset your password. Link expires in 1 hour.</p>`
      // });

      res.json({ 
        message: 'If an account exists with this email, a reset link has been sent.',
        // Remove these in production - only for testing
        ...(process.env.NODE_ENV !== 'production' && { 
          debug: { resetToken, resetUrl } 
        })
      });
    } catch (error) {
      next(error);
    }
  },

  // Verify reset token
  async verifyResetToken(req, res, next) {
    try {
      const { token } = req.params;

      if (!token) {
        return res.status(400).json({ error: 'Token is required' });
      }

      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

      const user = await prisma.user.findFirst({
        where: {
          resetToken: hashedToken,
          resetTokenExpiry: { gt: new Date() }
        },
        select: { id: true, email: true }
      });

      if (!user) {
        return res.status(400).json({ error: 'Invalid or expired reset token' });
      }

      res.json({ valid: true, email: user.email });
    } catch (error) {
      next(error);
    }
  },

  // Reset password with token
  async resetPassword(req, res, next) {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res.status(400).json({ error: 'Token and password are required' });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

      const user = await prisma.user.findFirst({
        where: {
          resetToken: hashedToken,
          resetTokenExpiry: { gt: new Date() }
        }
      });

      if (!user) {
        return res.status(400).json({ error: 'Invalid or expired reset token' });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(password, 12);

      // Update password and clear reset token
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetTokenExpiry: null
        }
      });

      res.json({ message: 'Password reset successfully. You can now login with your new password.' });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = authController;
