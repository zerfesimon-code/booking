const { Passenger } = require('../models/userModels');
const { hashPassword } = require('../utils/password');

exports.create = async (req, res) => {
  try {
    const data = req.body || {};
    if (data.password) data.password = await hashPassword(data.password);
    const row = await Passenger.create(data);
    const passengerWithRoles = await Passenger.findById(row._id).populate('roles').lean();
    return res.status(201).json(passengerWithRoles);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.list = async (req, res) => {
  try {
    const rows = await Passenger.find().populate('roles').lean();
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.get = async (req, res) => {
  try {
    const row = await Passenger.findById(req.params.id).populate('roles').lean();
    if (!row) return res.status(404).json({ message: 'Passenger not found' });
    return res.json(row);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const body = req.body || {};

    const allowedFields = ['name', 'phone', 'email', 'emergencyContacts', 'contractId', 'wallet', 'rewardPoints'];
    const data = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(body, key)) data[key] = body[key];
    }

    if (body.password) {
      data.password = await hashPassword(body.password);
    }

    if ('rating' in data) delete data.rating;
    if ('ratingCount' in data) delete data.ratingCount;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ message: 'No updatable fields provided.' });
    }

    const updated = await Passenger.findByIdAndUpdate(req.params.id, data, { new: true })
      .populate('roles')
      .lean();
    if (!updated) return res.status(404).json({ message: 'Passenger not found' });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const r = await Passenger.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ message: 'Passenger not found' });
    return res.status(204).send();
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    if (req.user.type !== 'passenger') return res.status(403).json({ message: 'Only passengers can access this endpoint' });
    const passenger = await Passenger.findById(req.user.id).populate('roles').lean();
    if (!passenger) return res.status(404).json({ message: 'Passenger not found' });
    return res.json(passenger);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    if (req.user.type !== 'passenger') return res.status(403).json({ message: 'Only passengers can access this endpoint' });
    const data = { ...req.body };
    if ('rating' in data) delete data.rating;
    if ('ratingCount' in data) delete data.ratingCount;
    if ('rewardPoints' in data) delete data.rewardPoints;

    if (data.password) data.password = await hashPassword(data.password);

    const updated = await Passenger.findByIdAndUpdate(req.user.id, data, { new: true })
      .populate('roles')
      .lean();
    if (!updated) return res.status(404).json({ message: 'Passenger not found' });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.deleteMyAccount = async (req, res) => {
  try {
    if (req.user.type !== 'passenger') return res.status(403).json({ message: 'Only passengers can delete their account' });
    const r = await Passenger.findByIdAndDelete(req.user.id);
    if (!r) return res.status(404).json({ message: 'Passenger not found' });
    return res.status(204).send();
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.rateDriver = async (req, res) => {
  try {
    if (req.user.type !== 'passenger') return res.status(403).json({ message: 'Only passengers can rate drivers' });
    const { rating } = req.body;
    const driverId = req.params.driverId;

    const { Driver } = require('../models/userModels');
    const driver = await Driver.findById(driverId);
    if (!driver) return res.status(404).json({ message: 'Driver not found' });

    const value = Number(rating);
    if (!Number.isFinite(value) || value < 0 || value > 5) return res.status(400).json({ message: 'Invalid rating. Must be between 0 and 5.' });
    const newRating = Math.max(0, Math.min(5, value));

    driver.rating = newRating;
    await driver.save();
    return res.json({ message: 'Driver rated successfully', driver });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

