const positionUpdateService = require('../../../services/positionUpdate');
const { Booking, BookingAssignment, TripHistory } = require('../../../models/bookingModels');
const { estimateFare } = require('../services/bookingService');
const { broadcast } = require('../../../sockets');

async function create(req, res) {
  try {
    const passengerId = String(req.user?.id);
    if (!passengerId) return res.status(400).json({ message: 'Invalid passenger ID: user not authenticated' });
    const { vehicleType, pickup, dropoff } = req.body;
    if (!pickup || !dropoff) return res.status(400).json({ message: 'Pickup and dropoff locations are required' });
    const est = await estimateFare({ vehicleType, pickup, dropoff });

    // Extract passenger info from JWT token
    const tokenMeta = {
      name: req.user?.name || req.user?.fullName || req.user?.displayName,
      phone: req.user?.phone || req.user?.phoneNumber || req.user?.mobile,
      email: req.user?.email
    };

    let passengerName = tokenMeta.name;
    let passengerPhone = tokenMeta.phone;

    // Fallbacks: try DB, then external service
    if (!passengerName || !passengerPhone) {
      try {
        const { Passenger } = require('../../../models/userModels');
        const { Types } = require('mongoose');
        if (Types.ObjectId.isValid(passengerId)) {
          const p = await Passenger.findById(passengerId).select({ _id: 1, name: 1, phone: 1 }).lean();
          if (p) {
            passengerName = passengerName || p.name;
            passengerPhone = passengerPhone || p.phone;
          }
        }
      } catch (_) {}
    }
    if (!passengerName || !passengerPhone) {
      try {
        const { getPassengerById } = require('../../../integrations/userServiceClient');
        const authHeader = req.headers && req.headers.authorization ? { Authorization: req.headers.authorization } : undefined;
        const info = await getPassengerById(passengerId, { headers: authHeader });
        if (info) {
          passengerName = passengerName || info.name;
          passengerPhone = passengerPhone || info.phone;
        }
      } catch (_) {}
    }
    if (!passengerName || !passengerPhone) {
      return res.status(422).json({ message: 'Passenger name and phone are required from auth token or user directory' });
    }

    const booking = await Booking.create({
      passengerId,
      passengerName,
      passengerPhone,
      vehicleType,
      pickup,
      dropoff,
      distanceKm: est.distanceKm,
      fareEstimated: est.fareEstimated,
      fareBreakdown: est.fareBreakdown,
    });

    const payload = {
      id: String(booking._id),
      passengerId,
      passenger: { id: passengerId, name: booking.passengerName, phone: booking.passengerPhone },
      vehicleType,
      pickup,
      dropoff,
      distanceKm: booking.distanceKm,
      fareEstimated: booking.fareEstimated,
      fareFinal: booking.fareFinal,
      fareBreakdown: booking.fareBreakdown,
      status: booking.status,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
    };

    try {
      const { nearestPassengers } = require('../../../services/nearbyPassengers');
      const { sendMessageToSocketId } = require('../../../sockets/utils');
      const nearest = await nearestPassengers({
        latitude: pickup.latitude,
        longitude: pickup.longitude,
        limit: 5,
      });
      const targets = (nearest || []).map((x) => x.passenger);
      broadcast('booking:new:broadcast', { ...payload, targetedCount: targets.length, target: 'passengers' });
      targets.forEach((p) =>
        sendMessageToSocketId(`passenger:${String(p._id)}`, { event: 'booking:new', data: payload })
      );
    } catch (e) {
      console.error('Broadcast to nearest passengers failed:', e);
    }

    return res.status(201).json(payload);
  } catch (e) {
    return res.status(500).json({ message: `Failed to create booking: ${e.message}` });
  }
}

