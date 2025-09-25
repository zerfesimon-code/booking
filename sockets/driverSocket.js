const driverService = require('../services/driverService');
const driverEvents = require('../events/driverEvents');
const logger = require('../utils/logger');

module.exports = (io, socket) => {
  // On connection, send initial driver bookings once
  try {
    if (socket.user && String(socket.user.type).toLowerCase() === 'driver') {
      (async () => {
        try {
          const { Booking } = require('../models/bookingModels');
          const rows = await Booking.find({ driverId: String(socket.user.id), status: { $in: ['accepted', 'ongoing', 'requested'] } })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
          const payload = {
            init: true,
            driverId: String(socket.user.id),
            bookings: rows.map(b => ({
              bookingId: String(b._id),
              status: b.status,
              pickup: b.pickup && (b.pickup.address || b.pickup),
              dropoff: b.dropoff && (b.dropoff.address || b.dropoff),
              fare: b.fareEstimated || b.fareFinal,
              passenger: b.passengerId ? { id: String(b.passengerId), name: b.passengerName, phone: b.passengerPhone } : undefined
            })),
            user: { id: socket.user && String(socket.user.id), type: 'driver' }
          };
          try { logger.info('[socket->driver] emit booking:nearby init', { sid: socket.id, userId: socket.user && socket.user.id, count: payload.bookings.length }); } catch (_) {}
          socket.emit('booking:nearby', payload);
        } catch (_) {}
      })();
    }
  } catch (_) {}

  // driver:availability
  socket.on('driver:availability', async (payload) => {
    try { logger.info('[socket<-driver] driver:availability', { sid: socket.id, userId: socket.user && socket.user.id, payload }); } catch (_) {}
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'driver:availability' });
      }
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const available = typeof data.available === 'boolean' ? data.available : undefined;
      if (available == null) return socket.emit('booking_error', { message: 'available boolean is required', source: 'driver:availability' });
      const updated = await driverService.setAvailability(String(socket.user.id), available, socket.user);
      driverEvents.emitDriverAvailability(String(socket.user.id), !!available);
      try { logger.info('[socket->driver] availability updated', { userId: socket.user && socket.user.id, available }); } catch (_) {}
    } catch (err) {
      socket.emit('booking_error', { message: 'Failed to update availability', source: 'driver:availability' });
    }
  });

  // booking:driver_location_update
  socket.on('booking:driver_location_update', async (payload) => {
    try { logger.info('[socket<-driver] booking:driver_location_update', { sid: socket.id, userId: socket.user && socket.user.id, payload }); } catch (_) {}
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'booking:driver_location_update' });
      }
      const raw = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const data = {
        latitude: raw.latitude != null ? Number(raw.latitude) : undefined,
        longitude: raw.longitude != null ? Number(raw.longitude) : undefined,
        bearing: raw.bearing != null ? Number(raw.bearing) : undefined
      };
      if (!Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)) {
        return socket.emit('booking_error', { message: 'latitude and longitude must be numbers', source: 'booking:driver_location_update' });
      }
      const d = await driverService.updateLocation(String(socket.user.id), data, socket.user);
      driverEvents.emitDriverLocationUpdate({
        driverId: String(d._id),
        vehicleType: d.vehicleType,
        available: d.available,
        lastKnownLocation: { latitude: d.lastKnownLocation?.latitude, longitude: d.lastKnownLocation?.longitude, bearing: d.lastKnownLocation?.bearing },
        updatedAt: d.updatedAt
      });
      try { logger.info('[socket->broadcast] driver location updated', { userId: socket.user && socket.user.id, lat: d.lastKnownLocation?.latitude, lon: d.lastKnownLocation?.longitude }); } catch (_) {}
    } catch (err) {
      socket.emit('booking_error', { message: 'Failed to process location update', source: 'booking:driver_location_update' });
    }
  });
};

