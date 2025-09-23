const bookingService = require('../services/bookingService');
const bookingEvents = require('../events/bookingEvents');
const { sendMessageToSocketId } = require('./utils');
const lifecycle = require('../services/bookingLifecycleService');
const logger = require('../utils/logger');
const { Booking } = require('../models/bookingModels');

module.exports = (io, socket) => {
  // booking_request (create booking)
  socket.on('booking_request', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'passenger') {
        return socket.emit('booking_error', { message: 'Unauthorized: passenger token required' });
      }
      const passengerId = String(socket.user.id);
      const booking = await bookingService.createBooking({
        passengerId,
        jwtUser: socket.user,
        vehicleType: data.vehicleType || 'mini',
        pickup: data.pickup,
        dropoff: data.dropoff,
        authHeader: socket.authToken ? { Authorization: socket.authToken } : undefined
      });
      const bookingRoom = `booking:${String(booking._id)}`;
      socket.join(bookingRoom);
      socket.emit('booking:created', { bookingId: String(booking._id) });

      // Broadcast to nearby drivers (reuse existing nearbyDrivers service if present)
      try {
        const { driverByLocationAndVehicleType } = require('../services/nearbyDrivers');
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
            passengerId,
            vehicleType: booking.vehicleType,
            pickup: booking.pickup,
            dropoff: booking.dropoff,
            passenger: { id: passengerId, name: socket.user.name, phone: socket.user.phone }
          }
        };
        targets.forEach(d => sendMessageToSocketId(`driver:${String(d._id)}`, { event: 'booking:new', data: patch }));
      } catch (_) {}
    } catch (err) {
      socket.emit('booking_error', { message: 'Failed to create booking' });
    }
  });

  // booking_accept
  socket.on('booking_accept', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver' || !socket.user.id) {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', bookingId });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required' });

      // Only allow accept transition via lifecycle update in service
      const updated = await bookingService.updateBookingLifecycle({ requester: socket.user, id: bookingId, status: 'accepted' });
      const room = `booking:${String(updated._id)}`;
      socket.join(room);
      bookingEvents.emitBookingUpdate(String(updated._id), { status: 'accepted', driverId: String(socket.user.id), acceptedAt: updated.acceptedAt });

      // Emit explicit booking_accept with enriched driver details to booking room
      try {
        const { Driver } = require('../models/userModels');
        const d = await Driver.findById(String(socket.user.id)).lean();
        const driverPayload = {
          id: String(socket.user.id),
          name: (d && d.name) || socket.user.name,
          phone: (d && d.phone) || socket.user.phone,
          carName: (d && (d.carModel || d.carName)) || socket.user.carName || socket.user.carModel,
          vehicleType: (d && d.vehicleType) || socket.user.vehicleType,
          rating: (d && (d.rating || d.rating === 0 ? d.rating : undefined)) ?? 5.0,
          carPlate: d && d.carPlate || socket.user.carPlate
        };
        io.to(room).emit('booking_accept', {
          bookingId: String(updated._id),
          status: 'accepted',
          driver: driverPayload
        });
      } catch (_) {}

      // Inform nearby drivers to remove
      try {
        const { Driver } = require('../models/userModels');
        const geolib = require('geolib');
        const drivers = await Driver.find({ available: true }).lean();
        const radiusKm = parseFloat(process.env.RADIUS_KM || process.env.BROADCAST_RADIUS_KM || '5');
        const vehicleType = updated.vehicleType;
        const nearby = drivers.filter(d => (
          d && d._id && String(d._id) !== String(socket.user.id) &&
          d.lastKnownLocation &&
          (!vehicleType || String(d.vehicleType || '').toLowerCase() === String(vehicleType || '').toLowerCase()) &&
          (geolib.getDistance(
            { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
            { latitude: updated.pickup?.latitude, longitude: updated.pickup?.longitude }
          ) / 1000) <= radiusKm
        ));
        nearby.forEach(d => sendMessageToSocketId(`driver:${String(d._id)}`, { event: 'booking:removed', data: { bookingId: String(updated._id) } }));
      } catch (_) {}
    } catch (err) {}
  });

  // booking_cancel
  socket.on('booking_cancel', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const reason = data.reason;
      if (!socket.user || !socket.user.type) return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId });
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', bookingId });
      const updated = await bookingService.updateBookingLifecycle({ requester: socket.user, id: bookingId, status: 'canceled' });
      bookingEvents.emitBookingUpdate(String(updated._id), { status: 'canceled', canceledBy: String(socket.user.type).toLowerCase(), canceledReason: reason });
    } catch (err) {}
  });

  // trip_started
  socket.on('trip_started', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const startLocation = data.startLocation || data.location;
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_started' });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', source: 'trip_started' });
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) });
      if (!booking) return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_started' });
      const updated = await lifecycle.startTrip(bookingId, startLocation);
      bookingEvents.emitTripStarted(io, updated);
    } catch (err) {
      logger.error('[trip_started] error', err);
      socket.emit('booking_error', { message: 'Failed to start trip', source: 'trip_started' });
    }
  });

  // trip_ongoing
  socket.on('trip_ongoing', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const location = data.location || { latitude: data.latitude, longitude: data.longitude };
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_ongoing' });
      }
      if (!bookingId || !location || location.latitude == null || location.longitude == null) {
        return socket.emit('booking_error', { message: 'bookingId and location are required', source: 'trip_ongoing' });
      }
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) }).lean();
      if (!booking) return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_ongoing' });
      const point = await lifecycle.updateTripLocation(bookingId, String(socket.user.id), location);
      bookingEvents.emitTripOngoing(io, bookingId, point);
    } catch (err) {
      logger.error('[trip_ongoing] error', err);
      socket.emit('booking_error', { message: 'Failed to update trip location', source: 'trip_ongoing' });
    }
  });

  // trip_completed
  socket.on('trip_completed', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const endLocation = data.endLocation || data.location;
      const surgeMultiplier = data.surgeMultiplier || 1;
      const discount = data.discount || 0;
      const debitPassengerWallet = !!data.debitPassengerWallet;
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_completed' });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', source: 'trip_completed' });
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) });
      if (!booking) return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_completed' });
      const updated = await lifecycle.completeTrip(bookingId, endLocation, { surgeMultiplier, discount, debitPassengerWallet });
      bookingEvents.emitTripCompleted(io, updated);
    } catch (err) {
      logger.error('[trip_completed] error', err);
      socket.emit('booking_error', { message: 'Failed to complete trip', source: 'trip_completed' });
    }
  });
};
