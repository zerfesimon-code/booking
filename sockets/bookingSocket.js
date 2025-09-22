const bookingService = require('../services/bookingService');
const bookingEvents = require('../events/bookingEvents');
const { sendMessageToSocketId } = require('./utils');
const lifecycle = require('../services/bookingLifecycleService');
const logger = require('../utils/logger');
const { Booking } = require('../models/bookingModels');

module.exports = (io, socket) => {
  // booking_request (create booking)
  socket.on('booking_request', async (payload) => {
    logger.info('[booking_request] received', { socketId: socket.id, payload });
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'passenger') {
        logger.warn('[booking_request] unauthorized attempt', { socketId: socket.id });
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
      logger.info('[booking_request] booking created', { bookingId: booking._id, passengerId });

      // Broadcast to nearby drivers
      try {
        const { driverByLocationAndVehicleType } = require('../services/nearbyDrivers');
        const nearest = await driverByLocationAndVehicleType({
          latitude: booking.pickup.latitude,
          longitude: booking.pickup.longitude,
          vehicleType: booking.vehicleType,
          radiusKm: parseFloat(process.env.BROADCAST_RADIUS_KM || '100'),
          limit: 5
        });
        logger.info('the nearest drivers are', { nearest });
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
        logger.info('the targets are', { targets });
        targets.forEach(d => {
          sendMessageToSocketId(`driver:${String(d._id)}`, { event: 'booking:new', data: patch });
          try{
            sendMessageToSocketId(`driver:${String(d._id)}`, { event: 'booking:nearby', data: patch });
        logger.info('[booking_request] broadcast sent to driver', { bookingId: booking._id, driverId: String(d._id) });}
        catch(_){
          logger.error('[booking_request] broadcast sent to driver failed', { bookingId: booking._id, driverId: String(d._id) });
        }
        });
        logger.info('[booking_request] broadcast sent to drivers', { bookingId: booking._id, drivers: targets.map(d => d._id), events: ['booking:new','booking:nearby'] });
      } catch (err) {
        logger.error('[booking_request] nearby drivers broadcast failed', err);
      }
    } catch (err) {
      logger.error('[booking_request] error creating booking', err);
      socket.emit('booking_error', { message: 'Failed to create booking' });
    }
  });

  
