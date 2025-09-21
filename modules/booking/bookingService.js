const bookingServiceCore = require('../../services/bookingService');

async function createBookingFromSocket({ passengerId, jwtUser, vehicleType, pickup, dropoff, authHeader }) {
  return bookingServiceCore.createBooking({ passengerId, jwtUser, vehicleType, pickup, dropoff, authHeader });
}

module.exports = { createBookingFromSocket };

