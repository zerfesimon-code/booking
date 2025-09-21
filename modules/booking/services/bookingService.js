const geolib = require('geolib');
const { Pricing } = require('../../../models/pricing');

async function estimateFare({ vehicleType = 'mini', pickup, dropoff }) {
  const distanceKm = geolib.getDistance(
    { latitude: pickup.latitude, longitude: pickup.longitude },
    { latitude: dropoff.latitude, longitude: dropoff.longitude }
  ) / 1000;
  const p = await Pricing.findOne({ vehicleType, isActive: true }).sort({ updatedAt: -1 }) || { baseFare: 2, perKm: 1, perMinute: 0.2, waitingPerMinute: 0.1, surgeMultiplier: 1 };
  const fareBreakdown = {
    base: p.baseFare,
    distanceCost: distanceKm * p.perKm,
    timeCost: 0,
    waitingCost: 0,
    surgeMultiplier: p.surgeMultiplier,
  };
  const fareEstimated = (fareBreakdown.base + fareBreakdown.distanceCost + fareBreakdown.timeCost + fareBreakdown.waitingCost) * fareBreakdown.surgeMultiplier;
  return { distanceKm, fareEstimated, fareBreakdown };
}

module.exports = { estimateFare };

