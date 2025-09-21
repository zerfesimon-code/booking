let ioRef;
const jwt = require('jsonwebtoken');
const geolib = require('geolib');
const mongoose = require('mongoose');
const axios = require('axios');
const { logger } = require('../utils/logger');
const { getDriverById } = require('../integrations/userServiceClient');
require('dotenv').config();

// Models
const { Booking, Live } = require('../models/bookingModels');
const { Driver, Passenger } = require('../models/userModels');
const { driverByLocationAndVehicleType } = require('../services/nearbyDrivers');
const { sendMessageToSocketId, setIo } = require('./utils');

// In-memory storage for booking notes (last N notes per booking)
const bookingNotes = new Map();
const MAX_NOTES_PER_BOOKING = 50;

// Helper: join user to booking tunnel rooms for their active bookings
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

    logger.dbOperation('find', 'Booking', query);
    const activeBookings = await Booking.find(query).select('_id').lean();
    
    logger.businessEvent('user_joining_booking_rooms', user.id, {
      userType: userType,
      activeBookingsCount: activeBookings.length
    });
    
    activeBookings.forEach(booking => {
      const room = `booking:${String(booking._id)}`;
      socket.join(room);
      logger.socketEvent('room_joined', socket.id, { room: room }, {
        userId: user.id,
        userType: userType,
        bookingId: booking._id
      });
    });
  } catch (err) {
    logger.error('Failed to join booking rooms', {
      error: err.message,
      userId: user?.id,
      userType: user?.type
    });
  }
}

// Helper: get stored notes for a booking
function getStoredNotes(bookingId) {
  return bookingNotes.get(String(bookingId)) || [];
}

// Helper: find all active drivers
async function findActiveDrivers() {
  logger.dbOperation('find', 'Driver', { available: true });
  return Driver.find({ available: true }).lean();
}

// Throttle map for live location updates per driver
const lastLocationUpdateAtByDriver = new Map();

// Resolve a canonical driver document from token claims
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
    logger.dbOperation('findOne', 'Driver', query);
    const doc = await Driver.findOne(query).lean();
    if (doc) return doc;
  }
  return null;
}

// Resolve a canonical passenger id from token claims
async function resolvePassengerIdFromToken(decoded) {
  if (!decoded) return null;
  const id = decoded.id ? String(decoded.id) : null;
  const name = decoded.name;
  const phone = decoded.phone || decoded.phoneNumber || decoded.mobile;
  const email = decoded.email;
  const externalId = decoded.externalId || decoded.userExternalId;

  if (id) {
    try {
      logger.dbOperation('findById', 'Passenger', { _id: id });
      const p = await Passenger.findById(id).select({ _id: 1 }).lean();
      if (p) return { id: String(p._id), name: p.name, phone: p.phone };
      
    } catch (_) {}
  }

  const altQueries = [];
  if (externalId) altQueries.push({ externalId });
  if (phone) altQueries.push({ phone });
  if (email) altQueries.push({ email });
  for (const q of altQueries) {
    logger.dbOperation('findOne', 'Passenger', q);
    const p = await Passenger.findOne(q).select({ _id: 1 }).lean();
    if (p) return { id: String(p._id), name: p.name, phone: p.phone };
  }

  return { id: id, name: name, phone: phone };
}

