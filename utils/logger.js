const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// Enhanced logger with structured logging, timestamps, and context
class Logger {
  constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
  }

  formatMessage(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...context
    };
    return JSON.stringify(logEntry);
  }

  shouldLog(level) {
    return this.levels[level] <= this.levels[this.logLevel];
  }

  log(level, message, context = {}) {
    if (!this.shouldLog(level)) return;
    
    const formattedMessage = this.formatMessage(level, message, context);
    
    try {
      switch (level) {
        case 'error':
          console.error(formattedMessage);
          break;
        case 'warn':
          console.warn(formattedMessage);
          break;
        case 'info':
          console.log(formattedMessage);
          break;
        case 'debug':
          if (!isProduction) {
            console.log(formattedMessage);
          }
          break;
      }
    } catch (_) {
      // Fallback to simple logging if JSON formatting fails
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }

  info(message, context = {}) {
    this.log('info', message, context);
  }

  warn(message, context = {}) {
    this.log('warn', message, context);
  }

  error(message, context = {}) {
    this.log('error', message, context);
  }

  debug(message, context = {}) {
    this.log('debug', message, context);
  }

  // Socket event logging
  socketEvent(eventName, socketId, data = {}, context = {}) {
    this.info(`Socket Event: ${eventName}`, {
      event: eventName,
      socketId,
      data: typeof data === 'object' ? data : { payload: data },
      ...context
    });
  }

  // API request logging
  apiRequest(method, url, userId = null, context = {}) {
    this.info(`API Request: ${method} ${url}`, {
      method,
      url,
      userId,
      ...context
    });
  }

  // API response logging
  apiResponse(method, url, statusCode, responseTime = null, context = {}) {
    this.info(`API Response: ${method} ${url} - ${statusCode}`, {
      method,
      url,
      statusCode,
      responseTime: responseTime ? `${responseTime}ms` : null,
      ...context
    });
  }

  // Database operation logging
  dbOperation(operation, collection, query = {}, context = {}) {
    this.debug(`DB Operation: ${operation} on ${collection}`, {
      operation,
      collection,
      query,
      ...context
    });
  }

  // Business logic logging
  businessEvent(event, userId = null, data = {}, context = {}) {
    this.info(`Business Event: ${event}`, {
      event,
      userId,
      data,
      ...context
    });
  }
}

const logger = new Logger();

// Legacy functions for backward compatibility
function info(...args) {
  logger.info(args.join(' '));
}

function warn(...args) {
  logger.warn(args.join(' '));
}

function error(...args) {
  logger.error(args.join(' '));
}

module.exports = { 
  info, 
  warn, 
  error, 
  logger,
  Logger 
};
