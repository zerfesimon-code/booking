const rateLimit = require('express-rate-limit');
const { logger } = require('../utils/logger');

module.exports = (opts = {}) => rateLimit({ 
  windowMs: 60_000, 
  max: 60, 
  standardHeaders: true, 
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      path: req.path,
      method: req.method,
      limit: opts.max || 60,
      windowMs: opts.windowMs || 60000
    });
    res.status(429).json({ 
      success: false,
      message: 'Too many requests, please try again later.',
      retryAfter: Math.ceil((opts.windowMs || 60000) / 1000)
    });
  },
  ...opts 
});

