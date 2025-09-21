const logger = require('../../utils/logger');
const bookingService = require('./bookingService');

async function handleBookingRequest(socket, payload) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
  if (!socket.user || String(socket.user.type).toLowerCase() !== 'passenger') {
    const err = new Error('Unauthorized: passenger token required');
    err.status = 401;
    throw err;
  }
  const passengerId = String(socket.user.id);
  const booking = await bookingService.createBookingFromSocket({
    passengerId,
    jwtUser: socket.user,
    vehicleType: data.vehicleType || 'mini',
    pickup: data.pickup,
    dropoff: data.dropoff,
    authHeader: socket.authToken ? { Authorization: socket.authToken } : undefined
  });
  logger.info('[booking_request] created booking', { bookingId: String(booking._id), passengerId });
  return booking;
}

module.exports = { handleBookingRequest };

