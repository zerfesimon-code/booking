const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
require('dotenv').config();
const { setIo } = require('./utils');
const { joinBookingRooms, resolveDriverFromToken, resolvePassengerIdFromToken } = require('./helpers');
const bookingHandlers = require('../modules/booking/socketHandlers');
const driverHandlers = require('../modules/driver/socketHandlers');
const passengerHandlers = require('../modules/passenger/socketHandlers');

let ioRef;

function attachSocketHandlers(io) {
  if (ioRef) {
    console.warn('[attachSocketHandlers] Socket server already attached. Overwriting ioRef.');
  }
  ioRef = io;
  try { setIo(io); } catch (_) {}

  io.on('connection', async (socket) => {
    logger.info(`[connection] New socket connected: ${socket.id}`);

    let user = null;
    try {
      const rawToken = socket.handshake.auth?.token
        || socket.handshake.query?.token
        || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (rawToken) {
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'secret');
        logger.info('[connection] Decoded JWT:', decoded);

        const normalizedType = decoded && decoded.type ? String(decoded.type).toLowerCase() : '';

        if (normalizedType === 'driver') {
          const driverDoc = await resolveDriverFromToken(decoded);
          const driverId = driverDoc ? String(driverDoc._id) : (decoded.id ? String(decoded.id) : undefined);
          user = { 
            type: 'driver', 
            id: driverId, 
            vehicleType: (driverDoc && driverDoc.vehicleType) ? driverDoc.vehicleType : decoded.vehicleType, 
            name: driverDoc?.name || decoded.name, 
            phone: driverDoc?.phone || (decoded.phone || decoded.phoneNumber || decoded.mobile) 
          };
          socket.authToken = rawToken;

          const q = socket.handshake.query || {};
          const defLat = q.latitude != null ? parseFloat(q.latitude) : undefined;
          const defLng = q.longitude != null ? parseFloat(q.longitude) : undefined;
          const defRadius = q.radiusKm != null ? parseFloat(q.radiusKm) : undefined;
          const defVehicleType = q.vehicleType || undefined;
          const defLimit = q.limit != null ? parseInt(q.limit, 10) : undefined;
          socket.nearbyDefaults = {
            latitude: Number.isFinite(defLat) ? defLat : undefined,
            longitude: Number.isFinite(defLng) ? defLng : undefined,
            radiusKm: Number.isFinite(defRadius) ? defRadius : undefined,
            vehicleType: defVehicleType || user.vehicleType,
            limit: Number.isFinite(defLimit) ? defLimit : undefined,
          };

          socket.user = user;
          logger.info('[connection] Authenticated driver:', user);

          if (driverId) {
            const room = `driver:${driverId}`;
            socket.join(room);
            socket.join('drivers');
            logger.info(`[connection] Driver ${driverId} joined rooms: ${room}, 'drivers'`);
            await joinBookingRooms(socket, user);
          }
        } else if (normalizedType === 'passenger') {
          const passengerId = await resolvePassengerIdFromToken(decoded);
          user = { type: 'passenger', id: passengerId.id || (decoded.id ? String(decoded.id) : undefined), name: passengerId.name, phone: passengerId.phone };
          socket.user = user;
          logger.info('[connection] Authenticated passenger:', user);

          if (user.id) {
            socket.join(`passenger:${user.id}`);
            await joinBookingRooms(socket, user);
          }
        } else {
          throw new Error('Unsupported user type');
        }
      }
    } catch (err) {
      logger.error('[connection] Socket auth error:', err);
      socket.disconnect(true);
      return;
    }

    // Register feature handlers
    bookingHandlers.register(io, socket);
    driverHandlers.register(io, socket);
    passengerHandlers.register(io, socket);

    socket.on('disconnect', () => {
      logger.info(`[disconnect] Socket disconnected: ${socket.id}`);
      if (socket.user && socket.user.id) {
        logger.info(`[disconnect] ${socket.user.type} ${socket.user.id} disconnected and left all rooms`);
      }
    });
  });
}

module.exports = { attachSocketHandlers };

