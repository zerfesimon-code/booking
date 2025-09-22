const { broadcast, sendMessageToSocketId } = require('../sockets/utils');
const logger = require('../utils/logger');

function emitBookingCreatedToNearestPassengers(payload, targets) {
  try {
    logger.info('[emit] booking:new:broadcast', { targetedCount: targets.length });
    broadcast('booking:new:broadcast', { ...payload, targetedCount: targets.length, target: 'passengers' });
    targets.forEach(p => {
      logger.info('[emit] booking:new -> passenger', { passengerId: String(p._id) });
      sendMessageToSocketId(`passenger:${String(p._id)}`, { event: 'booking:new', data: payload });
    });
  } catch (e) {}
}

function emitBookingUpdate(bookingId, patch) {
  try {
    logger.info('[emit] booking:update', { bookingId, patch });
    broadcast('booking:update', { id: bookingId, ...patch });
  } catch (_) {}
}

function emitBookingAssigned(bookingId, driverId) {
  try {
    logger.info('[emit] booking:assigned', { bookingId, driverId });
    broadcast('booking:assigned', { bookingId, driverId });
  } catch (_) {}
}

module.exports = {
  emitBookingCreatedToNearestPassengers,
  emitBookingUpdate,
  emitBookingAssigned
};

function emitTripStarted(io, booking) {
  try {
    const payload = { bookingId: String(booking._id), startedAt: booking.startedAt, startLocation: booking.startLocation };
    logger.info('[emit] trip_started', { bookingId: payload.bookingId });
    io.to(`booking:${String(booking._id)}`).emit('trip_started', payload);
  } catch (_) {}
}

function emitTripOngoing(io, booking, location) {
  try {
    const payload = { bookingId: String(booking._id || booking), location };
    logger.info('[emit] trip_ongoing', { bookingId: payload.bookingId });
    io.to(`booking:${String(booking._id || booking)}`).emit('trip_ongoing', payload);
  } catch (_) {}
}

function emitTripCompleted(io, booking) {
  try {
    const payload = {
      bookingId: String(booking._id),
      amount: booking.fareFinal || booking.fareEstimated,
      distance: booking.distanceKm,
      waitingTime: booking.waitingTime,
      completedAt: booking.completedAt,
      driverEarnings: booking.driverEarnings,
      commission: booking.commissionAmount
    };
    logger.info('[emit] trip_completed', { bookingId: payload.bookingId, amount: payload.amount });
    io.to(`booking:${String(booking._id)}`).emit('trip_completed', payload);
  } catch (_) {}
}

module.exports.emitTripStarted = emitTripStarted;
module.exports.emitTripOngoing = emitTripOngoing;
module.exports.emitTripCompleted = emitTripCompleted;

