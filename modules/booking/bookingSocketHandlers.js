const logger = require('../../utils/logger');
const { handleBookingRequest } = require('./bookingController');
const { sendMessageToSocketId } = require('../../sockets/utils');
const bookingEvents = require('../../events/bookingEvents');

module.exports = function registerBookingSocketHandlers(io, socket) {
  // booking_request
  socket.on('booking_request', async (payload) => {
    logger.info('[socket] booking_request', { socketId: socket.id });
    try {
      const booking = await handleBookingRequest(socket, payload);
      const bookingRoom = `booking:${String(booking._id)}`;
      socket.join(bookingRoom);
      socket.emit('booking:created', { bookingId: String(booking._id) });

      // Notify nearby drivers (reuse nearby driver service if available)
      try {
        const { driverByLocationAndVehicleType } = require('../../services/nearbyDrivers');
        const nearest = await driverByLocationAndVehicleType({
          latitude: booking.pickup.latitude,
          longitude: booking.pickup.longitude,
          vehicleType: booking.vehicleType,
          radiusKm: parseFloat(process.env.BROADCAST_RADIUS_KM || '5'),
          limit: 5
        });
        const targets = (nearest || []).map(x => x.driver);
        const patch = {
          bookingId: String(booking._id),
          patch: {
            status: 'requested',
            passengerId: String(socket.user.id),
            vehicleType: booking.vehicleType,
            pickup: booking.pickup,
            dropoff: booking.dropoff,
            passenger: { id: String(socket.user.id), name: socket.user.name, phone: socket.user.phone }
          }
        };
        targets.forEach(d => sendMessageToSocketId(`driver:${String(d._id)}`, { event: 'booking:new', data: patch }));
      } catch (_) {}

      // Broadcast passenger side
      try {
        const payloadOut = {
          id: String(booking._id),
          passengerId: String(socket.user.id),
          passenger: { id: String(socket.user.id), name: booking.passengerName, phone: booking.passengerPhone },
          vehicleType: booking.vehicleType,
          pickup: booking.pickup,
          dropoff: booking.dropoff,
          distanceKm: booking.distanceKm,
          fareEstimated: booking.fareEstimated,
          fareFinal: booking.fareFinal,
          fareBreakdown: booking.fareBreakdown,
          status: booking.status,
          createdAt: booking.createdAt,
          updatedAt: booking.updatedAt
        };
        bookingEvents.emitBookingCreatedToNearestPassengers(payloadOut, []);
      } catch (_) {}
    } catch (err) {
      logger.error('[socket] booking_request error', err);
      socket.emit('booking_error', { message: err.message || 'Failed to create booking' });
    }
  });

  // Stubs to ensure registration of existing events; to be implemented similarly
  const passthrough = [
    'booking_accept',
    'booking_cancel',
    'booking_note',
    'booking_notes_fetch',
    'booking:driver_location_update',
    'booking:status_request',
    'booking:ETA_update',
    'booking:completed',
    'booking:rating',
    'booking:nearby'
  ];
  passthrough.forEach(evt => {
    socket.on(evt, (...args) => {
      logger.info(`[socket] ${evt} received - handler to be delegated in services`, { socketId: socket.id });
      // existing implementations reside in sockets/*.js; migrate incrementally
    });
  });
};

