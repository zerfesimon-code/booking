const bookingSocket = require('./bookingSocket');
const driverSocket = require('./driverSocket');
const passengerSocket = require('./passengerSocket');
const liveSocket = require('./liveSocket');
const { socketAuth } = require('../utils/jwt');
const { setIo } = require('./utils');

function attachSocketHandlers(io) {
  setIo(io);
  io.use(socketAuth);
  io.on('connection', (socket) => {
    bookingSocket(io, socket);
    driverSocket(io, socket);
    passengerSocket(io, socket);
    liveSocket(io, socket);
  });
}

module.exports = { attachSocketHandlers };

