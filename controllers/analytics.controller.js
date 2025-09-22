const dayjs = require('dayjs');
const { Booking, TripHistory } = require('../models/bookingModels');
const { Driver, Passenger } = require('../models/userModels');
const { Commission, DriverEarnings, AdminEarnings, Payout } = require('../models/commission');
const { DailyReport, WeeklyReport, MonthlyReport, Complaint } = require('../models/analytics');

// Dashboard Statistics
// Dashboard Statistics
exports.getDashboardStats = async (req, res) => {
  try {
    console.log("[getDashboardStats] fetching dashboard data...");

    const today = dayjs().startOf('day').toDate();
    const thisWeek = dayjs().startOf('week').toDate();
    const thisMonth = dayjs().startOf('month').toDate();

    // Total counts
    const totalRides = await Booking.countDocuments();
    console.log("[getDashboardStats] totalRides:", totalRides);

    const totalEarnings = await Booking.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$fareFinal' } } }
    ]);
    console.log("[getDashboardStats] totalEarnings (agg):", totalEarnings);

    const totalUsers = await Passenger.countDocuments();
    console.log("[getDashboardStats] totalUsers:", totalUsers);

    const totalDrivers = await Driver.countDocuments();
    console.log("[getDashboardStats] totalDrivers:", totalDrivers);

    const totalCars = await Driver.countDocuments();
    console.log("[getDashboardStats] totalCars:", totalCars);

    const totalComplaints = await Complaint.countDocuments();
    console.log("[getDashboardStats] totalComplaints:", totalComplaints);

    // Today's stats
    const todayRides = await Booking.countDocuments({
      createdAt: { $gte: today }
    });
    console.log("[getDashboardStats] todayRides:", todayRides);

    const todayEarnings = await Booking.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: '$fareFinal' } } }
    ]);
    console.log("[getDashboardStats] todayEarnings (agg):", todayEarnings);

    // This week's stats
    const weekRides = await Booking.countDocuments({
      createdAt: { $gte: thisWeek }
    });
    console.log("[getDashboardStats] weekRides:", weekRides);

    const weekEarnings = await Booking.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: thisWeek } } },
      { $group: { _id: null, total: { $sum: '$fareFinal' } } }
    ]);
    console.log("[getDashboardStats] weekEarnings (agg):", weekEarnings);

    // This month's stats
    const monthRides = await Booking.countDocuments({
      createdAt: { $gte: thisMonth }
    });
    console.log("[getDashboardStats] monthRides:", monthRides);

    const monthEarnings = await Booking.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: thisMonth } } },
      { $group: { _id: null, total: { $sum: '$fareFinal' } } }
    ]);
    console.log("[getDashboardStats] monthEarnings (agg):", monthEarnings);

    // Commission stats
    const totalCommission = await AdminEarnings.aggregate([
      { $group: { _id: null, total: { $sum: '$commissionEarned' } } }
    ]);
    console.log("[getDashboardStats] totalCommission (agg):", totalCommission);

    // Pending payouts
    const pendingPayouts = await Payout.aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$netPayout' } } }
    ]);
    console.log("[getDashboardStats] pendingPayouts (agg):", pendingPayouts);

    res.json({
      overview: {
        totalRides,
        totalEarnings: totalEarnings[0]?.total || 0,
        totalUsers,
        totalDrivers,
        totalCars,
        totalComplaints,
        totalCommission: totalCommission[0]?.total || 0,
        pendingPayouts: pendingPayouts[0]?.total || 0
      },
      today: {
        rides: todayRides,
        earnings: todayEarnings[0]?.total || 0
      },
      thisWeek: {
        rides: weekRides,
        earnings: weekEarnings[0]?.total || 0
      },
      thisMonth: {
        rides: monthRides,
        earnings: monthEarnings[0]?.total || 0
      }
    });
  } catch (e) {
    console.error("[getDashboardStats] error:", e);
    res.status(500).json({ message: `Failed to get dashboard stats: ${e.message}` });
  }
};


