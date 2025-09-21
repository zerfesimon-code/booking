const { Live } = require('../models/bookingModels');
const { broadcast } = require('../sockets');
const { logger } = require('../utils/logger');

class PositionUpdateService {
  constructor() {
    this.intervals = new Map(); // Store intervals for each active trip
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Position update service started');
  }

  stop() {
    if (!this.isRunning) return;
    
    // Clear all intervals
    const activeTrips = Array.from(this.intervals.keys());
    this.intervals.forEach((interval, tripId) => {
      clearInterval(interval);
    });
    this.intervals.clear();
    
    logger.info('Position update service stopped', {
      activeTripsCount: activeTrips.length,
      activeTrips: activeTrips
    });
    
    this.isRunning = false;
  }

  // Start tracking position updates for a trip
  startTracking(tripId, driverId, passengerId) {
    if (this.intervals.has(tripId)) {
      logger.warn('Position tracking already active for trip', { tripId });
      return;
    }

    logger.info('Starting position tracking for trip', {
      tripId,
      driverId,
      passengerId
    });

    const interval = setInterval(async () => {
      try {
        // Get latest position for driver
        logger.dbOperation('findOne', 'Live', {
          driverId,
          locationType: 'current'
        });
        
        const latestPosition = await Live.findOne({
          driverId,
          locationType: 'current'
        }).sort({ createdAt: -1 });

        if (latestPosition) {
          // Broadcast position update
          logger.debug('Broadcasting position update', {
            tripId,
            driverId,
            passengerId,
            latitude: latestPosition.latitude,
            longitude: latestPosition.longitude
          });
          
          broadcast('position:update', {
            tripId,
            driverId,
            passengerId,
            latitude: latestPosition.latitude,
            longitude: latestPosition.longitude,
            bearing: latestPosition.bearing,
            timestamp: new Date()
          });
        } else {
          logger.debug('No latest position found for driver', { driverId, tripId });
        }
      } catch (error) {
        logger.error('Error updating position for trip', {
          tripId,
          driverId,
          error: error.message
        });
      }
    }, 60000); // 60 seconds

    this.intervals.set(tripId, interval);
  }

  // Stop tracking position updates for a trip
  stopTracking(tripId) {
    const interval = this.intervals.get(tripId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(tripId);
      logger.info('Stopped position tracking for trip', { tripId });
    } else {
      logger.warn('No active tracking found for trip', { tripId });
    }
  }

  // Get active trips being tracked
  getActiveTrips() {
    return Array.from(this.intervals.keys());
  }
}

// Singleton instance
const positionUpdateService = new PositionUpdateService();

module.exports = positionUpdateService;
