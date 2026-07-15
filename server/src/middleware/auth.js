const jwt = require('jsonwebtoken');

const prisma = require('../lib/prisma');

/**
 * Extract token from request (cookie first, then Authorization header)
 */
const extractToken = (req) => {
  // 1. Check httpOnly cookie first
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }
  
  // 2. Fall back to Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  
  return null;
};

/**
 * Authenticate user - supports httpOnly cookies, Bearer JWT tokens, and API keys (kdp_sk_...)
 */
const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // API key path: tokens starting with kdp_sk_ are looked up directly
    if (token.startsWith('kdp_sk_')) {
      const user = await prisma.user.findUnique({
        where: { apiKey: token },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          tenantId: true,
          passwordChangedAt: true
        }
      });

      if (!user) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      if (!user.isActive) {
        return res.status(403).json({ error: 'Account is deactivated' });
      }

      req.user = user;
      req.authMethod = 'api_key';
      return next();
    }

    // JWT path
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        tenantId: true,
        passwordChangedAt: true
      }
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    // Token invalidation check: if password was changed after token was issued
    if (user.passwordChangedAt && decoded.iat) {
      const passwordChangedTimestamp = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (decoded.iat < passwordChangedTimestamp) {
        res.clearCookie('token', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict'
        });
        return res.status(401).json({ 
          error: 'Password was recently changed. Please login again.',
          code: 'PASSWORD_CHANGED'
        });
      }
    }

    req.user = user;
    req.authMethod = 'jwt';
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(error);
  }
};

/**
 * Authorize by roles
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    next();
  };
};

/**
 * Optional authentication - adds user to req if token is valid
 */
const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    
    if (!token) {
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        tenantId: true
      }
    });

    if (user && user.isActive) {
      req.user = user;
    }
    next();
  } catch (error) {
    next();
  }
};

module.exports = { authenticate, authorize, optionalAuth };