// Revenue Reports
exports.getDailyReport = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? dayjs(date).startOf('day').toDate() : dayjs().startOf('day').toDate();
    const nextDay = dayjs(targetDate).add(1, 'day').toDate();

    // Get or create daily report
    let report = await DailyReport.findOne({ date: targetDate });
    
    if (!report) {
      // Generate report for the day
      const rides = await Booking.find({
        createdAt: { $gte: targetDate, $lt: nextDay }
      }).populate('driverId passengerId');

      const totalRevenue = rides
        .filter(r => r.status === 'completed')
        .reduce((sum, r) => sum + (r.fareFinal || r.fareEstimated), 0);

      const totalCommission = await AdminEarnings.aggregate([
        { $match: { tripDate: { $gte: targetDate, $lt: nextDay } } },
        { $group: { _id: null, total: { $sum: '$commissionEarned' } } }
      ]);

      report = await DailyReport.create({
        date: targetDate,
        totalRides: rides.length,
        totalRevenue,
        totalCommission: totalCommission[0]?.total || 0,
        completedRides: rides.filter(r => r.status === 'completed').length,
        canceledRides: rides.filter(r => r.status === 'canceled').length,
        averageFare: rides.length > 0 ? totalRevenue / rides.filter(r => r.status === 'completed').length : 0,
        rideDetails: rides.map(r => ({
          bookingId: r._id,
          driverId: r.driverId,
          passengerId: r.passengerId,
          fare: r.fareFinal || r.fareEstimated,
          commission: (r.fareFinal || r.fareEstimated) * 0.15, // Default 15% commission
          status: r.status,
          vehicleType: r.vehicleType,
          distanceKm: r.distanceKm
        }))
      });
    }

    res.json(report);
  } catch (e) {
    res.status(500).json({ message: `Failed to get daily report: ${e.message}` });
  }
};

exports.getWeeklyReport = async (req, res) => {
  try {
    const { weekStart } = req.query;
    const startDate = weekStart ? dayjs(weekStart).startOf('week').toDate() : dayjs().startOf('week').toDate();
    const endDate = dayjs(startDate).endOf('week').toDate();

    let report = await WeeklyReport.findOne({ weekStart: startDate });
    
    if (!report) {
      // Generate weekly report
      const rides = await Booking.find({
        createdAt: { $gte: startDate, $lte: endDate }
      });

      const totalRevenue = rides
        .filter(r => r.status === 'completed')
        .reduce((sum, r) => sum + (r.fareFinal || r.fareEstimated), 0);

      const totalCommission = await AdminEarnings.aggregate([
        { $match: { tripDate: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, total: { $sum: '$commissionEarned' } } }
      ]);

      report = await WeeklyReport.create({
        weekStart: startDate,
        weekEnd: endDate,
        totalRides: rides.length,
        totalRevenue,
        totalCommission: totalCommission[0]?.total || 0,
        completedRides: rides.filter(r => r.status === 'completed').length,
        canceledRides: rides.filter(r => r.status === 'canceled').length,
        averageFare: rides.length > 0 ? totalRevenue / rides.filter(r => r.status === 'completed').length : 0
      });
    }

    res.json(report);
  } catch (e) {
    res.status(500).json({ message: `Failed to get weekly report: ${e.message}` });
  }
};

