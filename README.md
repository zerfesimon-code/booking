# Ride Service API

A comprehensive ride-hailing service API built with Node.js, Express, Socket.IO, and MongoDB. This service provides real-time booking management, driver-passenger matching, live location tracking, and comprehensive analytics.

## 🚀 Features

- **Real-time Communication**: WebSocket-based real-time updates for bookings, location tracking, and messaging
- **Multi-role Authentication**: Support for passengers, drivers, staff, and admin users
- **Location Services**: GPS-based driver discovery and live location tracking
- **Booking Management**: Complete booking lifecycle from request to completion
- **Payment Integration**: Wallet system with SantimPay integration
- **Analytics & Reporting**: Comprehensive analytics for drivers, passengers, and system metrics
- **Rate Limiting & Security**: Built-in rate limiting and JWT-based authentication
- **Structured Logging**: Comprehensive logging system for monitoring and debugging

## 📋 Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [API Endpoints](#api-endpoints)
- [Socket Events](#socket-events)
- [Authentication](#authentication)
- [Logging](#logging)
- [Testing](#testing)
- [Deployment](#deployment)

## 🛠 Installation

```bash
# Clone the repository
git clone <repository-url>
cd ride-service-api

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Start the application
npm start
```

## ⚙️ Configuration

### Environment Variables

```env
# Server Configuration
PORT=4000
NODE_ENV=development

# Database
MONGODB_URI=mongodb://localhost:27017/ride-service

# JWT Configuration
JWT_SECRET=your-secret-key
JWT_AUDIENCE=ride-service
JWT_ISSUER=ride-service

# Logging
LOG_LEVEL=info

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Location Services
RADIUS_KM=5
BROADCAST_RADIUS_KM=5
LOCATION_UPDATE_THROTTLE_MS=3000

# Payment Integration
SANTIMPAY_MERCHANT_ID=your-merchant-id
SANTIMPAY_API_KEY=your-api-key
```

## 🔌 API Endpoints

### Authentication Endpoints

#### Passenger Authentication
- `POST /v1/auth/passenger/login` - Passenger login
- `POST /v1/auth/passenger/register` - Passenger registration

#### Driver Authentication
- `POST /v1/auth/driver/login` - Driver login
- `POST /v1/auth/driver/register` - Driver registration

#### Staff/Admin Authentication
- `POST /v1/auth/staff/login` - Staff login
- `POST /v1/auth/admin/login` - Admin login

### Booking Endpoints

#### Passenger Booking Management
- `POST /v1/bookings` - Create new booking
- `GET /v1/bookings` - Get user's bookings
- `GET /v1/bookings/:id` - Get booking details
- `PUT /v1/bookings/:id` - Update booking
- `DELETE /v1/bookings/:id` - Cancel booking
- `POST /v1/bookings/estimate` - Estimate fare

#### Driver Booking Management
- `GET /v1/bookings/nearby` - Get nearby bookings
- `POST /v1/bookings/:id/lifecycle` - Update booking status (accept, start, complete)

### Driver Endpoints

#### Driver Management
- `GET /v1/drivers/available` - Find available drivers
- `POST /v1/drivers/discover-and-estimate` - Discover drivers and estimate fare
- `POST /v1/drivers/estimate-fare` - Estimate fare for trip
- `POST /v1/drivers/:id/availability` - Update driver availability
- `POST /v1/drivers/:id/location` - Update driver location

### Live Tracking Endpoints

#### Position Updates
- `POST /v1/live/push` - Push live position update
- `GET /v1/live` - Get live updates
- `GET /v1/live/:id` - Get specific live update

### Analytics Endpoints

#### Driver Analytics
- `GET /v1/analytics/earnings/driver` - Get driver earnings
- `GET /v1/analytics/rides/history` - Get ride history

#### System Analytics
- `GET /v1/analytics/dashboard` - Get dashboard statistics
- `GET /v1/analytics/reports/daily` - Get daily report
- `GET /v1/analytics/reports/weekly` - Get weekly report
- `GET /v1/analytics/reports/monthly` - Get monthly report

### Wallet Endpoints

#### Wallet Management
- `POST /v1/wallet/topup` - Top up wallet
- `POST /v1/wallet/withdraw` - Withdraw funds
- `GET /v1/wallet/transactions/:userId` - Get transaction history
- `POST /v1/wallet/webhook` - Payment webhook

### Admin Endpoints

#### User Management
- `GET /v1/passengers` - List all passengers
- `POST /v1/passengers` - Create passenger
- `GET /v1/drivers` - List all drivers
- `GET /v1/drivers/:id` - Get driver details

#### System Management
- `GET /v1/assignments` - List assignments
- `POST /v1/assignments` - Create assignment
- `GET /v1/trips` - List trips
- `POST /v1/trips` - Create trip record

## 🔌 Socket Events

### Connection Events

#### `connection`
- **Description**: Client connects to socket server
- **Authentication**: Required (JWT token)
- **Response**: User authenticated and joined appropriate rooms

#### `disconnect`
- **Description**: Client disconnects from socket server
- **Response**: User disconnected and left all rooms

### Booking Events

#### `booking_request`
- **Description**: Passenger requests a new ride
- **Payload**: `{ vehicleType, pickup, dropoff, passengerCount, notes }`
- **Response**: `booking:created` with booking ID
- **Broadcast**: `booking:new` to nearby drivers

#### `booking_accept`
- **Description**: Driver accepts a booking request
- **Payload**: `{ bookingId }`
- **Response**: `booking:accepted`
- **Broadcast**: `booking:update` to booking room, `booking:removed` to other drivers

#### `booking_cancel`
- **Description**: Cancel a booking (passenger or driver)
- **Payload**: `{ bookingId, reason }`
- **Response**: `booking:cancelled`
- **Broadcast**: `booking:update` to booking room

#### `booking:status_request`
- **Description**: Request current booking status
- **Payload**: `{ bookingId }`
- **Response**: `booking:status` with current status

#### `booking:completed`
- **Description**: Driver marks trip as completed
- **Payload**: `{ bookingId }`
- **Response**: `booking:completed`
- **Broadcast**: `booking:update` to booking room

### Communication Events

#### `booking_note`
- **Description**: Send message in booking chat
- **Payload**: `{ bookingId, message }`
- **Response**: `booking:note` broadcast to booking room

#### `booking_notes_fetch`
- **Description**: Get chat history for booking
- **Payload**: `{ bookingId }`
- **Response**: `booking:notes_history` with message history

### Location Events

#### `booking:driver_location_update`
- **Description**: Driver updates location during trip
- **Payload**: `{ latitude, longitude, bookingId, timestamp }`
- **Response**: `booking:driver_location_update` broadcast to booking room

#### `booking:ETA_update`
- **Description**: Driver updates estimated arrival time
- **Payload**: `{ bookingId, etaMinutes, message }`
- **Response**: `booking:ETA_update` broadcast to booking room

### Driver Events

#### `driver:availability`
- **Description**: Update driver availability status
- **Payload**: `{ available: boolean }`
- **Response**: `driver:availability` confirmation

#### `booking:nearby`
- **Description**: Driver requests nearby bookings
- **Payload**: `{ latitude, longitude, radiusKm, vehicleType, limit }`
- **Response**: `booking:nearby` with nearby bookings

### Rating Events

#### `booking:rating`
- **Description**: Rate driver or passenger after trip
- **Payload**: `{ bookingId, rating, feedback }`
- **Response**: `booking:rating` broadcast to booking room

## 🔐 Authentication

### JWT Token Structure

```json
{
  "id": "user_id",
  "type": "passenger|driver|staff|admin",
  "name": "User Name",
  "phone": "+1234567890",
  "email": "user@example.com",
  "iat": 1234567890,
  "exp": 1234567890
}
```

### Authorization Levels

- **Passenger**: Can create bookings, view own bookings, rate drivers
- **Driver**: Can view nearby bookings, accept bookings, update location, rate passengers
- **Staff**: Can manage assignments, view all bookings, moderate system
- **Admin**: Full system access, user management, analytics, system configuration

## 📊 Logging

The system uses structured JSON logging with the following levels:

### Log Levels
- **ERROR**: System errors, authentication failures, critical issues
- **WARN**: Rate limiting, validation warnings, non-critical issues
- **INFO**: Business events, API requests, successful operations
- **DEBUG**: Detailed debugging information, database queries

### Log Categories

#### API Logging
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "INFO",
  "message": "API Request: POST /v1/bookings",
  "method": "POST",
  "url": "/v1/bookings",
  "userId": "user123",
  "responseTime": "150ms"
}
```

#### Socket Event Logging
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "INFO",
  "message": "Socket Event: booking_request",
  "event": "booking_request",
  "socketId": "socket123",
  "userId": "user123",
  "userType": "passenger"
}
```

#### Business Event Logging
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "INFO",
  "message": "Business Event: booking_created",
  "event": "booking_created",
  "userId": "user123",
  "bookingId": "booking456",
  "vehicleType": "mini"
}
```

#### Database Operation Logging
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "DEBUG",
  "message": "DB Operation: findOne on Booking",
  "operation": "findOne",
  "collection": "Booking",
  "query": { "_id": "booking456" }
}
```

## 🧪 Testing

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --grep "booking"

# Run with coverage
npm run test:coverage
```

### Test Categories

- **Unit Tests**: Individual function testing
- **Integration Tests**: API endpoint testing
- **Socket Tests**: Real-time event testing
- **Database Tests**: Data persistence testing

## 🚀 Deployment

### Docker Deployment

```bash
# Build Docker image
docker build -t ride-service-api .

# Run container
docker run -p 4000:4000 --env-file .env ride-service-api
```

### Environment-Specific Configuration

#### Development
```env
NODE_ENV=development
LOG_LEVEL=debug
AUTH_DEBUG=1
```

#### Production
```env
NODE_ENV=production
LOG_LEVEL=info
AUTH_DEBUG=0
```

## 📈 Monitoring

### Health Checks
- `GET /v1/health` - Basic health check
- `GET /v1/health/detailed` - Detailed system health

### Metrics
- Request/response times
- Socket connection counts
- Database query performance
- Error rates by endpoint

## 🔧 Troubleshooting

### Common Issues

1. **Socket Connection Failures**
   - Check JWT token validity
   - Verify CORS configuration
   - Check network connectivity

2. **Database Connection Issues**
   - Verify MongoDB connection string
   - Check database permissions
   - Monitor connection pool

3. **Authentication Errors**
   - Verify JWT secret configuration
   - Check token expiration
   - Validate user permissions

### Debug Mode

Enable debug logging:
```env
LOG_LEVEL=debug
AUTH_DEBUG=1
```

## 📝 API Response Format

All API responses follow this format:

```json
{
  "success": true,
  "data": {
    // Response data
  },
  "message": "Optional message",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

Error responses:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input data",
    "details": {
      "field": "email",
      "reason": "Invalid email format"
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For support and questions:
- Create an issue in the repository
- Check the troubleshooting section
- Review the API documentation
- Contact the development team