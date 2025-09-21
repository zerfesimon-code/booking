const { Passenger, Driver } = require('../models/userModels');
const { logger } = require('../utils/logger');

async function enrichEntity(entity) {
  if (!entity || typeof entity !== 'object') return entity;

  const clone = Array.isArray(entity) ? entity.slice() : { ...entity };

  // If array, enrich each item
  if (Array.isArray(clone)) {
    return Promise.all(clone.map(item => enrichEntity(item)));
  }

  // Try to enrich passenger info
  if (clone.passengerId && !clone.passenger) {
    try {
      logger.dbOperation('findById', 'Passenger', { _id: clone.passengerId });
      const p = await Passenger.findById(clone.passengerId).select({ _id: 1, name: 1 }).lean();
      if (p) clone.passenger = { id: String(p._id), name: p.name };
    } catch (e) {
      logger.debug('Failed to enrich passenger info', { error: e.message, passengerId: clone.passengerId });
    }
  }
  // If embedded passenger object missing name but has id, try fill name
  if (clone.passenger && !clone.passenger.name && (clone.passenger.id || clone.passenger._id)) {
    try {
      const pid = clone.passenger.id || clone.passenger._id;
      logger.dbOperation('findById', 'Passenger', { _id: pid });
      const p = await Passenger.findById(pid).select({ _id: 1, name: 1 }).lean();
      if (p) clone.passenger = { id: String(p._id), name: p.name };
    } catch (e) {
      logger.debug('Failed to enrich embedded passenger info', { error: e.message, passengerId: clone.passenger.id || clone.passenger._id });
    }
  }

  // Try to enrich driver info
  if (clone.driverId && !clone.driver) {
    try {
      logger.dbOperation('findById', 'Driver', { _id: clone.driverId });
      const d = await Driver.findById(clone.driverId).select({ _id: 1, name: 1 }).lean();
      if (d) clone.driver = { id: String(d._id), name: d.name };
    } catch (e) {
      logger.debug('Failed to enrich driver info', { error: e.message, driverId: clone.driverId });
    }
  }
  if (clone.driver && !clone.driver.name && (clone.driver.id || clone.driver._id)) {
    try {
      const did = clone.driver.id || clone.driver._id;
      logger.dbOperation('findById', 'Driver', { _id: did });
      const d = await Driver.findById(did).select({ _id: 1, name: 1 }).lean();
      if (d) clone.driver = { id: String(d._id), name: d.name };
    } catch (e) {
      logger.debug('Failed to enrich embedded driver info', { error: e.message, driverId: clone.driver.id || clone.driver._id });
    }
  }

  return clone;
}

module.exports = function responseFormatter() {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = async (payload) => {
      try {
        const startTime = Date.now();
        const data = await enrichEntity(payload);
        const body = { success: res.statusCode < 400, data };
        
        logger.debug('Response formatted', {
          path: req.path,
          method: req.method,
          statusCode: res.statusCode,
          enrichmentTime: Date.now() - startTime,
          hasData: !!data
        });
        
        return originalJson(body);
      } catch (e) {
        logger.warn('Response enrichment failed, using fallback', {
          path: req.path,
          method: req.method,
          error: e.message,
          statusCode: res.statusCode
        });
        // If enrichment fails, fall back to original payload
        return originalJson({ success: res.statusCode < 400, data: payload });
      }
    };
    next();
  };
};