exports.getMonthlyReport = async (req, res) => {
  try {
    const { month, year } = req.query;
    const targetMonth = month ? parseInt(month) : dayjs().month() + 1;
    const targetYear = year ? parseInt(year) : dayjs().year();
    const startDate = dayjs().month(targetMonth - 1).year(targetYear).startOf('month').toDate();
    const endDate = dayjs().month(targetMonth - 1).year(targetYear).endOf('month').toDate();

    let report = await MonthlyReport.findOne({ month: targetMonth, year: targetYear });
    
    if (!report) {
      // Generate monthly report
      const rides = await Booking.find({
        createdAt: { $gte: startDate, $lte: endDate }
      });

      const totalRevenue = rides
        .filter(r => r.status === 'completed')
        .reduce((sum, r) => sum + (r.fareFinal || r.fareEstimated), 0);

      const totalCommission = await AdminEarnings.aggregate([
        { $match: { tripDate: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, total: { $sum: '$commissionEarned' } } }
      ]);

      report = await MonthlyReport.create({
        month: targetMonth,
        year: targetYear,
        totalRides: rides.length,
        totalRevenue,
        totalCommission: totalCommission[0]?.total || 0,
        completedRides: rides.filter(r => r.status === 'completed').length,
        canceledRides: rides.filter(r => r.status === 'canceled').length,
        averageFare: rides.length > 0 ? totalRevenue / rides.filter(r => r.status === 'completed').length : 0
      });
    }

    res.json(report);
  } catch (e) {
    res.status(500).json({ message: `Failed to get monthly report: ${e.message}` });
  }
};

// Driver Earnings Management
exports.getDriverEarnings = async (req, res) => {
  try {
    const { driverId, period, startDate, endDate } = req.query;
    const driverIdFilter = driverId || req.user.id;

    let dateFilter = {};
    if (period === 'daily') {
      const today = dayjs().startOf('day').toDate();
      const tomorrow = dayjs().add(1, 'day').startOf('day').toDate();
      dateFilter = { tripDate: { $gte: today, $lt: tomorrow } };
    } else if (period === 'weekly') {
      const weekStart = dayjs().startOf('week').toDate();
      const weekEnd = dayjs().endOf('week').toDate();
      dateFilter = { tripDate: { $gte: weekStart, $lte: weekEnd } };
    } else if (period === 'monthly') {
      const monthStart = dayjs().startOf('month').toDate();
      const monthEnd = dayjs().endOf('month').toDate();
      dateFilter = { tripDate: { $gte: monthStart, $lte: monthEnd } };
    } else if (startDate && endDate) {
      dateFilter = { tripDate: { $gte: new Date(startDate), $lte: new Date(endDate) } };
    }

    let earnings = await DriverEarnings.find({
      driverId: String(driverIdFilter),
      ...dateFilter
    }).populate('bookingId').sort({ tripDate: -1 });
    // Only include completed bookings
    earnings = earnings.filter(e => e.bookingId && e.bookingId.status === 'completed');

    const summary = await DriverEarnings.aggregate([
      { $match: { driverId: String(driverIdFilter), ...dateFilter } },
      { $lookup: { from: 'bookings', localField: 'bookingId', foreignField: '_id', as: 'booking' } },
      { $unwind: '$booking' },
      { $match: { 'booking.status': 'completed' } },
      {
        $group: {
          _id: null,
          totalRides: { $sum: 1 },
          totalFareCollected: { $sum: '$grossFare' },
          totalCommissionDeducted: { $sum: '$commissionAmount' },
          netEarnings: { $sum: '$netEarnings' }
        }
      }
    ]);

    // Integrate wallet balance
    let walletBalance = 0;
    try {
      const { Wallet } = require('../models/common');
      const wallet = await Wallet.findOne({ userId: String(driverIdFilter), role: 'driver' }).lean();
      walletBalance = wallet ? wallet.balance : 0;
    } catch (_) {}

    res.json({
      summary: summary[0] || {
        totalRides: 0,
        totalFareCollected: 0,
        totalCommissionDeducted: 0,
        netEarnings: 0
      },
      wallet: { balance: walletBalance },
      earnings
    });
  } catch (e) {
    res.status(500).json({ message: `Failed to get driver earnings: ${e.message}` });
  }
};

