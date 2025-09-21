const { Live } = require('../models/bookingModels');
const { sendMessageToSocketId } = require('./utils');

module.exports = (io, socket) => {
  // booking:status_request passthrough
  socket.on('booking:status_request', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', source: 'booking:status_request' });
      const { Booking } = require('../models/bookingModels');
      const booking = await Booking.findById(bookingId).lean();
      if (!booking) return socket.emit('booking_error', { message: 'Booking not found', bookingId, source: 'booking:status_request' });
      socket.emit('booking:status', {
        bookingId: String(booking._id),
        status: booking.status,
        driverId: booking.driverId,
        passengerId: booking.passengerId,
        vehicleType: booking.vehicleType,
        pickup: booking.pickup,
        dropoff: booking.dropoff
      });
    } catch (err) {
      socket.emit('booking_error', { message: 'Failed to fetch booking status', source: 'booking:status_request' });
    }
  });

  // booking:ETA_update
  socket.on('booking:ETA_update', async (payload) => {
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'booking:ETA_update' });
      }
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const etaMinutes = data.etaMinutes != null ? parseInt(data.etaMinutes, 10) : undefined;
      const message = data.message || undefined;
      if (!bookingId || !Number.isFinite(etaMinutes)) return socket.emit('booking_error', { message: 'bookingId and etaMinutes are required', source: 'booking:ETA_update' });
      const { Booking } = require('../models/bookingModels');
      const booking = await Booking.findById(bookingId).lean();
      if (!booking) return socket.emit('booking_error', { message: 'Booking not found', source: 'booking:ETA_update' });
      if (String(booking.driverId || '') !== String(socket.user.id)) return socket.emit('booking_error', { message: 'Only assigned driver can send ETA', source: 'booking:ETA_update' });
      const out = { bookingId: String(booking._id), etaMinutes, message, driverId: String(socket.user.id), timestamp: new Date().toISOString() };
      sendMessageToSocketId(`booking:${String(booking._id)}`, { event: 'booking:ETA_update', data: out });
    } catch (err) {
      socket.emit('booking_error', { message: 'Failed to process ETA update', source: 'booking:ETA_update' });
    }
  });
};

