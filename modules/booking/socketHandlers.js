const logger = require('../../utils/logger');
const geolib = require('geolib');
const mongoose = require('mongoose');
const axios = require('axios');
const { sendMessageToSocketId } = require('../../sockets/utils');
const { Booking, Live } = require('../../models/bookingModels');
const { Driver, Passenger } = require('../../models/userModels');
const { findActiveDrivers } = require('../../sockets/helpers');
const { driverByLocationAndVehicleType } = require('../../services/nearbyDrivers');

function register(io, socket) {
  // booking_request
  socket.on('booking_request', async (payload) => {
    logger.info('[booking_request] Payload received:', payload);
    try {
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingData = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
      const authUser = socket.user;
      if (!authUser || String(authUser.type).toLowerCase() !== 'passenger') {
        return socket.emit('booking_error', { message: 'Unauthorized: passenger token required' });
      }
      const passengerId = socket.user.id;
      bookingData.passengerId = passengerId;
      bookingData.vehicleType = bookingData.vehicleType || 'mini';
      bookingData.status = bookingData.status || 'requested';
      const booking = new Booking(bookingData);
      await booking.save();
      const bookingRoom = `booking:${booking._id}`;
      socket.join(bookingRoom);
      socket.emit('booking:created', { bookingId: String(booking._id) });

      // Broadcast to nearby drivers
      const drivers = await findActiveDrivers();
      const radiusKm = parseInt(process.env.RADIUS_KM || '5', 10);
      const nearbyDrivers = drivers.filter(d => d.lastKnownLocation && (
        geolib.getDistance(
          { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
          { latitude: booking.pickup.latitude, longitude: booking.pickup.longitude }
        ) / 1000
      ) <= radiusKm);
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
      try {
        const nearest = await driverByLocationAndVehicleType({
          latitude: booking.pickup.latitude,
          longitude: booking.pickup.longitude,
          vehicleType: booking.vehicleType,
          radiusKm: parseFloat(process.env.BROADCAST_RADIUS_KM || '5'),
          limit: 5
        });
        const targets = (nearest || []).map(x => x.driver);
        targets.forEach(d => sendMessageToSocketId(`driver:${d._id}`, { event: 'booking:new', data: patch }));
      } catch (e) {
        io.to('drivers').emit('booking:new', patch);
      }
    } catch (err) {
      logger.error('[booking_request] Error:', err);
      socket.emit('booking_error', { message: 'Failed to create booking' });
    }
  });

  // booking_accept
  socket.on('booking_accept', async (payload) => {
    logger.info('[booking_accept] Payload received:', payload);
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingIdRaw = data.bookingId;
      const authUser = socket.user;
      if (!authUser || String(authUser.type).toLowerCase() !== 'driver' || !authUser.id) {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', bookingId: bookingIdRaw });
      }
      if (!bookingIdRaw) {
        return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
      }
      let bookingObjectId;
      try { bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw)); } catch (_) {
        return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
      }
      const now = new Date();
      const accepted = await Booking.findOneAndUpdate(
        { _id: bookingObjectId, status: 'requested' },
        { $set: { status: 'accepted', driverId: String(authUser.id), acceptedAt: now } },
        { new: true }
      ).lean();
      if (!accepted) {
        return socket.emit('booking_error', { message: 'Booking already accepted by another driver or not found', bookingId: bookingIdRaw });
      }
      const bookingId = String(accepted._id);
      const bookingRoom = `booking:${bookingId}`;
      socket.join(bookingRoom);
      const passengerDoc = await Passenger.findById(accepted.passengerId).select('_id name phone').lean();
      const passenger = passengerDoc ? { id: String(passengerDoc._id), name: passengerDoc.name, phone: passengerDoc.phone } : null;
      const patch = {
        bookingId,
        patch: {
          status: 'accepted',
          driverId: String(authUser.id),
          acceptedAt: now.toISOString(),
          driver: {
            id: String(authUser.id),
            name: authUser.name,
            phone: authUser.phone,
            vehicleType: authUser.vehicleType,
            vehicle: { type: authUser.vehicleType, plate: authUser.carPlate, model: authUser.carModel, color: authUser.carColor }
          },
          passenger
        }
      };
      io.to(bookingRoom).emit('booking:update', patch);
      io.to(`driver:${String(authUser.id)}`).emit('booking:accepted', patch);
    } catch (err) {
      logger.error('[booking_accept] Error:', err);
    }
  });

  // booking_cancel
  socket.on('booking_cancel', async (payload) => {
    logger.info('[booking_cancel] Payload received:', payload);
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingIdRaw = data.bookingId;
      const reason = data.reason;
      const authUser = socket.user;
      if (!authUser || !authUser.type) {
        return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId: bookingIdRaw });
      }
      if (!bookingIdRaw) {
        return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
      }
      let bookingObjectId;
      try { bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw)); } catch (_) {
        return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
      }
      const canceledBy = String(authUser.type).toLowerCase() === 'driver' ? 'driver' : 'passenger';
      const updated = await Booking.findOneAndUpdate(
        { _id: bookingObjectId },
        { $set: { status: 'canceled', canceledBy, canceledReason: reason } },
        { new: true }
      ).lean();
      if (!updated) {
        return socket.emit('booking_error', { message: 'Booking not found', bookingId: bookingIdRaw });
      }
      const bookingId = String(updated._id);
      const bookingRoom = `booking:${bookingId}`;
      const patch = { bookingId, patch: { status: 'canceled', canceledBy, canceledReason: reason } };
      io.to(bookingRoom).emit('booking:update', patch);
      const actorRoom = canceledBy === 'driver' ? `driver:${String(authUser.id)}` : `passenger:${String(authUser.id)}`;
      io.to(actorRoom).emit('booking:cancelled', patch);
    } catch (err) {
      logger.error('[booking_cancel] Error:', err);
    }
  });

  // booking:driver_location_update
  socket.on('booking:driver_location_update', async (payload) => {
    try {
      const authUser = socket.user;
      if (!authUser || String(authUser.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'booking:driver_location_update' });
      }
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const latitude = data.latitude != null ? parseFloat(data.latitude) : NaN;
      const longitude = data.longitude != null ? parseFloat(data.longitude) : NaN;
      const bookingIdRaw = data.bookingId;
      const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return socket.emit('booking_error', { message: 'Valid latitude and longitude are required', source: 'booking:driver_location_update' });
      }
      const { lastLocationUpdateAtByDriver } = require('../../sockets/state');
      const throttleMs = parseInt(process.env.LOCATION_UPDATE_THROTTLE_MS || '3000', 10);
      const lastAt = lastLocationUpdateAtByDriver.get(String(authUser.id)) || 0;
      const nowMs = Date.now();
      if (nowMs - lastAt < throttleMs) {
        return;
      }
      lastLocationUpdateAtByDriver.set(String(authUser.id), nowMs);
      let passengerId = undefined;
      if (bookingIdRaw) {
        try {
          const b = await Booking.findById(bookingIdRaw).select({ passengerId: 1 }).lean();
          passengerId = b ? String(b.passengerId) : undefined;
        } catch (_) {}
      }
      try {
        const liveDoc = {
          driverId: String(authUser.id),
          passengerId: passengerId,
          latitude,
          longitude,
          status: 'moving',
          locationType: 'current',
          bookingId: bookingIdRaw ? new mongoose.Types.ObjectId(String(bookingIdRaw)) : undefined,
          timestamp
        };
        await Live.create(liveDoc);
      } catch (e) {}
      const payloadOut = { driverId: String(authUser.id), latitude, longitude, timestamp: timestamp.toISOString(), bookingId: bookingIdRaw ? String(bookingIdRaw) : undefined };
      if (bookingIdRaw) {
        sendMessageToSocketId(`booking:${String(bookingIdRaw)}`, { event: 'booking:driver_location_update', data: payloadOut });
      }
      sendMessageToSocketId(`driver:${String(authUser.id)}`, { event: 'booking:driver_location_update', data: payloadOut });
    } catch (err) {
      logger.error('[booking:driver_location_update] Error:', err);
      socket.emit('booking_error', { message: 'Failed to process location update', source: 'booking:driver_location_update' });
    }
  });

  // booking:status_request
  socket.on('booking:status_request', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingIdRaw = data.bookingId;
      if (!bookingIdRaw) {
        return socket.emit('booking_error', { message: 'bookingId is required', source: 'booking:status_request' });
      }
      let booking = null;
      try { booking = await Booking.findById(bookingIdRaw).lean(); } catch (_) {}
      if (!booking) {
        return socket.emit('booking_error', { message: 'Booking not found', bookingId: bookingIdRaw, source: 'booking:status_request' });
      }
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
      logger.error('[booking:status_request] Error:', err);
      socket.emit('booking_error', { message: 'Failed to fetch booking status', source: 'booking:status_request' });
    }
  });
}

module.exports = { register };