// Commission Management
exports.setCommission = async (req, res) => {
  try {
    const { percentage, description } = req.body;
    const adminId = req.user.id;

    if (percentage < 0 || percentage > 100) {
      return res.status(400).json({ message: 'Commission percentage must be between 0 and 100' });
    }

    // Deactivate current commission
    await Commission.updateMany({ isActive: true }, { isActive: false });

    // Create new commission
    const commission = await Commission.create({
      percentage,
      description,
      createdBy: adminId
    });

    res.json(commission);
  } catch (e) {
    res.status(500).json({ message: `Failed to set commission: ${e.message}` });
  }
};

exports.getCommission = async (req, res) => {
  try {
    const commission = await Commission.findOne({ isActive: true }).sort({ createdAt: -1 });
    res.json(commission || { percentage: 15, isActive: true }); // Default 15%
  } catch (e) {
    res.status(500).json({ message: `Failed to get commission: ${e.message}` });
  }
};

// Ride History (integrated with TripHistory + Bookings, with date/status filters)
exports.getRideHistory = async (req, res) => {
  try {
    const userType = req.user.type;
    const userId = String(req.user.id);
    const { page = 1, limit = 10, status, dateFrom, dateTo } = req.query;

    // TripHistory is the source of truth for lifecycle + timing
    const tripMatch = {};
    if (userType === 'driver') tripMatch.driverId = userId;
    if (userType === 'passenger') tripMatch.passengerId = userId;
    if (status) tripMatch.status = status;
    if (dateFrom || dateTo) {
      const from = dateFrom ? new Date(dateFrom) : new Date();
      const to = dateTo ? new Date(dateTo) : new Date();
      // Prefer completedAt/startTime/dateOfTravel when available
      tripMatch.$or = [
        { completedAt: { $gte: from, $lte: to } },
        { startedAt: { $gte: from, $lte: to } },
        { dateOfTravel: { $gte: from, $lte: to } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Aggregate TripHistory with corresponding Booking document
    const pipeline = [
      { $match: tripMatch },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) },
      { $lookup: { from: 'bookings', localField: 'bookingId', foreignField: '_id', as: 'booking' } },
      { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
    ];

    const [rows, totalCount] = await Promise.all([
      TripHistory.aggregate(pipeline),
      TripHistory.countDocuments(tripMatch)
    ]);

    // External driver enrichment (best-effort)
    let driverInfoMap = {};
    try {
      const { getDriversByIds } = require('../integrations/userServiceClient');
      const driverIds = [...new Set(rows.map(r => r.driverId).filter(Boolean))];
      if (driverIds.length) {
        const infos = await getDriversByIds(driverIds, { headers: req.headers.authorization ? { Authorization: req.headers.authorization } : undefined });
        driverInfoMap = Object.fromEntries((infos || []).map(i => [String(i.id), { id: String(i.id), name: i.name, phone: i.phone }]));
      }
    } catch (_) {}

    const data = rows.map(r => ({
      id: String(r._id),
      bookingId: String(r.bookingId),
      status: r.status,
      fare: r.fare ?? r.booking?.fareFinal ?? r.booking?.fareEstimated,
      distanceKm: r.distance ?? r.booking?.distanceKm,
      waitingTime: r.waitingTime,
      vehicleType: r.vehicleType ?? r.booking?.vehicleType,
      startedAt: r.startedAt ?? r.startTime,
      completedAt: r.completedAt ?? r.endTime,
      pickup: r.booking?.pickup,
      dropoff: r.booking?.dropoff,
      dropoffLocation: r.dropoffLocation,
      passenger: r.booking ? { id: String(r.booking.passengerId), name: r.booking.passengerName, phone: r.booking.passengerPhone } : undefined,
      driverId: r.driverId && String(r.driverId),
      driver: r.driverId ? driverInfoMap[String(r.driverId)] : undefined
    }));

    res.json({
      rides: data,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(totalCount / parseInt(limit)),
        total: totalCount
      }
    });
  } catch (e) {
    res.status(500).json({ message: `Failed to get ride history: ${e.message}` });
  }
};

// Get trip history by user ID (integrated with TripHistory + Bookings)
exports.getTripHistoryByUserId = async (req, res) => {
  try {
    const { userType, userId } = req.params;
    const { status, page = 1, limit = 20 } = req.query;

    if (!userType || !userId) {
      return res.status(400).json({ message: 'userType and userId are required' });
    }
    if (userType !== 'driver' && userType !== 'passenger') {
      return res.status(400).json({ message: 'userType must be either driver or passenger' });
    }

    const tripMatch = {};
    if (userType === 'driver') tripMatch.driverId = String(userId);
    if (userType === 'passenger') tripMatch.passengerId = String(userId);
    if (status) tripMatch.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const pipeline = [
      { $match: tripMatch },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) },
      { $lookup: { from: 'bookings', localField: 'bookingId', foreignField: '_id', as: 'booking' } },
      { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
    ];

    const [rows, totalCount] = await Promise.all([
      TripHistory.aggregate(pipeline),
      TripHistory.countDocuments(tripMatch)
    ]);

    let driverInfoMap = {};
    try {
      const { getDriversByIds } = require('../integrations/userServiceClient');
      const driverIds = [...new Set(rows.map(r => r.driverId).filter(Boolean))];
      if (driverIds.length) {
        const infos = await getDriversByIds(driverIds, { headers: req.headers.authorization ? { Authorization: req.headers.authorization } : undefined });
        driverInfoMap = Object.fromEntries((infos || []).map(i => [String(i.id), { id: String(i.id), name: i.name, phone: i.phone }]));
      }
    } catch (_) {}

    const trips = rows.map(r => ({
      id: String(r._id),
      bookingId: String(r.bookingId),
      status: r.status,
      fare: r.fare ?? r.booking?.fareFinal ?? r.booking?.fareEstimated,
      distanceKm: r.distance ?? r.booking?.distanceKm,
      waitingTime: r.waitingTime,
      vehicleType: r.vehicleType ?? r.booking?.vehicleType,
      startedAt: r.startedAt ?? r.startTime,
      completedAt: r.completedAt ?? r.endTime,
      pickup: r.booking?.pickup,
      dropoff: r.booking?.dropoff,
      dropoffLocation: r.dropoffLocation,
      passenger: r.booking ? { id: String(r.booking.passengerId), name: r.booking.passengerName, phone: r.booking.passengerPhone } : undefined,
      driverId: r.driverId && String(r.driverId),
      driver: r.driverId ? driverInfoMap[String(r.driverId)] : undefined
    }));

    res.json({
      trips,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(totalCount / parseInt(limit)),
        total: totalCount
      }
    });
  } catch (e) {
    res.status(500).json({ message: `Failed to get trip history: ${e.message}` });
  }
};