async function list(req, res) {
  try {
    const userType = req.user?.type;
    const userId = req.user?.id;
    let query = {};
    if (userType === 'passenger') {
      query.passengerId = String(userId);
    }
    const rows = await Booking.find(query).sort({ createdAt: -1 }).lean();

    const { Passenger } = require('../../../models/userModels');
    const { Types } = require('mongoose');
    const passengerIds = [...new Set(rows.map((r) => r.passengerId))];
    const validObjectIds = passengerIds.filter((id) => Types.ObjectId.isValid(id));
    const passengers = validObjectIds.length
      ? await Passenger.find({ _id: { $in: validObjectIds } })
          .select({ _id: 1, name: 1, phone: 1 })
          .lean()
      : [];
    const pidToPassenger = Object.fromEntries(
      passengers.map((p) => [String(p._id), { id: String(p._id), name: p.name, phone: p.phone }])
    );

    const nonObjectIdPassengerIds = passengerIds.filter((id) => !Types.ObjectId.isValid(id));
    let additionalPassengers = {};
    if (nonObjectIdPassengerIds.length > 0) {
      try {
        const { getPassengerById } = require('../../../services/userDirectory');
        const authHeader = req.headers && req.headers.authorization ? { Authorization: req.headers.authorization } : undefined;
        const additionalPassengerResults = await Promise.all(
          nonObjectIdPassengerIds.map(async (id) => {
            try {
              const info = await getPassengerById(id, { headers: authHeader });
              return info ? { id, info } : null;
            } catch (e) {
              return null;
            }
          })
        );
        additionalPassengers = Object.fromEntries(
          additionalPassengerResults
            .filter((result) => result !== null)
            .map((result) => [result.id, { id: result.id, name: result.info.name, phone: result.info.phone }])
        );
      } catch (e) {}
    }

    let jwtPassengerInfo = null;
    if (req.user && req.user.id && req.user.type === 'passenger') {
      jwtPassengerInfo = {
        id: String(req.user.id),
        name: req.user.name || req.user.fullName || req.user.displayName,
        phone: req.user.phone || req.user.phoneNumber || req.user.mobile,
        email: req.user.email,
      };
    }

    const authHeader = req.headers && req.headers.authorization ? { Authorization: req.headers.authorization } : undefined;
    const driverIds = [...new Set(rows.map((r) => r.driverId).filter(Boolean))];
    let driverInfoMap = {};
    if (driverIds.length) {
      try {
        const { getDriversByIds } = require('../../../integrations/userServiceClient');
        const infos = await getDriversByIds(driverIds, { headers: authHeader });
        driverInfoMap = Object.fromEntries((infos || []).map((i) => [String(i.id), { id: String(i.id), name: i.name, phone: i.phone }]));
      } catch (_) {}
    }

    const normalized = rows.map((b) => {
      let passenger = undefined;
      if (jwtPassengerInfo && String(jwtPassengerInfo.id) === String(b.passengerId)) {
        passenger = jwtPassengerInfo;
      } else if (b.passengerName || b.passengerPhone) {
        passenger = { id: b.passengerId, name: b.passengerName, phone: b.passengerPhone };
      } else if (pidToPassenger[b.passengerId]) {
        passenger = pidToPassenger[b.passengerId];
      } else if (additionalPassengers[b.passengerId]) {
        passenger = additionalPassengers[b.passengerId];
      }

      const driverBasic = b.driverId ? driverInfoMap[String(b.driverId)] || undefined : undefined;
      return {
        id: String(b._id),
        passengerId: b.passengerId,
        passenger,
        driverId: b.driverId,
        driver: driverBasic,
        vehicleType: b.vehicleType,
        pickup: b.pickup,
        dropoff: b.dropoff,
        distanceKm: b.distanceKm,
        fareEstimated: b.fareEstimated,
        fareFinal: b.fareFinal,
        fareBreakdown: b.fareBreakdown,
        status: b.status,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      };
    });

    return res.json(normalized);
  } catch (e) {
    console.error('Error in booking list:', e);
    return res.status(500).json({ message: `Failed to retrieve bookings: ${e.message}` });
  }
}

