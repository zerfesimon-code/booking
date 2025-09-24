const mongoose = require('mongoose');
const { Wallet, Transaction } = require('../models/common');
const PaymentOption = require('../models/paymentOption');
const { Driver } = require('../models/userModels');
const santim = require('../integrations/santimpay');
const { getDriverById } = require('../integrations/userServiceClient');

function normalizeMsisdnEt(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/\s+/g, '').replace(/[-()]/g, '');
  if (/^\+?251/.test(s)) {
    s = s.replace(/^\+?251/, '+251');
  } else if (/^0\d+/.test(s)) {
    s = s.replace(/^0/, '+251');
  } else if (/^9\d{8}$/.test(s)) {
    s = '+251' + s;
  }
  if (!/^\+2519\d{8}$/.test(s)) return null;
  return s;
}

function mapProviderStatusToEnum(status) {
  const s = String(status || '').toUpperCase();
  if (['COMPLETED', 'SUCCESS', 'APPROVED'].includes(s)) return 'COMPLETED';
  if (['FAILED', 'FAILURE', 'DECLINED'].includes(s)) return 'FAILED';
  if (['CANCELED', 'CANCELLED'].includes(s)) return 'CANCELED';
  return 'pending';
}

function normalizeGatewayMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (m === 'telebirr' || m === 'tele') return 'Telebirr';
  if (m === 'cbe' || m === 'cbe-birr' || m === 'cbebirr') return 'CBE';
  if (m === 'hellocash' || m === 'hello-cash') return 'HelloCash';
  return 'Telebirr';
}

async function getDriverInfo(userId) {
  try {
    const d = await Driver.findById(String(userId)).select('name phone').lean();
    return { id: String(userId), name: d?.name || '', phone: d?.phone || '' };
  } catch (_) {
    return { id: String(userId) };
  }
}

async function resolvePaymentPreferenceForDriver(userId, authHeader) {
  const ext = await getDriverById(String(userId), { headers: authHeader ? { Authorization: authHeader } : undefined });
  const pref = ext && ext.paymentPreference;
  if (!pref) {
    const err = new Error('Payment option not found');
    err.status = 400;
    throw err;
  }
  const prefId = pref && (pref._id || pref.id || pref);
  const prefName = pref && pref.name ? String(pref.name) : undefined;

  let po = null;
  if (prefId) {
    try { po = await PaymentOption.findById(String(prefId)).lean(); } catch (_) {}
  }
  if (!po && prefName) {
    po = await PaymentOption.findOne({ name: new RegExp(`^${prefName}$`, 'i') }).lean();
  }
  if (!po) {
    const err = new Error('Payment option not found');
    err.status = 400;
    throw err;
  }
  return po;
}

exports.topup = async (req, res) => {
  try {
    const { amount, paymentMethod, reason = 'Wallet Topup' } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: 'amount must be > 0' });

    const tokenPhone = req.user && (req.user.phone || req.user.phoneNumber || req.user.mobile);
    if (!tokenPhone) return res.status(400).json({ message: 'phoneNumber missing in token' });
    const msisdn = normalizeMsisdnEt(tokenPhone);
    if (!msisdn) return res.status(400).json({ message: 'Invalid phone format in token. Required: +2519XXXXXXXX' });

    const userId = String(req.user.id);
    const role = req.user.type;

    // Drivers must have a valid paymentPreference mapped to PaymentOption
    let paymentOption = null;
    if (role === 'driver') {
      const authHeader = req.headers && req.headers.authorization;
      paymentOption = await resolvePaymentPreferenceForDriver(userId, authHeader);
    }

    // Ensure wallet exists before transaction
    let wallet = await Wallet.findOne({ userId, role });
    if (!wallet) wallet = await Wallet.create({ userId, role, balance: 0 });

    // Create pending credit transaction
    const txId = new mongoose.Types.ObjectId();
    const tx = await Transaction.create({
      _id: txId,
      refId: txId.toString(),
      userId,
      role,
      amount: amt,
      type: 'credit',
      method: 'santimpay',
      status: 'pending',
      msisdn,
      metadata: {
        reason,
        ...(paymentOption ? { paymentOption: { id: String(paymentOption._id), name: paymentOption.name } } : {})
      }
    });

    const methodForGateway = normalizeGatewayMethod(paymentMethod);
    const notifyUrl = process.env.SANTIMPAY_NOTIFY_URL || `${process.env.PUBLIC_BASE_URL || ''}/v1/wallet/webhook`;
    const gw = await santim.directPayment({
      id: txId.toString(),
      amount: amt,
      paymentReason: reason,
      notifyUrl,
      phoneNumber: msisdn,
      paymentMethod: methodForGateway
    });
    const gwTxnId = gw?.TxnId || gw?.txnId || gw?.data?.TxnId || gw?.data?.txnId;
    await Transaction.findByIdAndUpdate(txId, { txnId: gwTxnId || undefined, metadata: { ...tx.metadata, gatewayResponse: gw } });

    const driver = role === 'driver' ? await getDriverInfo(userId) : undefined;
    return res.status(202).json({ message: 'Topup initiated', transactionId: txId.toString(), gatewayTxnId: gwTxnId, driver });
  } catch (e) {
    const code = e.status && Number.isInteger(e.status) ? e.status : 500;
    return res.status(code).json({ message: e.message });
  }
};

