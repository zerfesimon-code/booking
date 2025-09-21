const geolib = require('geolib');
const { Passenger } = require('../models/userModels');
const { logger } = require('../utils/logger');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

async function nearestPassengers({ latitude, longitude, limit = 5 }) {
  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  
  logger.info('Searching nearest passengers', {
    latitude: lat,
    longitude: lng,
    limit: limit
  });
  
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
    logger.error('Invalid coordinates provided for passenger search', { latitude, longitude });
    throw new Error('Valid latitude and longitude are required');
  }
  const max = Math.max(1, Math.min(parseInt(limit || 5, 10), 50));

  // Assuming Passenger collection may store last known location in a similar structure.
  // If not available, this will return an empty list safely.
  logger.dbOperation('find', 'Passenger', { 
    'lastKnownLocation.latitude': { $exists: true }, 
    'lastKnownLocation.longitude': { $exists: true } 
  });
  
  const passengers = await Passenger.find({ 
    'lastKnownLocation.latitude': { $exists: true }, 
    'lastKnownLocation.longitude': { $exists: true } 
  }).lean().catch((error) => {
    logger.error('Failed to fetch passengers with location data', { error: error.message });
    return [];
  });
  
  logger.debug('Found passengers with location data', { count: passengers.length });
  
  const withDistance = (passengers || [])
    .map(p => {
      const loc = p.lastKnownLocation || {};
      if (!isFiniteNumber(loc.latitude) || !isFiniteNumber(loc.longitude)) return null;
      const distanceKm = geolib.getDistance(
        { latitude: lat, longitude: lng },
        { latitude: loc.latitude, longitude: loc.longitude }
      ) / 1000;
      if (!isFiniteNumber(distanceKm)) return null;
      return { passenger: p, distanceKm };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, max);

  logger.info('Found nearest passengers', {
    totalPassengers: passengers.length,
    nearestPassengers: withDistance.length,
    limit: max
  });

  return withDistance;
}

module.exports = { nearestPassengers };
