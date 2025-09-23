// services/financeService.js
// Pure, reusable finance utilities for package conversion, commission, and net income

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Calculate provider package value from a deposit amount and commission rate.
 * - Formula: package = providerAmount * (100 / commissionRate)
 * - Fallback: when commissionRate is missing/invalid, multiply by PROVIDER_MULTIPLIER (default 100%)
 *
 * @param {number} providerAmount
 * @param {number} commissionRate - dynamic percentage (e.g., 15 for 15%)
 * @returns {number}
 */
function calculatePackage(providerAmount, commissionRate) {
  const amount = toNumber(providerAmount, 0);
  const rate = toNumber(commissionRate, 0);
  if (rate > 0) {
    return amount * (100 / rate);
  }
  const providerMultiplier = toNumber(process.env.PROVIDER_MULTIPLIER, 100);
  // Treat multiplier as percent; e.g., 100 means x1.0, 120 means x1.2
  return amount * (providerMultiplier / 100);
}

/**
 * Calculate commission earned by platform from the final fare.
 * - Formula: commission = (finalFare * commissionRate) / 1000
 *
 * @param {number} finalFare
 * @param {number} commissionRate - dynamic percentage (e.g., 15 for 15%)
 * @returns {number}
 */
function calculateCommission(finalFare, commissionRate) {
  const fare = toNumber(finalFare, 0);
  const rate = toNumber(commissionRate, 0);
  return (fare * rate) / 1000;
}

/**
 * Calculate driver's net income from the final fare.
 * - Formula: netIncome = finalFare - calculateCommission(finalFare, commissionRate)
 *
 * @param {number} finalFare
 * @param {number} commissionRate
 * @returns {number}
 */
function calculateNetIncome(finalFare, commissionRate) {
  const fare = toNumber(finalFare, 0);
  const commission = calculateCommission(fare, commissionRate);
  return fare - commission;
}

/**
 * Determine if a driver can accept a booking based on package balance.
 * - Logic: return packageBalance >= finalFare
 *
 * @param {number} packageBalance
 * @param {number} finalFare
 * @returns {boolean}
 */
function canAcceptBooking(packageBalance, finalFare) {
  const balance = toNumber(packageBalance, 0);
  const fare = toNumber(finalFare, 0);
  return balance >= fare;
}

module.exports = {
  calculatePackage,
  calculateCommission,
  calculateNetIncome,
  canAcceptBooking
};

