const driverService = require('../services/driverService');
const driverEvents = require('../events/driverEvents');

module.exports = (io, socket) => {
  // On connection, send initial driver bookings once
  try {
    if (socket.user && String(socket.user.type).toLowerCase() === 'driver') {
      (async () => {
        try {
          const { Booking } = require('../models/bookingModels');
          const rows = await Booking.find({
            driverId: String(socket.user.id),
            status: 'requested' // ✅ only requested bookings
          })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

          const payload = {
           
            bookings: rows.map(b => ({
              bookingId: String(b._id),
              status: b.status,
              pickup: b.pickup && (b.pickup.address || b.pickup),
              dropoff: b.dropoff && (b.dropoff.address || b.dropoff),
              fare: b.fareEstimated || b.fareFinal,
              passenger: b.passengerId
                ? {
                    id: String(b.passengerId),
                    name: b.passengerName,
                    phone: b.passengerPhone
                  }
                : undefined
            }))
          };

          socket.emit('booking:nearby', payload);
        } catch (err) {
          console.error('Error fetching driver bookings:', err.message);
        }
      })();
    }
  } catch (err) {
    console.error('Driver connection error:', err.message);
  }

  // driver:availability
  socket.on('driver:availability', async payload => {
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', {
          message: 'Unauthorized: driver token required',
          source: 'driver:availability'
        });
      }

      const data =
        typeof payload === 'string' ? JSON.parse(payload) : payload || {};
      const available =
        typeof data.available === 'boolean' ? data.available : undefined;

      if (available == null) {
        return socket.emit('booking_error', {
          message: 'available boolean is required',
          source: 'driver:availability'
        });
      }

      await driverService.setAvailability(
        String(socket.user.id),
        available,
        socket.user
      );

      driverEvents.emitDriverAvailability(String(socket.user.id), !!available);
    } catch (err) {
      console.error('Availability update failed:', err.message);
      socket.emit('booking_error', {
        message: 'Failed to update availability',
        source: 'driver:availability'
      });
    }
  });

  // booking:driver_location_update
  socket.on('booking:driver_location_update', async payload => {
    try {
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', {
          message: 'Unauthorized: driver token required',
          source: 'booking:driver_location_update'
        });
      }

      const data =
        typeof payload === 'string' ? JSON.parse(payload) : payload || {};

      const d = await driverService.updateLocation(
        String(socket.user.id),
        data,
        socket.user
      );

      driverEvents.emitDriverLocationUpdate({
        driverId: String(d._id),
        vehicleType: d.vehicleType,
        available: d.available,
        lastKnownLocation: d.lastKnownLocation,
        updatedAt: d.updatedAt
      });
    } catch (err) {
      console.error('Location update failed:', err.message);
      socket.emit('booking_error', {
        message: 'Failed to process location update',
        source: 'booking:driver_location_update'
      });
    }
  });
};