async function get(req, res) {
  try {
    const userType = req.user?.type;
    let query = { _id: req.params.id };
    if (userType === 'passenger') {
      query.passengerId = String(req.user?.id);
    }
    const item = await Booking.findOne(query).lean();
    if (!item) return res.status(404).json({ message: 'Booking not found or you do not have permission to access it' });
    const { Passenger } = require('../../../models/userModels');
    const { Types } = require('mongoose');
    let passenger = undefined;
    if (req.user && req.user.id && req.user.type === 'passenger' && String(req.user.id) === String(item.passengerId)) {
      passenger = {
        id: String(req.user.id),
        name: req.user.name || req.user.fullName || req.user.displayName,
        phone: req.user.phone || req.user.phoneNumber || req.user.mobile,
        email: req.user.email,
      };
    }
    if (!passenger && item.passengerId && Types.ObjectId.isValid(item.passengerId)) {
      const p = await Passenger.findById(item.passengerId).select({ _id: 1, name: 1, phone: 1 }).lean();
      if (p) passenger = { id: String(p._id), name: p.name, phone: p.phone };
    }
    if (!passenger && (item.passengerName || item.passengerPhone)) {
      passenger = { id: String(item.passengerId), name: item.passengerName, phone: item.passengerPhone };
    }
    if (!passenger) {
      passenger = { id: String(item.passengerId), name: `Passenger ${item.passengerId}`, phone: `+123456789${item.passengerId}` };
    }
    return res.json({
      id: String(item._id),
      passengerId: item.passengerId,
      passenger,
      vehicleType: item.vehicleType,
      pickup: item.pickup,
      dropoff: item.dropoff,
      distanceKm: item.distanceKm,
      fareEstimated: item.fareEstimated,
      fareFinal: item.fareFinal,
      fareBreakdown: item.fareBreakdown,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  } catch (e) {
    return res.status(500).json({ message: `Failed to retrieve booking: ${e.message}` });
  }
}

async function update(req, res) {
  try {
    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, passengerId: String(req.user?.id) },
      req.body,
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Booking not found or you do not have permission to update it' });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ message: `Failed to update booking: ${e.message}` });
  }
}

async function remove(req, res) {
  try {
    const r = await Booking.findOneAndDelete({ _id: req.params.id, passengerId: String(req.user?.id) });
    if (!r) return res.status(404).json({ message: 'Booking not found or you do not have permission to delete it' });
    return res.status(204).send();
  } catch (e) {
    return res.status(500).json({ message: `Failed to delete booking: ${e.message}` });
  }
}

async function lifecycle(req, res) {
  try {
    const { status } = req.body;
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!['requested', 'accepted', 'ongoing', 'completed', 'canceled'].includes(status))
      return res.status(400).json({ message: `Invalid status '${status}'. Allowed values: requested, accepted, ongoing, completed, canceled` });

    if (booking.status === 'completed') {
      return res.status(400).json({ message: 'Cannot change status of completed bookings' });
    }

    if (status === 'accepted' && req.user?.type === 'driver') {
      const { Driver } = require('../../../models/userModels');
      const driver = await Driver.findById(req.user.id);
      if (!driver || !driver.available) {
        return res.status(400).json({ message: 'Driver must be available to accept bookings. Driver is currently unavailable.' });
      }
      const activeBooking = await Booking.findOne({ driverId: req.user.id, status: { $in: ['accepted', 'ongoing'] } });
      if (activeBooking) {
        return res.status(400).json({ message: 'Driver already has an active booking' });
      }
      booking.driverId = String(req.user.id);
      await Driver.findByIdAndUpdate(req.user.id, { available: false });
    }

    if (req.user?.type === 'driver' && booking.driverId && booking.driverId !== String(req.user.id)) {
      return res.status(403).json({ message: 'Only the assigned driver can change this booking status' });
    }

    booking.status = status;
    if (status === 'accepted') {
      booking.acceptedAt = new Date();
    }
    if (status === 'ongoing') {
      booking.startedAt = new Date();
      if (booking.driverId && booking.passengerId) {
        positionUpdateService.startTracking(booking._id.toString(), booking.driverId, booking.passengerId);
      }
    }
    if (status === 'completed') {
      booking.completedAt = new Date();
      booking.fareFinal = booking.fareEstimated;

      if (booking.driverId) {
        const { DriverEarnings, AdminEarnings, Commission } = require('../../../models/commission');
        const commission = await Commission.findOne({ isActive: true }).sort({ createdAt: -1 });
        const commissionRate = commission ? commission.percentage : 15;
        const grossFare = booking.fareFinal || booking.fareEstimated;
        const commissionAmount = (grossFare * commissionRate) / 100;
        const netEarnings = grossFare - commissionAmount;

        await DriverEarnings.create({
          driverId: booking.driverId,
          bookingId: booking._id,
          tripDate: new Date(),
          grossFare,
          commissionAmount,
          netEarnings,
          commissionPercentage: commissionRate,
        });

        try {
          const mongoose = require('mongoose');
          const { Wallet, Transaction } = require('../../../models/common');
          const session = await mongoose.startSession();
          await session.withTransaction(async () => {
            await Wallet.updateOne(
              { userId: String(booking.driverId), role: 'driver' },
              { $inc: { balance: netEarnings, totalEarnings: netEarnings } },
              { upsert: true, session }
            );
            await Transaction.create(
              [
                {
                  userId: String(booking.driverId),
                  role: 'driver',
                  amount: netEarnings,
                  type: 'credit',
                  method: booking.paymentMethod || 'cash',
                  status: 'success',
                  metadata: { bookingId: String(booking._id), reason: 'Trip earnings (REST)' },
                },
              ],
              { session }
            );
          });
          session.endSession();
        } catch (e) {
          console.error('[wallet] credit on complete failed:', e);
        }

        await Driver.findByIdAndUpdate(booking.driverId, { available: true });
        positionUpdateService.stopTracking(booking._id.toString());
      }
    }
    if (status === 'canceled') {
      if (booking.driverId) {
        const { Driver } = require('../../../models/userModels');
        await Driver.findByIdAndUpdate(booking.driverId, { available: true });
      }
      positionUpdateService.stopTracking(booking._id.toString());
    }

    await booking.save();
    await TripHistory.create({ bookingId: booking._id, driverId: booking.driverId, passengerId: booking.passengerId, status: booking.status });
    broadcast('booking:update', { id: booking.id || String(booking._id || ''), status });
    return res.json(booking);
  } catch (e) {
    return res.status(500).json({ message: `Failed to update booking lifecycle: ${e.message}` });
  }
}

