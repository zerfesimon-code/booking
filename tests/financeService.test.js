const assert = require('assert');

describe('financeService', () => {
  const finance = require('../services/financeService');

  describe('calculatePackage', () => {
    it('uses formula providerAmount * (100 / commissionRate) when rate > 0', () => {
      const result = finance.calculatePackage(100, 20); // 100 * (100/20) = 500
      assert.strictEqual(result, 500);
    });

    it('falls back to PROVIDER_MULTIPLIER when rate is 0', () => {
      const prev = process.env.PROVIDER_MULTIPLIER;
      process.env.PROVIDER_MULTIPLIER = '120';
      const result = finance.calculatePackage(100, 0); // 100 * (120/100) = 120
      assert.strictEqual(result, 120);
      process.env.PROVIDER_MULTIPLIER = prev;
    });

    it('defaults multiplier to 100 when env missing', () => {
      const prev = process.env.PROVIDER_MULTIPLIER;
      delete process.env.PROVIDER_MULTIPLIER;
      const result = finance.calculatePackage(200, undefined); // 200 * (100/100) = 200
      assert.strictEqual(result, 200);
      process.env.PROVIDER_MULTIPLIER = prev;
    });
  });

  describe('calculateCommission', () => {
    it('computes commission = (finalFare * commissionRate) / 1000', () => {
      const result = finance.calculateCommission(1000, 15); // 1000*15/1000 = 15
      assert.strictEqual(result, 15);
    });
  });

  describe('calculateNetIncome', () => {
    it('computes netIncome = finalFare - commission', () => {
      const result = finance.calculateNetIncome(1000, 15); // 1000 - 15 = 985
      assert.strictEqual(result, 985);
    });
  });

  describe('canAcceptBooking', () => {
    it('returns true when packageBalance >= finalFare', () => {
      assert.strictEqual(finance.canAcceptBooking(200, 150), true);
    });
    it('returns false when packageBalance < finalFare', () => {
      assert.strictEqual(finance.canAcceptBooking(100, 150), false);
    });
  });
});

