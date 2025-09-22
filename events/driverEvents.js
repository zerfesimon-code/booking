const { broadcast, getIo } = require('../sockets/utils');
const logger = require('../utils/logger');

function emitDriverLocationUpdate(payload) {
  try {
    logger.info('[emit] driver:location', { driverId: payload && payload.driverId });
    broadcast('driver:location', payload);
    const io = getIo && getIo();
    if (io && payload && payload.driverId) {
      logger.info('[emit] driver:location:<driverId>', { driverId: String(payload.driverId) });
      io.emit(`driver:location:${String(payload.driverId)}`, payload);
      broadcast('driver:position', payload);
    }
  } catch (_) {}
}

function emitDriverAvailability(driverId, available) {
  try {
    const io = getIo && getIo();
    if (io) {
      logger.info('[emit] driver:availability', { driverId: String(driverId), available: !!available });
      io.to(`driver:${String(driverId)}`).emit('driver:availability', { driverId: String(driverId), available });
    }
  } catch (_) {}
}

module.exports = { emitDriverLocationUpdate, emitDriverAvailability };

