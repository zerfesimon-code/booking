const { Booking } = require('../models/bookingModels');
const TripHistory = require('../models/tripHistoryModel');
const { haversineKm } = require('../utils/distance');
const pricingService = require('./pricingService');
const commissionService = require('./commissionService');
const walletService = require('./walletService');
const { Passenger, Driver } = (() => {
  try { return require('../models/userModels'); } catch (_) { return {}; }
})();

async function startTrip(bookingId, startLocation) {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error('Booking not found');
  booking.status = 'ongoing';
  booking.startedAt = new Date();
  if (startLocation) booking.startLocation = startLocation;
  await booking.save();
  await TripHistory.findOneAndUpdate(
    { bookingId: booking._id },
    {
      $setOnInsert: {
        bookingId: booking._id,
        driverId: booking.driverId,
        passengerId: booking.passengerId,
        vehicleType: booking.vehicleType,
        startedAt: booking.startedAt,
        status: 'in-progress',
        locations: []
      },
      $set: {
        startLocation: startLocation || booking.startLocation || undefined,
        // Keep legacy alias updated for compatibility
        pickupLocation: startLocation || booking.startLocation || undefined
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return booking;
}

async function updateTripLocation(bookingId, driverId, location) {
  const point = { lat: Number(location.latitude), lng: Number(location.longitude), timestamp: new Date() };
  await TripHistory.findOneAndUpdate(
    { bookingId },
    { $push: { locations: point } },
    { upsert: true }
  );
  return point;
}

function computePathDistanceKm(locations) {
  if (!Array.isArray(locations) || locations.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < locations.length; i++) {
    const a = locations[i - 1];
    const b = locations[i];
    total += haversineKm({ latitude: a.lat, longitude: a.lng }, { latitude: b.lat, longitude: b.lng });
  }
  return total;
}

async function completeTrip(bookingId, endLocation, options = {}) {
  const { surgeMultiplier = 1, discount = 0, debitPassengerWallet = false, adminUserId = process.env.ADMIN_USER_ID } = options;
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error('Booking not found');

  const trip = await TripHistory.findOne({ bookingId: booking._id });
  const startedAt = booking.startedAt || (trip && trip.startedAt) || new Date();
  const completedAt = new Date();

  if (endLocation) booking.endLocation = endLocation;

  // Compute distance
  let distanceKm = 0;
  if (trip && Array.isArray(trip.locations) && trip.locations.length >= 2) {
    distanceKm = computePathDistanceKm(trip.locations);
  } else if (booking.startLocation && endLocation) {
    distanceKm = haversineKm(
      { latitude: booking.startLocation.latitude, longitude: booking.startLocation.longitude },
      { latitude: endLocation.latitude, longitude: endLocation.longitude }
    );
  } else if (booking.pickup && booking.dropoff) {
    distanceKm = haversineKm(
      { latitude: booking.pickup.latitude, longitude: booking.pickup.longitude },
      { latitude: booking.dropoff.latitude, longitude: booking.dropoff.longitude }
    );
  }

  const waitingTimeMinutes = Math.max(0, Math.round(((completedAt - new Date(startedAt)) / 60000)));
  const durationMinutes = Math.max(0, Math.round(((completedAt - new Date(startedAt)) / 60000)));

  const fare = await pricingService.calculateFare(distanceKm, waitingTimeMinutes, booking.vehicleType, surgeMultiplier, discount);
  const { commission, driverEarnings } = await commissionService.calculateCommission(fare, Number(process.env.COMMISSION_RATE || 0.15));

  // Update booking
  booking.status = 'completed';
  booking.completedAt = completedAt;
  booking.fareFinal = fare;
  booking.distanceKm = distanceKm;
  booking.waitingTime = waitingTimeMinutes;
  booking.commissionAmount = commission;
  booking.driverEarnings = driverEarnings;
  await booking.save();

  // Wallet operations (best effort)
  try {
    if (booking.driverId) await walletService.credit(booking.driverId, driverEarnings, 'Trip earnings');
  } catch (_) {}
  try {
    if (adminUserId) await walletService.credit(adminUserId, commission, 'Commission from trip');
  } catch (_) {}
  try {
    if (debitPassengerWallet && booking.passengerId) await walletService.debit(booking.passengerId, fare, 'Trip fare');
  } catch (_) {}

  // Persist trip summary
  await TripHistory.findOneAndUpdate(
    { bookingId: booking._id },
    {
      $set: {
        fare,
        // Keep both legacy and spec-compliant distance fields
        distance: distanceKm,
        distanceKm,
        waitingTime: waitingTimeMinutes,
        duration: durationMinutes,
        commission,
        vehicleType: booking.vehicleType,
        startedAt,
        completedAt,
        status: 'completed',
        endLocation: endLocation || booking.dropoff || undefined,
        // Keep legacy alias updated for compatibility
        dropoffLocation: endLocation || booking.dropoff || undefined
      }
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  // Rewards awarding (best-effort, no failure propagation)
  try {
    const points = Math.floor((Number(distanceKm) || 0) / 2) * 10; // 10 points per 2km
    if (points > 0) {
      if (Passenger && booking.passengerId) {
        await Passenger.updateOne({ _id: booking.passengerId }, { $inc: { rewardPoints: points } });
      }
      if (Driver && booking.driverId) {
        await Driver.updateOne({ _id: booking.driverId }, { $inc: { rewardPoints: points } });
      }
    }
  } catch (_) {}

  return booking;
}

module.exports = { startTrip, updateTripLocation, completeTrip };