async function assign(req, res) {
  try {
    const { driverId, dispatcherId, passengerId } = req.body;
    const bookingId = req.params.id;
    if (!driverId) return res.status(400).json({ message: 'Driver ID is required for assignment' });
    if (!dispatcherId) return res.status(400).json({ message: 'Dispatcher ID is required for assignment' });

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.status !== 'requested') {
      return res.status(400).json({ message: `Cannot assign booking with status '${booking.status}'. Only 'requested' bookings can be assigned.` });
    }

    const { Driver } = require('../../../models/userModels');
    const driver = await Driver.findById(driverId);
    if (!driver || !driver.available) {
      return res.status(400).json({ message: 'Driver is not available for assignment. Driver must be available to accept bookings.' });
    }
    const activeBooking = await Booking.findOne({ driverId: String(driverId), status: { $in: ['accepted', 'ongoing'] } });
    if (activeBooking) {
      return res.status(400).json({ message: 'Driver already has an active booking' });
    }

    const assignment = await BookingAssignment.create({
      bookingId,
      driverId: String(driverId),
      dispatcherId: String(dispatcherId),
      passengerId: String(passengerId || booking.passengerId),
    });

    booking.driverId = String(driverId);
    booking.status = 'accepted';
    booking.acceptedAt = new Date();
    await booking.save();

    await Driver.findByIdAndUpdate(driverId, { available: false });
    broadcast('booking:assigned', { bookingId, driverId });
    return res.json({ booking, assignment });
  } catch (e) {
    return res.status(500).json({ message: `Failed to assign booking: ${e.message}` });
  }
}