function attachSocketHandlers(io) {
  if (ioRef) {
    console.warn('[attachSocketHandlers] Socket server already attached. Overwriting ioRef.');
  }
  ioRef = io;
  try { setIo(io); } catch (_) {}

  io.on('connection', async (socket) => {
    logger.socketEvent('connection', socket.id, {}, {
      userAgent: socket.handshake.headers['user-agent'],
      ip: socket.handshake.address,
      timestamp: new Date().toISOString()
    });

    let user = null;

    // --- Authenticate user on connect ---
    try {
      const rawToken = socket.handshake.auth?.token
        || socket.handshake.query?.token
        || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (rawToken) {
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'secret');
        logger.socketEvent('authentication_attempt', socket.id, { 
          userType: decoded.type,
          userId: decoded.id 
        }, {
          hasToken: !!rawToken,
          tokenLength: rawToken.length
        });

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
          // Persist auth token on socket for later service calls
          socket.authToken = rawToken;

          // Store default nearby search params from handshake
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

          // If vehicleType or vehicle details are missing, hydrate from User Service
          if (driverId && (!user.vehicleType || !user.carPlate || !user.carModel || !user.carColor)) {
            try {
              const authHeader = rawToken ? { Authorization: rawToken.startsWith('Bearer ') ? rawToken : `Bearer ${rawToken}` } : undefined;
              const driverProfile = await getDriverById(driverId, { headers: authHeader || {} });
              if (driverProfile) {
                user.vehicleType = user.vehicleType || driverProfile.vehicleType;
                user.carPlate = driverProfile.carPlate;
                user.carModel = driverProfile.carModel;
                user.carColor = driverProfile.carColor;
              }
            } catch (_) {}
          }
          socket.user = user;
          logger.socketEvent('driver_authenticated', socket.id, user, {
            vehicleType: user.vehicleType,
            hasCarDetails: !!(user.carPlate && user.carModel && user.carColor)
          });

          if (driverId) {
            const room = `driver:${driverId}`;
            socket.join(room);
            socket.join('drivers');
            logger.info(`[connection] Driver ${driverId} joined rooms: ${room}, 'drivers'`);

            await joinBookingRooms(socket, user);
          }
        } else if (normalizedType === 'passenger') {
          const passengerId = await resolvePassengerIdFromToken(decoded);
          const passengerDetails = {
            id: passengerId.id,
            name: passengerId.name,
            phone: passengerId.phone,
          };
          user = { type: 'passenger', id: passengerId.id || (decoded.id ? String(decoded.id) : undefined), name: passengerId.name, phone: passengerId.phone };
          socket.user = user;
          logger.socketEvent('passenger_authenticated', socket.id, user, {
            hasName: !!user.name,
            hasPhone: !!user.phone
          });

          if (user.id) {
            socket.join(`passenger:${user.id}`);
            await joinBookingRooms(socket, user);
          }
        } else {
          throw new Error('Unsupported user type');
        }
      }
    } catch (err) {
      logger.socketEvent('authentication_failed', socket.id, {}, {
        error: err.message,
        errorType: err.name
      });
      socket.disconnect(true);
      return;
    }

  // --- booking_request ---
socket.on('booking_request', async (payload) => {
  logger.socketEvent('booking_request', socket.id, payload, {
    userType: socket.user?.type,
    userId: socket.user?.id
  });
  
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    const bookingData = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    const authUser = socket.user;
    
    logger.businessEvent('booking_request_initiated', authUser?.id, {
      vehicleType: bookingData.vehicleType,
      hasPickup: !!(bookingData.pickup?.latitude && bookingData.pickup?.longitude),
      hasDropoff: !!(bookingData.dropoff?.latitude && bookingData.dropoff?.longitude)
    });

    if (!authUser || String(authUser.type).toLowerCase() !== 'passenger') {
      return socket.emit('booking_error', { message: 'Unauthorized: passenger token required' });
    }

    const passengerId = socket.user.id;
    bookingData.passengerId = passengerId;
    bookingData.vehicleType = bookingData.vehicleType || 'mini';
    bookingData.status = bookingData.status || 'requested';

    logger.dbOperation('create', 'Booking', bookingData);
    const booking = new Booking(bookingData);
    await booking.save();
    
    logger.businessEvent('booking_created', authUser.id, {
      bookingId: booking._id,
      vehicleType: booking.vehicleType,
      status: booking.status
    });

    const bookingRoom = `booking:${booking._id}`;
    socket.join(bookingRoom);
    logger.socketEvent('room_joined', socket.id, { room: bookingRoom }, {
      userId: passengerId,
      userType: 'passenger'
    });

    // <-- Emit bookingId back to the passenger immediately
    socket.emit('booking:created', { bookingId: String(booking._id) });

    // --- broadcast to nearby drivers (existing logic) ---
    const drivers = await findActiveDrivers();
    const radiusKm = parseInt(process.env.RADIUS_KM || '5', 10);
    const nearbyDrivers = drivers.filter(d => d.lastKnownLocation && (
      geolib.getDistance(
        { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
        { latitude: booking.pickup.latitude, longitude: booking.pickup.longitude }
      ) / 1000
    ) <= radiusKm);

    logger.businessEvent('nearby_drivers_found', authUser.id, {
      bookingId: booking._id,
      nearbyDriverCount: nearbyDrivers.length,
      driverIds: nearbyDrivers.map(d => d._id)
    });

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
    logger.socketEvent('booking_broadcast_prepare', socket.id, patch, {
      bookingId: booking._id
    });
    
    try {
      const nearest = await driverByLocationAndVehicleType({
        latitude: booking.pickup.latitude,
        longitude: booking.pickup.longitude,
        vehicleType: booking.vehicleType,
        radiusKm: parseFloat(process.env.BROADCAST_RADIUS_KM || '5'),
        limit: 5
      });
      const targets = (nearest || []).map(x => x.driver);
      
      if (targets.length === 0) {
        logger.businessEvent('no_nearby_drivers', authUser.id, {
          bookingId: booking._id,
          vehicleType: booking.vehicleType
        });
      }
      
      targets.forEach(d => {
        logger.socketEvent('booking_broadcast_send', socket.id, { driverId: d._id }, {
          bookingId: booking._id,
          targetDriver: d._id
        });
        
        try {
          sendMessageToSocketId(`driver:${d._id}`, { event: 'booking:new', data: patch });
        } catch (e) {
          logger.socketEvent('booking_broadcast_failed', socket.id, { driverId: d._id }, {
            error: e.message,
            bookingId: booking._id
          });
        }
      });
    } catch (e) {
      logger.socketEvent('booking_broadcast_fallback', socket.id, {}, {
        error: e.message,
        bookingId: booking._id
      });
      io.to('drivers').emit('booking:new', patch);
    }

  } catch (err) {
    logger.socketEvent('booking_request_failed', socket.id, {}, {
      error: err.message,
      userId: socket.user?.id,
      userType: socket.user?.type
    });
    socket.emit('booking_error', { message: 'Failed to create booking' });
  }
});

// --- booking_accept ---
socket.on('booking_accept', async (payload) => {
  logger.socketEvent('booking_accept', socket.id, payload, {
    userType: socket.user?.type,
    userId: socket.user?.id
  });
  
  try {
    const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    const bookingIdRaw = data.bookingId;
    const authUser = socket.user;
    
    logger.businessEvent('booking_accept_attempted', authUser?.id, {
      bookingId: bookingIdRaw,
      driverId: authUser?.id
    });

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
    logger.dbOperation('findOneAndUpdate', 'Booking', {
      query: { _id: bookingObjectId, status: 'requested' },
      update: { status: 'accepted', driverId: String(authUser.id), acceptedAt: now }
    });
    
    const accepted = await Booking.findOneAndUpdate(
      { _id: bookingObjectId, status: 'requested' },
      { $set: { status: 'accepted', driverId: String(authUser.id), acceptedAt: now } },
      { new: true }
    ).lean();

    if (!accepted) {
      logger.businessEvent('booking_accept_failed', authUser.id, {
        bookingId: bookingIdRaw,
        reason: 'already_accepted_or_not_found'
      });
      return socket.emit('booking_error', { message: 'Booking already accepted by another driver or not found', bookingId: bookingIdRaw });
    }

    const bookingId = String(accepted._id);
    const bookingRoom = `booking:${bookingId}`;
    socket.join(bookingRoom);
    
    logger.businessEvent('booking_accepted', authUser.id, {
      bookingId: bookingId,
      driverId: authUser.id,
      acceptedAt: now.toISOString()
    });

    // --- include passenger info so it doesn't disappear ---
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
          vehicle: {
            type: authUser.vehicleType,
            plate: authUser.carPlate,
            model: authUser.carModel,
            color: authUser.carColor,
          }
        },
        passenger 
      }
    };

    logger.socketEvent('booking_update_broadcast', socket.id, patch, {
      bookingId: bookingId,
      targetRoom: bookingRoom
    });
    
    io.to(bookingRoom).emit('booking:update', patch);
    io.to(`driver:${String(authUser.id)}`).emit('booking:accepted', patch);

    // Notify other nearby drivers to remove this booking from their lists
    try {
      const drivers = await findActiveDrivers();
      const radiusKm = parseFloat(process.env.RADIUS_KM || process.env.BROADCAST_RADIUS_KM || '5');
      const vehicleType = accepted.vehicleType;
      const nearby = drivers.filter(d => (
        d && d._id && String(d._id) !== String(authUser.id) &&
        d.lastKnownLocation &&
        (!vehicleType || String(d.vehicleType || '').toLowerCase() === String(vehicleType || '').toLowerCase()) &&
        (
          geolib.getDistance(
            { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
            { latitude: accepted.pickup?.latitude, longitude: accepted.pickup?.longitude }
          ) / 1000
        ) <= radiusKm
      ));
      nearby.forEach(d => {
        logger.socketEvent('booking_removed_notify', socket.id, { driverId: d._id }, {
          bookingId: bookingId,
          targetDriver: d._id
        });
        sendMessageToSocketId(`driver:${String(d._id)}`, { event: 'booking:removed', data: { bookingId } });
      });
    } catch (e) {
      logger.socketEvent('booking_removed_notify_failed', socket.id, {}, {
        error: e.message,
        bookingId: bookingId
      });
    }

  } catch (err) {
    logger.socketEvent('booking_accept_failed', socket.id, {}, {
      error: err.message,
      userId: socket.user?.id,
      userType: socket.user?.type
    });
  }
});

    // --- booking_cancel ---
    socket.on('booking_cancel', async (payload) => {
      logger.socketEvent('booking_cancel', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const reason = data.reason;
        const authUser = socket.user;
        
        logger.businessEvent('booking_cancel_attempted', authUser?.id, {
          bookingId: bookingIdRaw,
          reason: reason,
          canceledBy: authUser?.type
        });

        if (!authUser || !authUser.type) {
          return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId: bookingIdRaw });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
        }

        const canceledBy = String(authUser.type).toLowerCase() === 'driver' ? 'driver' : 'passenger';

        logger.dbOperation('findOneAndUpdate', 'Booking', {
          query: { _id: String(bookingObjectId) },
          update: { status: 'canceled', canceledBy, canceledReason: reason }
        });
        
        const updated = await Booking.findOneAndUpdate(
          { _id: bookingObjectId },
          { $set: { status: 'canceled', canceledBy, canceledReason: reason } },
          { new: true }
        ).lean();

        if (!updated) {
          logger.businessEvent('booking_cancel_failed', authUser.id, {
            bookingId: bookingIdRaw,
            reason: 'booking_not_found'
          });
          return socket.emit('booking_error', { message: 'Booking not found', bookingId: bookingIdRaw });
        }

        const bookingId = String(updated._id);
        const bookingRoom = `booking:${bookingId}`;

        const patch = {
          bookingId,
          patch: { status: 'canceled', canceledBy, canceledReason: reason }
        };

        logger.businessEvent('booking_canceled', authUser.id, {
          bookingId: bookingId,
          canceledBy: canceledBy,
          reason: reason
        });

        io.to(bookingRoom).emit('booking:update', patch);
        const actorRoom = canceledBy === 'driver' ? `driver:${String(authUser.id)}` : `passenger:${String(authUser.id)}`;
        io.to(actorRoom).emit('booking:cancelled', patch);
        
        logger.socketEvent('booking_cancel_broadcast', socket.id, patch, {
          bookingId: bookingId,
          canceledBy: canceledBy
        });

      } catch (err) {
        logger.socketEvent('booking_cancel_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
      }
    });

    // --- booking_note ---
    socket.on('booking_note', async (payload) => {
      logger.socketEvent('booking_note', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const message = data.message;
        const authUser = socket.user;
        
        logger.businessEvent('booking_note_sent', authUser?.id, {
          bookingId: bookingIdRaw,
          messageLength: message?.length || 0,
          senderType: authUser?.type
        });

        if (!authUser || !authUser.type || !bookingIdRaw || !message) {
          return socket.emit('booking_error', { message: 'Invalid note or unauthorized', bookingId: bookingIdRaw });
        }

        const note = {
          bookingId: String(bookingIdRaw),
          sender: String(authUser.type).toLowerCase(),
          message: message.trim(),
          timestamp: new Date().toISOString()
        };

        if (!bookingNotes.has(String(bookingIdRaw))) bookingNotes.set(String(bookingIdRaw), []);
        const notes = bookingNotes.get(String(bookingIdRaw));
        notes.push(note);
        if (notes.length > MAX_NOTES_PER_BOOKING) notes.splice(0, notes.length - MAX_NOTES_PER_BOOKING);

        io.to(`booking:${String(bookingIdRaw)}`).emit('booking:note', note);
        
        logger.socketEvent('booking_note_broadcast', socket.id, note, {
          bookingId: bookingIdRaw,
          senderType: authUser.type
        });

      } catch (err) {
        logger.socketEvent('booking_note_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
      }
    });

    // --- booking_notes_fetch ---
    socket.on('booking_notes_fetch', async (payload) => {
      logger.socketEvent('booking_notes_fetch', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const authUser = socket.user;

        if (!authUser || !bookingIdRaw) {
          return socket.emit('booking_error', { message: 'Unauthorized or missing bookingId', bookingId: bookingIdRaw });
        }

        const notes = getStoredNotes(bookingIdRaw);
        socket.emit('booking:notes_history', { bookingId: String(bookingIdRaw), notes });
        
        logger.businessEvent('booking_notes_fetched', authUser.id, {
          bookingId: bookingIdRaw,
          notesCount: notes.length
        });

      } catch (err) {
        logger.socketEvent('booking_notes_fetch_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
      }
    });

    // --- booking:driver_location_update ---
    socket.on('booking:driver_location_update', async (payload) => {
      logger.socketEvent('driver_location_update', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
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

        const throttleMs = parseInt(process.env.LOCATION_UPDATE_THROTTLE_MS || '3000', 10);
        const lastAt = lastLocationUpdateAtByDriver.get(String(authUser.id)) || 0;
        const nowMs = Date.now();
        if (nowMs - lastAt < throttleMs) {
          logger.debug('Location update throttled', {
            driverId: authUser.id,
            throttleMs: throttleMs,
            timeSinceLastUpdate: nowMs - lastAt
          });
          return; // silently drop to throttle
        }
        lastLocationUpdateAtByDriver.set(String(authUser.id), nowMs);

        // Persist live location
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
          logger.dbOperation('create', 'Live', liveDoc);
          await Live.create(liveDoc);
        } catch (e) {
          logger.error('Failed to create live location record', {
            error: e.message,
            driverId: authUser.id
          });
        }

        const payloadOut = {
          driverId: String(authUser.id),
          latitude,
          longitude,
          timestamp: timestamp.toISOString(),
          bookingId: bookingIdRaw ? String(bookingIdRaw) : undefined
        };

        logger.businessEvent('driver_location_updated', authUser.id, {
          latitude,
          longitude,
          bookingId: bookingIdRaw,
          timestamp: timestamp.toISOString()
        });

        if (bookingIdRaw) {
          sendMessageToSocketId(`booking:${String(bookingIdRaw)}`, { event: 'booking:driver_location_update', data: payloadOut });
        }
        sendMessageToSocketId(`driver:${String(authUser.id)}`, { event: 'booking:driver_location_update', data: payloadOut });
      } catch (err) {
        logger.socketEvent('driver_location_update_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
        socket.emit('booking_error', { message: 'Failed to process location update', source: 'booking:driver_location_update' });
      }
    });

    // --- booking:status_request ---
    socket.on('booking:status_request', async (payload) => {
      logger.socketEvent('booking_status_request', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required', source: 'booking:status_request' });
        }
        
        logger.dbOperation('findById', 'Booking', { _id: bookingIdRaw });
        let booking = null;
        try {
          booking = await Booking.findById(bookingIdRaw).lean();
        } catch (_) {}
        
        if (!booking) {
          logger.businessEvent('booking_status_not_found', socket.user?.id, {
            bookingId: bookingIdRaw
          });
          return socket.emit('booking_error', { message: 'Booking not found', bookingId: bookingIdRaw, source: 'booking:status_request' });
        }
        
        logger.businessEvent('booking_status_fetched', socket.user?.id, {
          bookingId: bookingIdRaw,
          status: booking.status
        });
        
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
        logger.socketEvent('booking_status_request_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
        socket.emit('booking_error', { message: 'Failed to fetch booking status', source: 'booking:status_request' });
      }
    });

    // --- booking:ETA_update ---
    socket.on('booking:ETA_update', async (payload) => {
      logger.socketEvent('booking_eta_update', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const authUser = socket.user;
        if (!authUser || String(authUser.type).toLowerCase() !== 'driver') {
          return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'booking:ETA_update' });
        }
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const etaMinutes = data.etaMinutes != null ? parseInt(data.etaMinutes, 10) : undefined;
        const message = data.message || undefined;
        if (!bookingIdRaw || !Number.isFinite(etaMinutes)) {
          return socket.emit('booking_error', { message: 'bookingId and etaMinutes are required', source: 'booking:ETA_update' });
        }
        
        logger.dbOperation('findById', 'Booking', { _id: bookingIdRaw });
        const booking = await Booking.findById(bookingIdRaw).lean();
        if (!booking) return socket.emit('booking_error', { message: 'Booking not found', source: 'booking:ETA_update' });
        if (String(booking.driverId || '') !== String(authUser.id)) {
          return socket.emit('booking_error', { message: 'Only assigned driver can send ETA', source: 'booking:ETA_update' });
        }
        
        logger.businessEvent('eta_updated', authUser.id, {
          bookingId: bookingIdRaw,
          etaMinutes: etaMinutes,
          hasMessage: !!message
        });
        
        const out = { bookingId: String(booking._id), etaMinutes, message, driverId: String(authUser.id), timestamp: new Date().toISOString() };
        sendMessageToSocketId(`booking:${String(booking._id)}`, { event: 'booking:ETA_update', data: out });
      } catch (err) {
        logger.socketEvent('booking_eta_update_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
        socket.emit('booking_error', { message: 'Failed to process ETA update', source: 'booking:ETA_update' });
      }
    });

    // --- booking:completed ---
    socket.on('booking:completed', async (payload) => {
      logger.socketEvent('booking_completed', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const authUser = socket.user;
        if (!authUser || String(authUser.type).toLowerCase() !== 'driver') {
          return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'booking:completed' });
        }
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        if (!bookingIdRaw) return socket.emit('booking_error', { message: 'bookingId is required', source: 'booking:completed' });

        logger.dbOperation('findOne', 'Booking', { _id: bookingIdRaw, driverId: String(authUser.id) });
        const booking = await Booking.findOne({ _id: bookingIdRaw, driverId: String(authUser.id) });
        if (!booking) return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'booking:completed' });

        // Update booking status
        booking.status = 'completed';
        booking.completedAt = new Date();
        if (!booking.fareFinal) booking.fareFinal = booking.fareEstimated;
        
        logger.businessEvent('booking_completion_initiated', authUser.id, {
          bookingId: bookingIdRaw,
          fareFinal: booking.fareFinal,
          fareEstimated: booking.fareEstimated
        });
        
        await booking.save();

        // Update driver wallet for earnings
        try {
          const { Wallet, Transaction } = require('../models/common');
          const grossFare = booking.fareFinal || booking.fareEstimated || 0;
          const { Commission } = require('../models/commission');
          const commission = await Commission.findOne({ isActive: true }).sort({ createdAt: -1 });
          const commissionRate = commission ? commission.percentage : 15;
          const commissionAmount = (grossFare * commissionRate) / 100;
          const netEarnings = grossFare - commissionAmount;
          logger.dbOperation('updateOne', 'Wallet', { 
            userId: String(authUser.id), 
            role: 'driver', 
            inc: { balance: netEarnings, totalEarnings: netEarnings } 
          });
          await Wallet.updateOne(
            { userId: String(authUser.id), role: 'driver' },
            { $inc: { balance: netEarnings, totalEarnings: netEarnings } },
            { upsert: true }
          );
          const txDoc = {
            userId: String(authUser.id),
            role: 'driver',
            amount: netEarnings,
            type: 'credit',
            method: booking.paymentMethod || 'cash',
            status: 'success',
            metadata: { bookingId: String(booking._id), reason: 'Trip earnings (socket)' }
          };
          logger.dbOperation('create', 'Transaction', txDoc);
          await Transaction.create(txDoc);
          
          logger.businessEvent('driver_earnings_processed', authUser.id, {
            bookingId: booking._id,
            grossFare: grossFare,
            commissionAmount: commissionAmount,
            netEarnings: netEarnings
          });
        } catch (e) { 
          logger.error('Wallet update failed during booking completion', {
            error: e.message,
            driverId: authUser.id,
            bookingId: booking._id
          });
        }

        // Make driver available again
        try { 
          await Driver.findByIdAndUpdate(authUser.id, { available: true }); 
          logger.businessEvent('driver_made_available', authUser.id, {
            bookingId: booking._id
          });
        } catch (_) {}

        // Stop tracking
        try { 
          const positionUpdateService = require('../services/positionUpdate'); 
          positionUpdateService.stopTracking(booking._id.toString()); 
          logger.businessEvent('position_tracking_stopped', authUser.id, {
            bookingId: booking._id
          });
        } catch (_) {}

        const bookingRoom = `booking:${String(booking._id)}`;
        const patch = { bookingId: String(booking._id), patch: { status: 'completed', completedAt: booking.completedAt.toISOString() } };
        
        logger.businessEvent('booking_completed', authUser.id, {
          bookingId: booking._id,
          completedAt: booking.completedAt.toISOString()
        });
        
        sendMessageToSocketId(bookingRoom, { event: 'booking:update', data: patch });
        sendMessageToSocketId(bookingRoom, { event: 'booking:completed', data: { bookingId: String(booking._id) } });
        sendMessageToSocketId(`driver:${String(authUser.id)}`, { event: 'booking:completed', data: { bookingId: String(booking._id) } });
      } catch (err) {
        logger.socketEvent('booking_completed_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
        socket.emit('booking_error', { message: 'Failed to complete booking', source: 'booking:completed' });
      }
    });

    // --- driver:availability ---
    socket.on('driver:availability', async (payload) => {
      logger.socketEvent('driver_availability', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const authUser = socket.user;
        if (!authUser || String(authUser.type).toLowerCase() !== 'driver') {
          return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'driver:availability' });
        }
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const available = typeof data.available === 'boolean' ? data.available : undefined;
        if (available == null) return socket.emit('booking_error', { message: 'available boolean is required', source: 'driver:availability' });
        
        logger.dbOperation('findByIdAndUpdate', 'Driver', { id: String(authUser.id), available });
        await Driver.findByIdAndUpdate(authUser.id, { available });
        socket.user.available = available;
        
        logger.businessEvent('driver_availability_updated', authUser.id, {
          available: available
        });
        
        sendMessageToSocketId(`driver:${String(authUser.id)}`, { event: 'driver:availability', data: { driverId: String(authUser.id), available } });
      } catch (err) {
        logger.socketEvent('driver_availability_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
        socket.emit('booking_error', { message: 'Failed to update availability', source: 'driver:availability' });
      }
    });

    // --- booking:rating (optional) ---
    socket.on('booking:rating', async (payload) => {
      logger.socketEvent('booking_rating', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const authUser = socket.user;
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const rating = data.rating != null ? parseInt(data.rating, 10) : undefined;
        const feedback = data.feedback || undefined;
        if (!bookingIdRaw || !Number.isFinite(rating) || rating < 1 || rating > 5) {
          return socket.emit('booking_error', { message: 'bookingId and rating (1-5) are required', source: 'booking:rating' });
        }
        
        logger.dbOperation('findById', 'Booking', { _id: bookingIdRaw });
        const booking = await Booking.findById(bookingIdRaw);
        if (!booking) return socket.emit('booking_error', { message: 'Booking not found', source: 'booking:rating' });
        if (booking.status !== 'completed') return socket.emit('booking_error', { message: 'Can only rate after trip completion', source: 'booking:rating' });

        const userType = String(authUser?.type || '').toLowerCase();
        if (userType === 'passenger') {
          if (String(booking.passengerId) !== String(authUser.id)) {
            return socket.emit('booking_error', { message: 'Only the passenger can rate the driver', source: 'booking:rating' });
          }
          booking.driverRating = rating;
          if (feedback) booking.driverComment = feedback;
        } else if (userType === 'driver') {
          if (String(booking.driverId) !== String(authUser.id)) {
            return socket.emit('booking_error', { message: 'Only the assigned driver can rate the passenger', source: 'booking:rating' });
          }
          booking.passengerRating = rating;
          if (feedback) booking.passengerComment = feedback;
        } else {
          return socket.emit('booking_error', { message: 'Unsupported user type for rating', source: 'booking:rating' });
        }
        logger.businessEvent('rating_submitted', authUser.id, {
          bookingId: String(booking._id),
          userType: userType,
          rating: rating,
          hasFeedback: !!feedback
        });
        
        await booking.save();
        const room = `booking:${String(booking._id)}`;
        sendMessageToSocketId(room, { event: 'booking:rating', data: { bookingId: String(booking._id), userType, rating, feedback } });
      } catch (err) {
        logger.socketEvent('booking_rating_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
        socket.emit('booking_error', { message: 'Failed to submit rating', source: 'booking:rating' });
      }
    });

    // --- booking:nearby ---
    socket.on('booking:nearby', async (payload) => {
      logger.socketEvent('booking_nearby', socket.id, payload, {
        userType: socket.user?.type,
        userId: socket.user?.id
      });
      
      try {
        const authUser = socket.user;
        if (!authUser || String(authUser.type).toLowerCase() !== 'driver') {
          return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'booking:nearby' });
        }

        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const defaults = socket.nearbyDefaults || {};
        const latitude = data.latitude != null ? parseFloat(data.latitude) : defaults.latitude;
        const longitude = data.longitude != null ? parseFloat(data.longitude) : defaults.longitude;
        const radiusKm = data.radiusKm != null ? parseFloat(data.radiusKm) : (defaults.radiusKm || 5);
        const limit = data.limit != null ? parseInt(data.limit, 10) : (defaults.limit || 20);
        const vehicleType = data.vehicleType || defaults.vehicleType || authUser.vehicleType;

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return socket.emit('booking_error', { message: 'Valid latitude and longitude are required', source: 'booking:nearby' });
        }
        if (!vehicleType) {
          return socket.emit('booking_error', { message: 'vehicleType is required', source: 'booking:nearby' });
        }

        // Build base URL to call the existing REST endpoint
        const baseUrl = (process.env.BOOKING_BASE_URL || process.env.BASE_URL || `http://localhost:${process.env.BOOKING_PORT || process.env.PORT || 4000}`).replace(/\/$/, '');
        const url = `${baseUrl}/v1/bookings/nearby`;
        const headers = {};
        if (socket.authToken) headers['Authorization'] = socket.authToken.startsWith('Bearer ') ? socket.authToken : `Bearer ${socket.authToken}`;

        const response = await axios.get(url, {
          headers,
          params: { latitude, longitude, radiusKm, vehicleType, limit: Math.min(Math.max(limit, 1), 100) }
        });

        let items = Array.isArray(response.data) ? response.data : [];
        // Enforce vehicleType filter server-side as well
        items = items.filter(it => String(it.vehicleType || '').toLowerCase() === String(vehicleType).toLowerCase());
        // Apply limit defensively
        items = items.slice(0, Math.min(Math.max(limit, 1), 100));

        logger.businessEvent('nearby_bookings_fetched', authUser.id, {
          latitude: latitude,
          longitude: longitude,
          radiusKm: radiusKm,
          vehicleType: vehicleType,
          bookingsFound: items.length
        });

        // Emit back only to the requesting driver socket
        socket.emit('booking:nearby', { bookings: items, meta: { count: items.length, vehicleType, radiusKm } });
      } catch (err) {
        logger.socketEvent('booking_nearby_failed', socket.id, {}, {
          error: err.message,
          userId: socket.user?.id,
          userType: socket.user?.type
        });
        socket.emit('booking_error', { message: 'Failed to fetch nearby bookings', source: 'booking:nearby' });
      }
    });

    // --- disconnect ---
    socket.on('disconnect', () => {
      logger.socketEvent('disconnect', socket.id, {}, {
        userType: socket.user?.type,
        userId: socket.user?.id,
        timestamp: new Date().toISOString()
      });
      
      if (socket.user && socket.user.id) {
        logger.businessEvent('user_disconnected', socket.user.id, {
          userType: socket.user.type,
          socketId: socket.id
        });
      }
    });
  });
}

module.exports = { attachSocketHandlers };