// Finance Overview
exports.getFinanceOverview = async (req, res) => {
  try {
    const { period = 'monthly' } = req.query;
    
    let dateFilter = {};
    if (period === 'daily') {
      const today = dayjs().startOf('day').toDate();
      const tomorrow = dayjs().add(1, 'day').startOf('day').toDate();
      dateFilter = { tripDate: { $gte: today, $lt: tomorrow } };
    } else if (period === 'weekly') {
      const weekStart = dayjs().startOf('week').toDate();
      const weekEnd = dayjs().endOf('week').toDate();
      dateFilter = { tripDate: { $gte: weekStart, $lte: weekEnd } };
    } else if (period === 'monthly') {
      const monthStart = dayjs().startOf('month').toDate();
      const monthEnd = dayjs().endOf('month').toDate();
      dateFilter = { tripDate: { $gte: monthStart, $lte: monthEnd } };
    }

    // Total revenue
    const totalRevenue = await Booking.aggregate([
      { $match: { status: 'completed', ...dateFilter } },
      { $group: { _id: null, total: { $sum: '$fareFinal' } } }
    ]);

    // Commission earned
    const commissionEarned = await AdminEarnings.aggregate([
      { $match: dateFilter },
      { $group: { _id: null, total: { $sum: '$commissionEarned' } } }
    ]);

    // Pending payouts
    const pendingPayouts = await Payout.aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$netPayout' } } }
    ]);

    // Top earning drivers
    const topDrivers = await DriverEarnings.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: '$driverId',
          totalEarnings: { $sum: '$netEarnings' },
          totalRides: { $sum: 1 }
        }
      },
      { $sort: { totalEarnings: -1 } },
      { $limit: 10 }
    ]);

    // Most profitable routes (by distance)
    const profitableRoutes = await Booking.aggregate([
      { $match: { status: 'completed', ...dateFilter } },
      {
        $group: {
          _id: {
            pickupLat: { $round: ['$pickup.latitude', 2] },
            pickupLng: { $round: ['$pickup.longitude', 2] },
            dropoffLat: { $round: ['$dropoff.latitude', 2] },
            dropoffLng: { $round: ['$dropoff.longitude', 2] }
          },
          totalRevenue: { $sum: '$fareFinal' },
          rideCount: { $sum: 1 },
          avgFare: { $avg: '$fareFinal' }
        }
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 }
    ]);

    // Wallet aggregates
    let walletTotals = { totalDriverBalances: 0, totalPassengerBalances: 0 };
    try {
      const { Wallet } = require('../models/common');
      const driverAgg = await Wallet.aggregate([
        { $match: { role: 'driver' } },
        { $group: { _id: null, total: { $sum: '$balance' } } }
      ]);
      const passengerAgg = await Wallet.aggregate([
        { $match: { role: 'passenger' } },
        { $group: { _id: null, total: { $sum: '$balance' } } }
      ]);
      walletTotals.totalDriverBalances = driverAgg[0]?.total || 0;
      walletTotals.totalPassengerBalances = passengerAgg[0]?.total || 0;
    } catch (_) {}

    res.json({
      totalRevenue: totalRevenue[0]?.total || 0,
      commissionEarned: commissionEarned[0]?.total || 0,
      pendingPayouts: pendingPayouts[0]?.total || 0,
      wallet: walletTotals,
      topEarningDrivers: topDrivers,
      mostProfitableRoutes: profitableRoutes
    });
  } catch (e) {
    res.status(500).json({ message: `Failed to get finance overview: ${e.message}` });
  }
};

