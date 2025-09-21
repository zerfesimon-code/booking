const logger = require('../utils/logger');
const { Booking } = require('../models/bookingModels');
const { Driver, Passenger } = require('../models/userModels');

async function joinBookingRooms(socket, user) {
  if (!user || !user.id) return;
  try {
    const userType = String(user.type).toLowerCase();
    let query = {};
    if (userType === 'driver') {
      query = { driverId: String(user.id), status: { $in: ['accepted', 'ongoing'] } };
    } else if (userType === 'passenger') {
      query = { passengerId: String(user.id), status: { $in: ['requested', 'accepted', 'ongoing'] } };
    }
    logger.info('[joinBookingRooms] Booking.find query:', query);
    const activeBookings = await Booking.find(query).select('_id').lean();
    activeBookings.forEach(booking => {
      const room = `booking:${String(booking._id)}`;
      socket.join(room);
      logger.info(`[joinBookingRooms] ${userType} ${user.id} joined booking room ${room}`);
    });
  } catch (err) {
    logger.error('[joinBookingRooms] Error:', err);
  }
}

async function findActiveDrivers() {
  logger.info('[findActiveDrivers] Driver.find query:', { available: true });
  return Driver.find({ available: true }).lean();
}

async function resolveDriverFromToken(decoded) {
  if (!decoded) return null;
  const id = decoded.id ? String(decoded.id) : null;
  const phone = decoded.phone || decoded.phoneNumber || decoded.mobile;
  const email = decoded.email;
  const externalId = decoded.externalId || decoded.userExternalId;
  const candidates = [];
  if (id) candidates.push({ _id: id });
  if (externalId) candidates.push({ externalId });
  if (phone) candidates.push({ phone });
  if (email) candidates.push({ email });
  for (const query of candidates) {
    logger.info('[resolveDriverFromToken] Driver.findOne query:', query);
    const doc = await Driver.findOne(query).lean();
    if (doc) return doc;
  }
  return null;
}

async function resolvePassengerIdFromToken(decoded) {
  if (!decoded) return null;
  const id = decoded.id ? String(decoded.id) : null;
  const name = decoded.name;
  const phone = decoded.phone || decoded.phoneNumber || decoded.mobile;
  const email = decoded.email;
  const externalId = decoded.externalId || decoded.userExternalId;
  if (id) {
    try {
      const p = await Passenger.findById(id).select({ _id: 1 }).lean();
      if (p) return { id: String(p._id), name: p.name, phone: p.phone };
    } catch (_) {}
  }
  const altQueries = [];
  if (externalId) altQueries.push({ externalId });
  if (phone) altQueries.push({ phone });
  if (email) altQueries.push({ email });
  for (const q of altQueries) {
    const p = await Passenger.findOne(q).select({ _id: 1 }).lean();
    if (p) return { id: String(p._id), name: p.name, phone: p.phone };
  }
  return { id: id, name: name, phone: phone };
}

module.exports = { joinBookingRooms, findActiveDrivers, resolveDriverFromToken, resolvePassengerIdFromToken };

