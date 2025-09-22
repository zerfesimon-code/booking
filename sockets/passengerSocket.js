const logger = require('../utils/logger');

module.exports = (io, socket) => {
  // Placeholder for passenger-specific socket events (notifications, etc.).
  socket.on('passenger:ping', (payload) => {
    logger.info('[passenger:ping] received', { socketId: socket.id, payload });
    socket.emit('passenger:pong', { ts: Date.now() });
  });
};

