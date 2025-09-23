const PaymentOption = require('../models/paymentOption');
const { Driver } = require('../models/userModels');

async function getPaymentOptions() {
  return PaymentOption.find({}).select({ name: 1, logo: 1 }).sort({ name: 1 }).lean();
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

module.exports = { getPaymentOptions, setDriverPaymentPreference };

