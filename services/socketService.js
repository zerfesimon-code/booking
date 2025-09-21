const { setIo } = require('../sockets/utils');
const logger = require('../utils/logger');
const { socketAuth } = require('../utils/jwt');

// Module handlers
const registerBookingSocketHandlers = require('../modules/booking/bookingSocketHandlers');
const registerDriverSocketHandlers = require('../modules/driver/driverSocketHandlers');

function initializeSocket(io) {
  setIo(io);
  io.use(socketAuth);
  io.on('connection', (socket) => {
    logger.info('[socket] connection', { socketId: socket.id, user: socket.user });
    // Register per-domain handlers
    registerBookingSocketHandlers(io, socket);
    registerDriverSocketHandlers(io, socket);

    socket.on('disconnect', () => {
      logger.info('[socket] disconnect', { socketId: socket.id, user: socket.user });
    });
  });
}

module.exports = { initializeSocket };

