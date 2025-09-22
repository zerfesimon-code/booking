const geolib = require('geolib');
const { Driver } = require('../models/userModels');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

async function driverByLocation({ latitude, longitude, radiusKm = 5 }) {
  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  const rad = parseFloat(radiusKm);
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) {
    throw new Error('Valid latitude and longitude are required');
  }
  const radius = isFiniteNumber(rad) ? rad : 5;

  const drivers = await Driver.find({ available: true }).lean();
  // Heuristic to cope with bad inputs: try multiple candidate targets
  const lons = drivers
    .map(d => (d.lastKnownLocation && isFiniteNumber(d.lastKnownLocation.longitude) ? d.lastKnownLocation.longitude : null))
    .filter(v => v != null);
  const negCount = lons.filter(v => v < 0).length;
  const posCount = lons.length - negCount;
  const expectedLonSign = negCount >= posCount ? -1 : 1;
  const candidates = [
    { lat, lon },
    { lat: lon, lon: lat },
    { lat, lon: expectedLonSign * Math.abs(lon) },
    { lat: lon, lon: expectedLonSign * Math.abs(lat) }
  ];

  function selectBestTarget() {
    let best = { lat, lon };
    let bestScore = { count: -1, avg: Number.POSITIVE_INFINITY };
    for (const c of candidates) {
      const distances = drivers
        .filter(d => d.lastKnownLocation && isFiniteNumber(d.lastKnownLocation.latitude) && isFiniteNumber(d.lastKnownLocation.longitude))
        .map(d => geolib.getDistance(
          { latitude: c.lat, longitude: c.lon },
          { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude }
        ) / 1000);
      const inRange = distances.filter(d => isFiniteNumber(d) && d <= radius);
      const avg = inRange.length ? (inRange.reduce((a, b) => a + b, 0) / inRange.length) : Number.POSITIVE_INFINITY;
      if (inRange.length > bestScore.count || (inRange.length === bestScore.count && avg < bestScore.avg)) {
        best = c;
        bestScore = { count: inRange.length, avg };
      }
    }
    return best;
  }

  const target = selectBestTarget();
  const withDistance = drivers
    .map(d => {
      const loc = d.lastKnownLocation || {};
      if (!isFiniteNumber(loc.latitude) || !isFiniteNumber(loc.longitude)) return null;
      const distanceKm = geolib.getDistance(
        { latitude: target.lat, longitude: target.lon },
        { latitude: loc.latitude, longitude: loc.longitude }
      ) / 1000;
      if (!isFiniteNumber(distanceKm) || distanceKm > radius) return null;
      return { driver: d, distanceKm };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return withDistance;
}

async function driverByLocationAndVehicleType({ latitude, longitude, vehicleType, radiusKm = 5, limit = 100 }) {
  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  const rad = parseFloat(radiusKm);
  const vehicle = vehicleType ? String(vehicleType).toLowerCase() : undefined;
  console.log('details passed to body { latitude, longitude, vehicleType, radiusKm, limit }', { latitude, longitude, vehicleType, radiusKm, limit });
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) {
    throw new Error('Valid latitude and longitude are required');
  }
  if (!vehicle) {
    throw new Error('vehicleType is required');
  }
  const radius = isFiniteNumber(rad) ? rad : 5;
  const max = Math.max(1, Math.min(parseInt(limit || 20, 10), 100));

  // Case-insensitive vehicle type matching
  const drivers = await Driver.find({ available: true, vehicleType: { $regex: new RegExp(`^${vehicle}$`, 'i') } }).lean();
  console.log('drivers found', { drivers });
  // Heuristic target selection like in driver service
  const lons = drivers
    .map(d => (d.lastKnownLocation && isFiniteNumber(d.lastKnownLocation.longitude) ? d.lastKnownLocation.longitude : null))
    .filter(v => v != null);
  const negCount = lons.filter(v => v < 0).length;
  const posCount = lons.length - negCount;
  const expectedLonSign = negCount >= posCount ? -1 : 1;
  const candidates = [
    { lat, lon },
    { lat: lon, lon: lat },
    { lat, lon: expectedLonSign * Math.abs(lon) },
    { lat: lon, lon: expectedLonSign * Math.abs(lat) }
  ];
  function chooseTarget() {
    let best = { lat, lon };
    let bestScore = { count: -1, avg: Number.POSITIVE_INFINITY };
    for (const c of candidates) {
      const distances = drivers
        .filter(d => d.lastKnownLocation && isFiniteNumber(d.lastKnownLocation.latitude) && isFiniteNumber(d.lastKnownLocation.longitude))
        .map(d => geolib.getDistance(
          { latitude: c.lat, longitude: c.lon },
          { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude }
        ) / 1000);
      const inRange = distances.filter(d => isFiniteNumber(d) && d <= radius);
      const avg = inRange.length ? (inRange.reduce((a, b) => a + b, 0) / inRange.length) : Number.POSITIVE_INFINITY;
      if (inRange.length > bestScore.count || (inRange.length === bestScore.count && avg < bestScore.avg)) {
        best = c;
        bestScore = { count: inRange.length, avg };
      }
    }
    return best;
  }
  const target = chooseTarget();
  const withDistance = drivers
    .map(d => {
      const loc = d.lastKnownLocation || {};
      console.log('location found', { loc });
      if (!isFiniteNumber(loc.latitude) || !isFiniteNumber(loc.longitude)) return null;
      const distanceKm = geolib.getDistance(
        { latitude: target.lat, longitude: target.lon },
        { latitude: loc.latitude, longitude: loc.longitude }
      ) / 1000;
      console.log('distanceKm found', { distanceKm });
      if (!isFiniteNumber(distanceKm) || distanceKm > radius) return null;
      return { driver: d, distanceKm };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, max);
    console.log('withDistance found', { withDistance });
  return withDistance;
}

module.exports = { driverByLocation, driverByLocationAndVehicleType };