async function estimate(req, res) {
  try {
    const { vehicleType, pickup, dropoff } = req.body;
    if (!pickup || !dropoff) return res.status(400).json({ message: 'Pickup and dropoff locations are required for fare estimation' });
    const est = await estimateFare({ vehicleType, pickup, dropoff });
    return res.json(est);
  } catch (e) {
    return res.status(500).json({ message: `Failed to estimate fare: ${e.message}` });
  }
}

async function nearby(req, res) {
  try {
    const userType = req.user && req.user.type;
    if (!['driver', 'admin', 'staff', 'superadmin'].includes(String(userType || ''))) {
      return res.status(403).json({ message: 'Only drivers or staff can view nearby bookings' });
    }
    const geolib = require('geolib');
    const latitude = parseFloat(req.query.latitude);
    const longitude = parseFloat(req.query.longitude);
    const radiusKm = parseFloat(req.query.radiusKm || '5');
    const vehicleType = req.query.vehicleType || undefined;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    if (!isFinite(latitude) || !isFinite(longitude)) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required' });
    }
    const query = { status: 'requested', ...(vehicleType ? { vehicleType } : {}) };
    const rows = await Booking.find(query).sort({ createdAt: -1 }).lean();
    const withDistance = rows
      .map((b) => {
        const dKm =
          geolib.getDistance(
            { latitude, longitude },
            { latitude: b.pickup?.latitude, longitude: b.pickup?.longitude }
          ) / 1000;
        return { booking: b, distanceKm: dKm };
      })
      .filter((x) => isFinite(x.distanceKm) && x.distanceKm <= radiusKm);
    withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
    const selected = withDistance.slice(0, limit);
    const result = selected.map((x) => ({
      id: String(x.booking._id),
      passengerId: x.booking.passengerId,
      passenger:
        x.booking.passengerName || x.booking.passengerPhone
          ? { id: x.booking.passengerId, name: x.booking.passengerName, phone: x.booking.passengerPhone }
          : undefined,
      vehicleType: x.booking.vehicleType,
      pickup: x.booking.pickup,
      dropoff: x.booking.dropoff,
      distanceKm: Math.round(x.distanceKm * 100) / 100,
      fareEstimated: x.booking.fareEstimated,
      status: x.booking.status,
      createdAt: x.booking.createdAt,
      updatedAt: x.booking.updatedAt,
    }));
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: `Failed to retrieve nearby bookings: ${e.message}` });
  }
}

async function ratePassenger(req, res) {
  try {
    const { rating, comment } = req.body;
    const bookingId = req.params.id;
    const driverId = req.user.id;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.driverId !== driverId) return res.status(403).json({ message: 'Only the assigned driver can rate the passenger' });
    if (booking.status !== 'completed') return res.status(400).json({ message: 'Can only rate after trip completion' });
    booking.passengerRating = rating;
    if (comment) booking.passengerComment = comment;
    await booking.save();
    return res.json({ message: 'Passenger rated successfully', booking, rating, comment });
  } catch (e) {
    return res.status(500).json({ message: `Failed to rate passenger: ${e.message}` });
  }
}

async function rateDriver(req, res) {
  try {
    const { rating, comment } = req.body;
    const bookingId = req.params.id;
    const passengerId = req.user.id;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const equalIds = (a, b) => {
      if (!a || !b) return false;
      try {
        return String(a) === String(b);
      } catch (_) {
        return false;
      }
    };
    if (!equalIds(booking.passengerId, passengerId)) {
      return res.status(403).json({ message: 'Only the passenger can rate the driver' });
    }
    if (booking.status !== 'completed') return res.status(400).json({ message: 'Can only rate after trip completion' });
    booking.driverRating = rating;
    if (comment) booking.driverComment = comment;
    await booking.save();
    return res.json({ message: 'Driver rated successfully' });
  } catch (e) {
    return res.status(500).json({ message: `Failed to rate driver: ${e.message}` });
  }
}

module.exports = {
  create,
  list,
  get,
  update,
  remove,
  lifecycle,
  assign,
  estimate,
  nearby,
  ratePassenger,
  rateDriver,
};

