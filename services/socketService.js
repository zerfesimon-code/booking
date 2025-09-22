const { setIo } = require('../sockets/utils');
const logger = require('../utils/logger');
const { socketAuth } = require('../utils/jwt');
const registerDriverSocketHandlers = require('../modules/driver/driverSocketHandlers');
const bookingSocket = require('../sockets/bookingSocket');
const driverSocket = require('../sockets/driverSocket');
const passengerSocket = require('../sockets/passengerSocket');
const liveSocket = require('../sockets/liveSocket');

function initializeSocket(io) {
  setIo(io);
  io.use(socketAuth);
  // Temporarily widen listener cap for testing
  try { io.setMaxListeners(100); } catch (_) {}
  io.on('connection', (socket) => {
    logger.info('[socket] connection', { socketId: socket.id, user: socket.user });
    try { socket.setMaxListeners(50); } catch (_) {}
    // Initialize driver lastKnownLocation from handshake if provided
    try {
      const userType = String(socket.user && socket.user.type || '').toLowerCase();
      if (userType === 'driver' && socket.user && socket.user.id) {
        const auth = socket.handshake && socket.handshake.auth || {};
        const query = socket.handshake && socket.handshake.query || {};
        const rawLat = auth.latitude ?? auth.lat ?? query.latitude ?? query.lat;
        const rawLng = auth.longitude ?? auth.lng ?? query.longitude ?? query.lng;
        const rawBearing = auth.bearing ?? query.bearing;
        const latitude = rawLat != null ? Number(rawLat) : undefined;
        const longitude = rawLng != null ? Number(rawLng) : undefined;
        const bearing = rawBearing != null ? Number(rawBearing) : undefined;
        const hasValidLatLon = Number.isFinite(latitude) && Number.isFinite(longitude);
        if (hasValidLatLon) {
          const driverService = require('./driverService');
          driverService.updateLocation(String(socket.user.id), { latitude, longitude, bearing }, socket.user)
            .then((d) => {
              logger.info('[socket] initialized driver location from handshake', { driverId: String(d._id), lastKnownLocation: d.lastKnownLocation });
            })
            .catch((e) => {
              logger.warn('[socket] failed to initialize driver location from handshake', { error: e && e.message });
            });
        }
      }
    } catch (e) {
      logger.warn('[socket] error while attempting initial location update', { error: e && e.message });
    }
    // Join identity-scoped rooms for targeted messaging
    try {
      if (socket.user && socket.user.id) {
        const userId = String(socket.user.id);
        const userType = String(socket.user.type || '').toLowerCase();
        if (userType === 'driver') {
          const room = `driver:${userId}`;
          socket.join(room);
          logger.info('[socket] joined driver room', { socketId: socket.id, room });
        }
        if (userType === 'passenger') {
          const room = `passenger:${userId}`;
          socket.join(room);
          logger.info('[socket] joined passenger room', { socketId: socket.id, room });
        }
      }
    } catch (e) {
      logger.warn('[socket] failed to join identity room', { error: e && e.message });
    }
    if (socket._handlersAttached) {
      return;
    }
    socket._handlersAttached = true;
    // Attach all handlers exactly once per socket
    try {
      bookingSocket(io, socket);
      driverSocket(io, socket);
      passengerSocket(io, socket);
      liveSocket(io, socket);
    } catch (_) {}
    // Additional modular driver handlers can coexist
    registerDriverSocketHandlers(io, socket);
    socket.on('disconnect', () => {
      logger.info('[socket] disconnect', { socketId: socket.id, user: socket.user });
    });
  });
}

module.exports = { initializeSocket };

