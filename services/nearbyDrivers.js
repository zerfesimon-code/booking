const geolib = require('geolib');
const { Driver } = require('../models/userModels');
const { logger } = require('../utils/logger');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

async function driverByLocation({ latitude, longitude, radiusKm = 5 }) {
  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  const rad = parseFloat(radiusKm);
  
  logger.info('Searching drivers by location', {
    latitude: lat,
    longitude: lng,
    radiusKm: rad
  });
  
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
    logger.error('Invalid coordinates provided for driver search', { latitude, longitude });
    throw new Error('Valid latitude and longitude are required');
  }
  const radius = isFiniteNumber(rad) ? rad : 5;

  logger.dbOperation('find', 'Driver', { available: true });
  const drivers = await Driver.find({ available: true }).lean();
  
  logger.debug('Found available drivers', { count: drivers.length });
  
  const withDistance = drivers
    .map(d => {
      const loc = d.lastKnownLocation || {};
      if (!isFiniteNumber(loc.latitude) || !isFiniteNumber(loc.longitude)) return null;
      const distanceKm = geolib.getDistance(
        { latitude: lat, longitude: lng },
        { latitude: loc.latitude, longitude: loc.longitude }
      ) / 1000;
      if (!isFiniteNumber(distanceKm) || distanceKm > radius) return null;
      return { driver: d, distanceKm };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  logger.info('Found nearby drivers', {
    totalDrivers: drivers.length,
    nearbyDrivers: withDistance.length,
    radiusKm: radius
  });

  return withDistance;
}

async function driverByLocationAndVehicleType({ latitude, longitude, vehicleType, radiusKm = 5, limit = 5 }) {
  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  const rad = parseFloat(radiusKm);
  const vehicle = vehicleType ? String(vehicleType).toLowerCase() : undefined;
  
  logger.info('Searching drivers by location and vehicle type', {
    latitude: lat,
    longitude: lng,
    vehicleType: vehicle,
    radiusKm: rad,
    limit: limit
  });
  
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
    logger.error('Invalid coordinates provided for driver search', { latitude, longitude });
    throw new Error('Valid latitude and longitude are required');
  }
  if (!vehicle) {
    logger.error('Vehicle type not provided for driver search');
    throw new Error('vehicleType is required');
  }
  const radius = isFiniteNumber(rad) ? rad : 5;
  const max = Math.max(1, Math.min(parseInt(limit || 5, 10), 50));

  logger.dbOperation('find', 'Driver', { available: true, vehicleType: vehicleType });
  const drivers = await Driver.find({ available: true, vehicleType: vehicleType }).lean();
  
  logger.debug('Found available drivers with vehicle type', { 
    count: drivers.length, 
    vehicleType: vehicle 
  });
  
  const withDistance = drivers
    .map(d => {
      const loc = d.lastKnownLocation || {};
      if (!isFiniteNumber(loc.latitude) || !isFiniteNumber(loc.longitude)) return null;
      const distanceKm = geolib.getDistance(
        { latitude: lat, longitude: lng },
        { latitude: loc.latitude, longitude: loc.longitude }
      ) / 1000;
      if (!isFiniteNumber(distanceKm) || distanceKm > radius) return null;
      return { driver: d, distanceKm };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, max);

  logger.info('Found nearby drivers with vehicle type', {
    totalDrivers: drivers.length,
    nearbyDrivers: withDistance.length,
    vehicleType: vehicle,
    radiusKm: radius,
    limit: max
  });

  return withDistance;
}

module.exports = { driverByLocation, driverByLocationAndVehicleType };
