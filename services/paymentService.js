const PaymentOption = require('../models/paymentOption');
const { Driver } = require('../models/userModels');

async function createPaymentOption(data) {
  try {
    const payload = {
      name: typeof data.name === 'string' ? data.name.trim() : data.name,
      logo: data.logo
    };
    const doc = await PaymentOption.create(payload);
    return doc.toObject();
  } catch (err) {
    // Duplicate key error for unique name
    if (err && err.code === 11000) {
      err.status = 409;
    }
    throw err;
  }
}

async function getPaymentOptions() {
  return PaymentOption.find({}).select({ name: 1, logo: 1 }).sort({ name: 1 }).lean();
}

async function getPaymentOptionById(id) {
  return PaymentOption.findById(id).lean();
}

async function updatePaymentOption(id, data) {
  const updates = {};
  if (typeof data.name !== 'undefined') updates.name = typeof data.name === 'string' ? data.name.trim() : data.name;
  if (typeof data.logo !== 'undefined') updates.logo = data.logo;
  try {
    const updated = await PaymentOption.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
    return updated ? updated.toObject() : null;
  } catch (err) {
    if (err && err.code === 11000) {
      err.status = 409;
    }
    throw err;
  }
}

async function deletePaymentOption(id) {
  const deleted = await PaymentOption.findByIdAndDelete(id);
  return deleted ? deleted.toObject() : null;
}

async function setDriverPaymentPreference(driverId, paymentOptionId) {
  const opt = await PaymentOption.findById(paymentOptionId).lean();
  if (!opt) {
    const err = new Error('Payment option not found');
    err.status = 404;
    throw err;
  }
  const updated = await Driver.findByIdAndUpdate(String(driverId), { $set: { paymentPreference: opt._id } }, { new: true })
    .populate({ path: 'paymentPreference', select: { name: 1, logo: 1 } });
  if (!updated) {
    const err = new Error('Driver not found');
    err.status = 404;
    throw err;
  }
  return updated;
}

module.exports = {
  createPaymentOption,
  getPaymentOptions,
  getPaymentOptionById,
  updatePaymentOption,
  deletePaymentOption,
  setDriverPaymentPreference
};

