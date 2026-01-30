const errorHandler = (err, req, res, next) => {
  // Only log full error in development
  const isProduction = process.env.NODE_ENV === 'production';
  const requestId = req.requestId || 'unknown';
  
  if (isProduction) {
    // In production, log sanitized error info with request ID
    console.error('Error:', {
      requestId,
      message: err.message,
      code: err.code,
      name: err.name,
      url: req.originalUrl,
      method: req.method
    });
  } else {
    console.error(`Error [${requestId}]:`, err);
  }

  // Prisma errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      error: 'A record with this value already exists',
      field: isProduction ? undefined : err.meta?.target
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      error: 'Record not found'
    });
  }

  // JWT errors - don't reveal specific JWT details in production
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Authentication failed'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Session expired. Please login again.'
    });
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: isProduction ? undefined : err.errors
    });
  }

  // CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'Access denied',
      requestId
    });
  }

  // Default error - never leak stack traces in production
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    error: isProduction && statusCode === 500 
      ? 'An unexpected error occurred' 
      : (err.message || 'Internal server error'),
    requestId,
    ...(!isProduction && { stack: err.stack })
  });
};

module.exports = errorHandler;
