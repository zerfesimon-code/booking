const driverService = require('../services/driverService');
const driverEvents = require('../events/driverEvents');
const logger = require('../utils/logger');

module.exports = (io, socket) => {
  // driver:availability
  socket.on('driver:availability', async (payload) => {
    logger.info('[driver:availability] received', { socketId: socket.id, payload });
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        logger.warn('[driver:availability] unauthorized attempt', { socketId: socket.id });
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'driver:availability' });
      }
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const available = typeof data.available === 'boolean' ? data.available : undefined;
      if (available == null) return socket.emit('booking_error', { message: 'available boolean is required', source: 'driver:availability' });
      const updated = await driverService.setAvailability(String(socket.user.id), available, socket.user);
      driverEvents.emitDriverAvailability(String(socket.user.id), !!available);
      logger.info('[driver:availability] updated', { driverId: socket.user.id, available: !!available });
    } catch (err) {
      logger.error('[driver:availability] error', err);
      socket.emit('booking_error', { message: 'Failed to update availability', source: 'driver:availability' });
    }
  });

  // booking:driver_location_update
  socket.on('booking:driver_location_update', async (payload) => {
    logger.info('[booking:driver_location_update] received', { socketId: socket.id, payload });
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        logger.warn('[booking:driver_location_update] unauthorized attempt', { socketId: socket.id });
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'booking:driver_location_update' });
      }
      const raw = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const data = raw && raw.location && typeof raw.location === 'object' ? raw.location : raw;
      const latitude = data?.latitude != null ? Number(data.latitude) : undefined;
      const longitude = data?.longitude != null ? Number(data.longitude) : undefined;
      const bearing = data?.bearing != null ? Number(data.bearing) : undefined;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return socket.emit('booking_error', { message: 'latitude and longitude are required', source: 'booking:driver_location_update' });
      }
      const d = await driverService.updateLocation(String(socket.user.id), { latitude, longitude, bearing }, socket.user);
      driverEvents.emitDriverLocationUpdate({
        driverId: String(d._id),
        vehicleType: d.vehicleType,
        available: d.available,
        lastKnownLocation: d.lastKnownLocation,
        updatedAt: d.updatedAt
      });
      logger.info('[booking:driver_location_update] processed', { driverId: String(socket.user.id), location: d.lastKnownLocation });
    } catch (err) {
      logger.error('[booking:driver_location_update] error', err);
      socket.emit('booking_error', { message: 'Failed to process location update', source: 'booking:driver_location_update' });
    }
  });
  
};