// booking_accept
socket.on('booking_accept', async (payload) => {
  logger.info('[booking_accept] received', { socketId: socket.id, payload });
  try {
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    const bookingId = String(data.bookingId || '');

    if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver' || !socket.user.id) {
      logger.warn('[booking_accept] unauthorized attempt', { socketId: socket.id });
      return socket.emit('booking_error', { message: 'Unauthorized: driver token required', bookingId });
    }

    if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required' });

    // Fetch booking and include denormalized passenger info (name, phone)
    const booking = await Booking.findById(bookingId).lean();
    if (!booking) {
      return socket.emit('booking_error', { message: 'Booking not found', bookingId });
    }

    // Update lifecycle
    const updated = await bookingService.updateBookingLifecycle({ requester: socket.user, id: bookingId, status: 'accepted' });

    const room = `booking:${String(updated._id)}`;
    socket.join(room);

    // Lookup basic driver info to expose to passenger
    let driverBasic = undefined;
    try {
      const { Driver } = require('../models/userModels');
      const d = await Driver.findById(String(socket.user.id)).select({ _id: 1, name: 1, phone: 1, vehicleType: 1, plateNumber: 1 }).lean();
      if (d) driverBasic = { id: String(d._id), name: d.name, phone: d.phone, vehicleType: d.vehicleType, plateNumber: d.plateNumber };
    } catch (_) {}

    // Emit booking update with passenger info and driver basic info
    bookingEvents.emitBookingUpdate(String(updated._id), {
      status: 'accepted',
      driverId: String(socket.user.id),
      acceptedAt: updated.acceptedAt,
      driver: driverBasic,
      passenger: {
        name: booking.passengerName,
        phone: booking.passengerPhone
      },
      location: booking.pickup,
      pickup: booking.pickup,
      dropoff: booking.dropoff
    });

    // Send directly to driver
    sendMessageToSocketId(`driver:${String(socket.user.id)}`, {
      event: 'booking:accepted',
      data: {
        bookingId: String(updated._id),
        patch: {
          status: 'accepted',
          driverId: String(socket.user.id),
          acceptedAt: updated.acceptedAt,
          driver: driverBasic,
          passenger: {
            name: booking.passengerName,
            phone: booking.passengerPhone
          },
          location: booking.pickup,
          pickup: booking.pickup,
          dropoff: booking.dropoff
        }
      }
    });

    // Targeted message to passenger with driver basics so the app can display contact details
    try {
      if (booking.passengerId) {
        sendMessageToSocketId(`passenger:${String(booking.passengerId)}`, {
          event: 'booking:driver_assigned',
          data: {
            bookingId: String(updated._id),
            driver: driverBasic,
            pickup: booking.pickup,
            dropoff: booking.dropoff,
            acceptedAt: updated.acceptedAt
          }
        });
      }
    } catch (_) {}

    logger.info('[booking_accept] booking accepted', { bookingId, driverId: socket.user.id });
  } catch (err) {
    logger.error('[booking_accept] error', err);
    socket.emit('booking_error', { message: 'Failed to accept booking', bookingId: payload.bookingId });
  }
});

  // booking_cancel
  socket.on('booking_cancel', async (payload) => {
    logger.info('[booking_cancel] received', { socketId: socket.id, payload });
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const reason = data.reason;
      if (!socket.user || !socket.user.type) {
        logger.warn('[booking_cancel] unauthorized attempt', { socketId: socket.id });
        return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', bookingId });
      const updated = await bookingService.updateBookingLifecycle({ requester: socket.user, id: bookingId, status: 'canceled' });
      bookingEvents.emitBookingUpdate(String(updated._id), { status: 'canceled', canceledBy: String(socket.user.type).toLowerCase(), canceledReason: reason });
      logger.info('[booking_cancel] booking canceled', { bookingId, canceledBy: socket.user.type, reason });
    } catch (err) {
      logger.error('[booking_cancel] error', err);
    }
  });

  // trip_started
  socket.on('trip_started', async (payload) => {
    logger.info('[trip_started] received', { socketId: socket.id, payload });
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const startLocation = data.startLocation || data.location;
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        logger.warn('[trip_started] unauthorized attempt', { socketId: socket.id });
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_started' });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', source: 'trip_started' });
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) });
      if (!booking) {
        logger.warn('[trip_started] booking not found', { bookingId, driverId: socket.user.id });
        return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_started' });
      }
      const updated = await lifecycle.startTrip(bookingId, startLocation);
      // Persist trip start to TripHistory and notify admin dashboard using existing services
      try { await require('../services/bookingLifecycleService').startTrip(String(updated._id), startLocation); } catch (_) {}
      try { const bookingEvents = require('../events/bookingEvents'); bookingEvents.emitBookingUpdate(String(updated._id), { status: 'ongoing' }); } catch (_) {}
      bookingEvents.emitTripStarted(io, updated);
      logger.info('[trip_started] trip started', { bookingId, driverId: socket.user.id });
    } catch (err) {
      logger.error('[trip_started] error', err);
      socket.emit('booking_error', { message: 'Failed to start trip', source: 'trip_started' });
    }
  });

  // trip_ongoing
  socket.on('trip_ongoing', async (payload) => {
    logger.info('[trip_ongoing] received', { socketId: socket.id, payload });
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const location = data.location || { latitude: data.latitude, longitude: data.longitude };
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        logger.warn('[trip_ongoing] unauthorized attempt', { socketId: socket.id });
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_ongoing' });
      }
      if (!bookingId || !location || location.latitude == null || location.longitude == null) {
        return socket.emit('booking_error', { message: 'bookingId and location are required', source: 'trip_ongoing' });
      }
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) }).lean();
      if (!booking) {
        logger.warn('[trip_ongoing] booking not found', { bookingId, driverId: socket.user.id });
        return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_ongoing' });
      }
      const point = await lifecycle.updateTripLocation(bookingId, String(socket.user.id), location);
      // Update trip path in TripHistory
      try { await require('../services/bookingLifecycleService').updateTripLocation(bookingId, String(socket.user.id), location); } catch (_) {}
      bookingEvents.emitTripOngoing(io, bookingId, point);
      logger.info('[trip_ongoing] location updated', { bookingId, driverId: socket.user.id, location });
    } catch (err) {
      logger.error('[trip_ongoing] error', err);
      socket.emit('booking_error', { message: 'Failed to update trip location', source: 'trip_ongoing' });
    }
  });

  // trip_completed
  socket.on('trip_completed', async (payload) => {
    logger.info('[trip_completed] received', { socketId: socket.id, payload });
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const endLocation =
        data.endLocation ||
        data.end_location ||
        data.endLoc ||
        data.location ||
        (data.latitude != null && data.longitude != null
          ? { latitude: Number(data.latitude), longitude: Number(data.longitude) }
          : undefined) ||
        (data.lat != null && data.lng != null
          ? { latitude: Number(data.lat), longitude: Number(data.lng) }
          : undefined) ||
        data.dropoff;
      const surgeMultiplier = data.surgeMultiplier || 1;
      const discount = data.discount || 0;
      const debitPassengerWallet = !!data.debitPassengerWallet;
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        logger.warn('[trip_completed] unauthorized attempt', { socketId: socket.id });
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_completed' });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', source: 'trip_completed' });
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) });
      if (!booking) {
        logger.warn('[trip_completed] booking not found', { bookingId, driverId: socket.user.id });
        return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_completed' });
      }
      const updated = await lifecycle.completeTrip(bookingId, endLocation, { surgeMultiplier, discount, debitPassengerWallet });
      try {
        const commissionPct = Number(process.env.COMMISSION_RATE || 0.15);
        const fare = updated.fareFinal || updated.fareEstimated || 0;
        // Persist completion summary (existing lifecycle service already updates booking and TripHistory)
        await require('../services/bookingLifecycleService').completeTrip(bookingId, endLocation, { surgeMultiplier, discount, debitPassengerWallet });
        const commissionAmount = fare * commissionPct;
        const netEarnings = fare - commissionAmount;
        // Wallet credit and commission records using existing models/services
        const { Wallet, Transaction } = require('../models/common');
        await Wallet.updateOne(
          { userId: String(updated.driverId), role: 'driver' },
          { $inc: { balance: netEarnings, totalEarnings: netEarnings } },
          { upsert: true }
        );
        await Transaction.create({ userId: String(updated.driverId), role: 'driver', amount: netEarnings, type: 'credit', method: updated.paymentMethod || 'cash', status: 'success', metadata: { bookingId: String(updated._id), reason: 'Trip earnings (socket)' } });
        const { AdminEarnings } = require('../models/commission');
        await AdminEarnings.create({ bookingId: updated._id, tripDate: new Date(), commissionEarned: commissionAmount, commissionPercentage: commissionPct * 100, driverId: updated.driverId, passengerId: updated.passengerId });
        // Reward points in existing analytics.controller compute path: optionally emit event for UI; compute via distanceKm on booking
        try { const { broadcast } = require('./utils'); broadcast('driver:wallet_update', { driverId: String(updated.driverId) }); } catch (_) {}
        try { const bookingEvents = require('../events/bookingEvents'); bookingEvents.emitBookingUpdate(String(updated._id), { status: 'completed' }); } catch (_) {}
      } catch (_) {}
      bookingEvents.emitTripCompleted(io, updated);
      logger.info('[trip_completed] trip completed', { bookingId, driverId: socket.user.id, endLocation });
    } catch (err) {
      logger.error('[trip_completed] error', err);
      socket.emit('booking_error', { message: 'Failed to complete trip', source: 'trip_completed' });
    }
  });
};
