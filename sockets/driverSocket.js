const driverService = require('../services/driverService');
const driverEvents = require('../events/driverEvents');

module.exports = (io, socket) => {
  // driver:availability
  socket.on('driver:availability', async (payload) => {
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'driver:availability' });
      }
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const available = typeof data.available === 'boolean' ? data.available : undefined;
      if (available == null) return socket.emit('booking_error', { message: 'available boolean is required', source: 'driver:availability' });
      const updated = await driverService.setAvailability(String(socket.user.id), available, socket.user);
      driverEvents.emitDriverAvailability(String(socket.user.id), !!available);
    } catch (err) {
      socket.emit('booking_error', { message: 'Failed to update availability', source: 'driver:availability' });
    }
  });

  // booking:driver_location_update
  socket.on('booking:driver_location_update', async (payload) => {
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'booking:driver_location_update' });
      }
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const d = await driverService.updateLocation(String(socket.user.id), data, socket.user);
      driverEvents.emitDriverLocationUpdate({
        driverId: String(d._id),
        vehicleType: d.vehicleType,
        available: d.available,
        lastKnownLocation: d.lastKnownLocation,
        updatedAt: d.updatedAt
      });
    } catch (err) {
      socket.emit('booking_error', { message: 'Failed to process location update', source: 'booking:driver_location_update' });
    }
  });
};