// Rewards: 10 ETB per 2km of completed rides
async function computeRewardsForUser(userType, userId) {
  const match = { status: 'completed' };
  if (userType === 'driver') match.driverId = String(userId);
  if (userType === 'passenger') match.passengerId = String(userId);

  const agg = await Booking.aggregate([
    { $match: match },
    { $group: { _id: null, totalKm: { $sum: '$distanceKm' }, rides: { $sum: 1 } } }
  ]);

  const totalDistanceKm = agg[0]?.totalKm || 0;
  const completedRides = agg[0]?.rides || 0;
  const rewardPoints = Math.floor(totalDistanceKm / 2) * 10; // 10 ETB per 2km
  return { totalDistanceKm, completedRides, rewardPoints };
}

exports.getPassengerRewards = async (req, res) => {
  try {
    const passengerId = req.query.passengerId || req.user.id;
    const out = await computeRewardsForUser('passenger', passengerId);
    res.json({
      passengerId: String(passengerId),
      rule: '10 ETB per 2km of completed trips',
      ...out
    });
  } catch (e) {
    res.status(500).json({ message: `Failed to compute passenger rewards: ${e.message}` });
  }
};

exports.getDriverRewards = async (req, res) => {
  try {
    const driverId = req.query.driverId || req.user.id;
    const out = await computeRewardsForUser('driver', driverId);
    res.json({
      driverId: String(driverId),
      rule: '10 ETB per 2km of completed trips',
      ...out
    });
  } catch (e) {
    res.status(500).json({ message: `Failed to compute driver rewards: ${e.message}` });
  }
};
