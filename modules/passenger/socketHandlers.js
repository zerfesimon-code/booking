const logger = require('../../utils/logger');

function register(io, socket) {
  socket.on('passenger_connect', async () => {
    try {
      const user = socket.user;
      if (!user || user.type !== 'passenger') return;
      socket.join(`passenger:${user.id}`);
      socket.emit('passenger_connected', { id: user.id });
    } catch (e) {
      logger.error('[passenger_connect] Error:', e);
    }
  });

  socket.on('passenger_update', async (payload) => {
    try {
      const user = socket.user;
      if (!user || user.type !== 'passenger') return;
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      socket.to(`passenger:${user.id}`).emit('passenger_update', data);
    } catch (e) {
      logger.error('[passenger_update] Error:', e);
    }
  });
}

module.exports = { register };