exports.webhook = async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || body;
    const thirdPartyId = data.thirdPartyId || data.ID || data.id || data.transactionId || data.clientReference;
    const gwTxnId = data.TxnId || data.txnId;
    if (!thirdPartyId && !gwTxnId) return res.status(400).json({ message: 'Invalid webhook payload' });

    let tx = null;
    if (thirdPartyId && mongoose.Types.ObjectId.isValid(String(thirdPartyId))) tx = await Transaction.findById(thirdPartyId);
    if (!tx && thirdPartyId) tx = await Transaction.findOne({ refId: String(thirdPartyId) });
    if (!tx && gwTxnId) tx = await Transaction.findOne({ txnId: String(gwTxnId) });
    if (!tx) return res.status(200).json({ ok: false, message: 'Transaction not found for webhook', thirdPartyId, txnId: gwTxnId });

    const mappedStatus = mapProviderStatusToEnum(data.Status || data.status);
    const prev = tx.status;
    tx.txnId = gwTxnId || tx.txnId;
    tx.status = mappedStatus;
    const n = v => (v == null ? undefined : Number(v));
    tx.commission = n(data.commission) ?? n(data.Commission) ?? tx.commission;
    tx.totalAmount = n(data.totalAmount) ?? n(data.TotalAmount) ?? tx.totalAmount;
    tx.msisdn = data.Msisdn || data.msisdn || tx.msisdn;
    tx.metadata = { ...tx.metadata, webhook: data };
    await tx.save();

    // Apply wallet mutation only on transition to COMPLETED
    if (prev !== 'COMPLETED' && tx.status === 'COMPLETED') {
      const providerAmount = n(data.amount) ?? n(data.adjustedAmount) ?? n(tx.amount) ?? 0;
      if (tx.type === 'credit') {
        await Wallet.updateOne({ userId: tx.userId, role: tx.role }, { $inc: { balance: providerAmount } }, { upsert: true });
      } else if (tx.type === 'debit') {
        await Wallet.updateOne({ userId: tx.userId, role: tx.role }, { $inc: { balance: -providerAmount } }, { upsert: true });
      }
    }

    const wallet = await Wallet.findOne({ userId: tx.userId, role: tx.role }).lean();
    const driver = tx.role === 'driver' ? await getDriverInfo(tx.userId) : undefined;
    return res.status(200).json({ ok: true, txnId: tx.txnId, refId: tx.refId, status: tx.status, amount: tx.amount, currency: 'ETB', msisdn: tx.msisdn, paymentVia: data.paymentVia || data.PaymentMethod, balance: wallet ? wallet.balance : undefined, driver });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

exports.transactions = async (req, res) => {
  try {
    const userId = String(req.params.userId || req.user.id);
    const rows = await Transaction.find({ userId }).sort({ createdAt: -1 }).lean();
    const driver = (req.user && req.user.type === 'driver') ? await getDriverInfo(userId) : undefined;
    return res.json({ driver, transactions: rows });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.withdraw = async (req, res) => {
  try {
    const { amount, destination, paymentMethod, reason = 'Wallet Withdrawal' } = req.body || {};
    const userId = String(req.user.id);
    const role = req.user.type;
    if (role !== 'driver') return res.status(403).json({ message: 'Only drivers can withdraw' });

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: 'amount must be > 0' });

    // Ensure wallet exists
    let wallet = await Wallet.findOne({ userId, role });
    if (!wallet) wallet = await Wallet.create({ userId, role, balance: 0 });
    if (wallet.balance < amt) return res.status(400).json({ message: 'Insufficient balance' });

    const msisdn = normalizeMsisdnEt(destination || req.user.phone || req.user.phoneNumber || req.user.mobile);
    if (!msisdn) return res.status(400).json({ message: 'Invalid destination phone' });

    // Create pending transaction (do not deduct until COMPLETED via webhook)
    const tx = await Transaction.create({ userId, role, amount: amt, type: 'debit', method: 'santimpay', status: 'pending', msisdn, metadata: { destination, reason } });

    const methodForGateway = normalizeGatewayMethod(paymentMethod);
    const notifyUrl = process.env.SANTIMPAY_WITHDRAW_NOTIFY_URL || `${process.env.PUBLIC_BASE_URL || ''}/v1/wallet/webhook`;
    try {
      const gw = await santim.payoutTransfer({ id: String(tx._id), amount: amt, paymentReason: reason, phoneNumber: msisdn, paymentMethod: methodForGateway, notifyUrl });
      const gwTxnId = gw?.TxnId || gw?.txnId || gw?.data?.TxnId || gw?.data?.txnId;
      await Transaction.findByIdAndUpdate(tx._id, { txnId: gwTxnId, metadata: { ...tx.metadata, gatewayResponse: gw } });
    } catch (err) {
      await Transaction.findByIdAndUpdate(tx._id, { status: 'FAILED', metadata: { ...tx.metadata, gatewayError: err.message } });
      return res.status(502).json({ message: `Payout initiation failed: ${err.message}` });
    }

    const driver = await getDriverInfo(userId);
    return res.status(202).json({ message: 'Withdrawal initiated', transactionId: String(tx._id), driver });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};
