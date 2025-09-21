const { broadcast, sendMessageToSocketId } = require('../sockets/utils');

function emitBookingCreatedToNearestPassengers(payload, targets) {
  try {
    broadcast('booking:new:broadcast', { ...payload, targetedCount: targets.length, target: 'passengers' });
    targets.forEach(p => sendMessageToSocketId(`passenger:${String(p._id)}`, { event: 'booking:new', data: payload }));
  } catch (e) {}
}

function emitBookingUpdate(bookingId, patch) {
  try {
    broadcast('booking:update', { id: bookingId, ...patch });
  } catch (_) {}
}

function emitBookingAssigned(bookingId, driverId) {
  try {
    broadcast('booking:assigned', { bookingId, driverId });
  } catch (_) {}
}

module.exports = {
  emitBookingCreatedToNearestPassengers,
  emitBookingUpdate,
  emitBookingAssigned
};

