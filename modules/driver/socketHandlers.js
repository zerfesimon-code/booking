const logger = require('../../utils/logger');
const { Driver } = require('../../models/userModels');
const { sendMessageToSocketId } = require('../../sockets/utils');

function register(io, socket) {
  // driver:availability
  socket.on('driver:availability', async (payload) => {
    try {
      const authUser = socket.user;
      if (!authUser || String(authUser.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'driver:availability' });
      }
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const available = typeof data.available === 'boolean' ? data.available : undefined;
      if (available == null) return socket.emit('booking_error', { message: 'available boolean is required', source: 'driver:availability' });
      await Driver.findByIdAndUpdate(authUser.id, { available });
      socket.user.available = available;
      sendMessageToSocketId(`driver:${String(authUser.id)}`, { event: 'driver:availability', data: { driverId: String(authUser.id), available } });
    } catch (err) {
      logger.error('[driver:availability] Error:', err);
      socket.emit('booking_error', { message: 'Failed to update availability', source: 'driver:availability' });
    }
  });
}

module.exports = { register };

