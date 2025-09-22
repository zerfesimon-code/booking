## Socket.IO Events and Workflows

This document lists all Socket.IO events in the system, who emits them, required auth, expected payloads, and what the server does and broadcasts in response.

### Conventions
- Auth: Driver or Passenger JWT is required as noted
- Rooms: Server joins sockets to logical rooms to scope broadcasts
- All broadcasting is handled via `events/` modules and `sockets/utils`

---

### Booking Domain

- Event: `booking_request`
  - Emitter: Passenger
  - Auth: Passenger
  - Payload:
    - `vehicleType`: string (e.g., "mini")
    - `pickup`: { latitude, longitude, ... }
    - `dropoff`: { latitude, longitude, ... }
  - Workflow:
    1) Validate auth and payload
    2) Create booking via `bookingService.createBooking`
    3) Join room `booking:{bookingId}`
    4) Emit to requester: `booking:created` { bookingId }
    5) Find nearby drivers and send targeted messages `booking:new` to `driver:{driverId}`

- Event: `booking_accept`
  - Emitter: Driver
  - Auth: Driver
  - Payload: `{ bookingId }`
  - Workflow:
    1) Update lifecycle via `bookingService.updateBookingLifecycle(..., status:'accepted')`
    2) Join room `booking:{bookingId}`
    3) Broadcast `booking:update` with { status:'accepted', driverId, acceptedAt }
    4) Notify other nearby drivers to remove booking from lists via `booking:removed` to `driver:{driverId}`

- Event: `booking_cancel`
  - Emitter: Driver or Passenger
  - Auth: Driver/Passenger
  - Payload: `{ bookingId, reason? }`
  - Workflow:
    1) Update lifecycle via `bookingService.updateBookingLifecycle(..., status:'canceled')`
    2) Broadcast `booking:update` with { status:'canceled', canceledBy, canceledReason }

- Event: `booking:status_request`
  - Emitter: Driver or Passenger
  - Auth: Driver/Passenger
  - Payload: `{ bookingId }`
  - Workflow:
    1) Load booking document
    2) Emit to requester: `booking:status` with booking status snapshot

- Event: `booking:ETA_update`
  - Emitter: Driver
  - Auth: Driver
  - Payload: `{ bookingId, etaMinutes, message? }`
  - Workflow:
    1) Validate driver is assigned to booking
    2) Emit to room `booking:{bookingId}`: `booking:ETA_update` with ETA info

---

### Booking Domain (Server Emits)

- Event: `booking:status`
  - Target: Requesting socket
  - Payload: `{ bookingId, status, driverId, passengerId, vehicleType, pickup, dropoff }`

- Event: `booking:ETA_update`
  - Target: Room `booking:{bookingId}`
  - Payload: `{ bookingId, etaMinutes, message?, driverId, timestamp }`

- Event: `trip_started`
  - Target: Room `booking:{bookingId}`
  - Payload: `{ bookingId, startedAt, startLocation }`

- Event: `trip_ongoing`
  - Target: Room `booking:{bookingId}`
  - Payload: `{ bookingId, location }`

- Event: `trip_completed`
  - Target: Room `booking:{bookingId}`
  - Payload: `{ bookingId, amount, distance, waitingTime, completedAt, driverEarnings, commission }`

---

### Driver Domain

- Event: `driver:availability`
  - Emitter: Driver
  - Auth: Driver
  - Payload: `{ available: boolean }`
  - Workflow:
    1) Update availability via `driverService.setAvailability`
    2) Emit to room `driver:{driverId}`: `driver:availability` { driverId, available }

- Event: `booking:driver_location_update`
  - Emitter: Driver
  - Auth: Driver
  - Payload: `{ latitude, longitude, bearing?, bookingId? }`
  - Workflow:
    1) Update last known location via `driverService.updateLocation`
    2) Broadcast `driver:location` and `driver:position` with latest coordinates via `driverEvents`
    3) Also emit driver-scoped channel `driver:location:{driverId}` with same payload
    4) If `bookingId` context is used, downstream services may persist to Live tracking (see Live domain) and emit booking-scoped updates

---

### Live/Tracking Domain

- Event: `position:update`
  - Emitter: Server (periodic)
  - Source: `services/positionUpdate`
  - Payload: `{ tripId, driverId, passengerId, latitude, longitude, bearing?, timestamp }`
  - Workflow: Periodically broadcast latest position for active trips

- Event: `passenger:pickup_location`
  - Emitter: Server (HTTP live controller)
  - Payload: Live doc created with pickup location

- Event: `passenger:dropoff_location`
  - Emitter: Server (HTTP live controller)
  - Payload: Live doc created with dropoff location

- Event: `user:position`
  - Emitter: Server (HTTP live controller)
  - Payload: Live doc for generic user position

---

### Pricing Domain

- Event: `pricing:update`
  - Emitter: Server (HTTP pricing controller)
  - Payload: Updated pricing model document

---

### Booking Domain (Broadcasts)

- Event: `booking:new:broadcast`
  - Emitter: Server (events/bookingEvents)
  - Payload: New booking summary for passenger broadcast channels

- Event: `booking:update`
  - Emitter: Server (events/bookingEvents)
  - Payload: `{ id: bookingId, ...patch }` lifecycle updates

- Event: `booking:assigned`
  - Emitter: Server (events/bookingEvents)
  - Payload: `{ bookingId, driverId }`

---

### Driver Domain (Broadcasts)

- Event: `driver:location`
  - Emitter: Server (events/driverEvents)
  - Payload: `{ driverId, vehicleType, available, lastKnownLocation, updatedAt }`

- Event: `driver:position`
  - Emitter: Server (events/driverEvents)
  - Payload: same as `driver:location` (legacy compatibility)

- Event: `driver:availability`
  - Emitter: Server (events/driverEvents) to `driver:{driverId}` room
  - Payload: `{ driverId, available }`

- Event: `driver:location:{driverId}`
  - Emitter: Server (events/driverEvents)
  - Payload: `{ driverId, vehicleType, available, lastKnownLocation, updatedAt }`
  - Notes: Dynamic, targets a specific driver's public channel

---

### Rooms
- `booking:{bookingId}`: Participants in a single booking
- `driver:{driverId}`: A driver-specific channel for targeted messages
- `passenger:{passengerId}`: A passenger-specific channel for targeted messages
- `drivers`: Broadcast room for all connected drivers

---

### Common Error Event

- Event: `booking_error`
  - Emitter: Server (to requesting socket)
  - Payload: `{ message: string, source?: string, bookingId?: string }`
  - Notes: Emitted on validation/auth failures across booking and driver flows

