const { Wallet, Transaction } = require("../models/common");
const santim = require("../integrations/santimpay");
const mongoose = require("mongoose");
const { Driver } = require("../models/userModels");
const { Commission } = require("../models/commission");
const financeService = require("../services/financeService");
const logger = require("../utils/logger"); // <-- logger util

/* ---------------------- TOPUP ---------------------- */
exports.topup = async (req, res) => {
  try {
    const { amount, paymentMethod, reason = "Wallet Topup" } = req.body || {};
    if (!amount || amount <= 0) {
      logger.warn("[topup] Invalid amount:", amount);
      return res.status(400).json({ message: "amount must be > 0" });
    }

    const tokenPhone =
      req.user && (req.user.phone || req.user.phoneNumber || req.user.mobile);
    if (!tokenPhone) {
      logger.warn("[topup] Missing phoneNumber in token for user:", req.user?.id);
      return res.status(400).json({ message: "phoneNumber missing in token" });
    }

    // Normalize Ethiopian MSISDN
    const normalizeMsisdnEt = (raw) => {
      if (!raw) return null;
      let s = String(raw).trim();
      s = s.replace(/\s+/g, "").replace(/[-()]/g, "");
      if (/^\+?251/.test(s)) s = s.replace(/^\+?251/, "+251");
      else if (/^0\d+/.test(s)) s = s.replace(/^0/, "+251");
      else if (/^9\d{8}$/.test(s)) s = "+251" + s;
      if (!/^\+2519\d{8}$/.test(s)) return null;
      return s;
    };

    const msisdn = normalizeMsisdnEt(tokenPhone);
    if (!msisdn) {
      logger.warn("[topup] Invalid phone format in token:", tokenPhone);
      return res.status(400).json({
        message: "Invalid phone format in token. Required: +2519XXXXXXXX",
      });
    }

    const userId = String(req.user.id);
    const role = req.user.type;

    let wallet = await Wallet.findOne({ userId, role });
    if (!wallet) {
      wallet = await Wallet.create({ userId, role, balance: 0 });
      logger.info("[topup] Wallet created:", wallet);
    }

    const txId = new mongoose.Types.ObjectId();
    const tx = await Transaction.create({
      _id: txId,
      refId: txId.toString(),
      userId,
      role,
      amount,
      type: "credit",
      method: "santimpay",
      status: "PENDING",
      msisdn,
      metadata: { reason },
    });
    logger.info("[topup] Transaction created:", txId.toString());

    const normalizePaymentMethod = (method) => {
      const m = String(method || "").trim().toLowerCase();
      if (m === "telebirr" || m === "tele") return "Telebirr";
      if (m === "cbe" || m === "cbe-birr" || m === "cbebirr") return "CBE";
      if (m === "hellocash" || m === "hello-cash") return "HelloCash";
      return "Telebirr";
    };
    const methodForGateway = normalizePaymentMethod(paymentMethod);

    const notifyUrl =
      process.env.SANTIMPAY_NOTIFY_URL ||
      `${process.env.PUBLIC_BASE_URL || ""}/v1/wallet/webhook`;

    const gw = await santim.directPayment({
      id: txId.toString(),
      amount,
      paymentReason: reason,
      notifyUrl,
      phoneNumber: msisdn,
      paymentMethod: methodForGateway,
    });

    const gwTxnId =
      gw?.TxnId || gw?.txnId || gw?.data?.TxnId || gw?.data?.txnId;
    await Transaction.findByIdAndUpdate(txId, {
      txnId: gwTxnId || undefined,
      metadata: { ...tx.metadata, gatewayResponse: gw },
    });
    logger.info("[topup] Gateway response stored:", { txId, gwTxnId });

    let driver = undefined;
    if (role === "driver") {
      try {
        const d = await Driver.findById(userId).select("name phone").lean();
        driver = { id: String(userId), name: d?.name || "", phone: d?.phone || "" };
      } catch (err) {
        logger.warn("[topup] Driver lookup failed:", err.message);
      }
    }

    return res.status(202).json({
      message: "Topup initiated",
      transactionId: txId.toString(),
      gatewayTxnId: gwTxnId,
      driver,
    });
  } catch (e) {
    logger.error("[topup] Error:", e);
    return res.status(500).json({ message: e.message });
  }
};

/* ---------------------- WEBHOOK ---------------------- */
exports.webhook = async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || body;

    if (process.env.WALLET_WEBHOOK_DEBUG === "1") {
      logger.info("[webhook] received:", data);
    }

    const thirdPartyId = data.thirdPartyId;
    const providerRefId = data.refId;
    const gwTxnId = data.txnId;

    if (!thirdPartyId && !gwTxnId) {
      logger.warn("[webhook] Invalid payload, missing ids:", data);
      return res.status(400).json({ message: "Invalid webhook payload" });
    }

    let tx = null;
    if (thirdPartyId && mongoose.Types.ObjectId.isValid(String(thirdPartyId))) {
      tx = await Transaction.findById(thirdPartyId);
    }
    if (!tx && thirdPartyId) {
      tx = await Transaction.findOne({ refId: String(thirdPartyId) });
    }
    if (!tx && gwTxnId) {
      tx = await Transaction.findOne({ txnId: String(gwTxnId) });
    }

    if (process.env.WALLET_WEBHOOK_DEBUG === "1") {
      logger.info("[webhook] match:", {
        thirdPartyId,
        gwTxnId,
        providerRefId,
        found: !!tx,
        txId: tx ? String(tx._id) : null,
        statusBefore: tx ? tx.status : null,
      });
    }

    if (!tx) {
      logger.warn("[webhook] No transaction found:", { thirdPartyId, gwTxnId });
      return res.status(200).json({
        ok: false,
        message: "Transaction not found for webhook",
        thirdPartyId,
        txnId: gwTxnId,
        providerRefId,
      });
    }

    const hookStatus = (data.Status ?? "PENDING").toString().toUpperCase();
    const previousStatus = tx.status;

    const wasFinal =
      previousStatus === "COMPLETED" || previousStatus === "FAILED";

    tx.status = hookStatus;
    tx.totalAmount = Number(data.totalAmount) || undefined;   
     tx.metadata = {
      ...tx.metadata,
      webhook: data,
      raw: body,
      paymentVia: data.PaymentMethod,
      commissionAmountInPercent: data.commissionAmountInPercent,
      providerCommissionAmountInPercent: data.providerCommissionAmountInPercent,
      vatAmountInPercent: data.vatAmountInPercent || data.VatAmountInPercent,
      reason: data.reason,
    };
    tx.updatedAt = new Date();

    

    await tx.save();

    if (process.env.WALLET_WEBHOOK_DEBUG === "1") {
      logger.info("[webhook] updated tx:", {
        txId: String(tx._id),
        statusAfter: tx.status,
      });
    }

    let driver = undefined;
    let wallet = undefined;

    if (!wasFinal && hookStatus === "COMPLETED") {
      const providerAmount = Number(data.amount) ?? tx.amount;

      if (tx.type === "credit") {
        try {
          if (tx.role === "driver") {
            const d = await Driver.findById(tx.userId).select("name phone").lean();
            driver = { id: String(tx.userId), name: d?.name || "", phone: d?.phone || "" };
          }
        } catch (err) {
          logger.warn("[webhook] Driver lookup failed:", err.message);
        }

        try {
          const commissionDoc = await Commission.findOne({
            //make it only with driverID
            driverID: tx.userId,
            isActive: true,
          }).sort({ createdAt: -1 });
          const commissionRate =
            commissionDoc?.percentage || Number(process.env.COMMISSION_RATE || 15);

          const delta = financeService.calculatePackage(providerAmount, commissionRate);

          wallet = await Wallet.findOneAndUpdate(
            { userId: tx.userId, role: tx.role },
            { $inc: { balance: delta } },
            { upsert: true }
          );
          logger.info("[webhook] Wallet credited:", {
            userId: tx.userId,
            delta,
            newBalance: wallet.balance,
          });
        } catch (err) {
          logger.error("[webhook] Commission/package calc failed:", err);
        }
      } else if (tx.type === "debit") {
        await Wallet.updateOne(
          { userId: tx.userId, role: tx.role },
          { $inc: { balance: -providerAmount } },
          { upsert: true }
        );
        logger.info("[webhook] Wallet debited:", { userId: tx.userId, providerAmount });
      }
    }

    return res.status(200).json({
      ok: true,
      txnId: data.TxnId || data.txnId,
      refId: data.RefId || data.refId,
      thirdPartyId: data.thirdPartyId,
      status: tx.status,
      amount: data.amount || tx.amount,
      currency: data.currency || data.Currency || "ETB",
      msisdn: data.msisdn || tx.msisdn,
      paymentVia: data.PaymentMethod,
      message: data.message || "",
      updatedAt: new Date(),
      balance: wallet ? wallet.balance : undefined,
      driver,
    });
  } catch (e) {
    logger.error("[webhook] Error:", e);
    return res.status(200).json({ ok: false, error: e.message });
  }
};

/* ---------------------- TRANSACTIONS ---------------------- */
exports.transactions = async (req, res) => {
  try {
    const userId = req.params.userId || req.user.id;
    const rows = await Transaction.find({ userId: String(userId) })
      .sort({ createdAt: -1 })
      .lean();

    logger.info("[transactions] Fetched:", rows.length, "records for", userId);
    return res.json(rows);
  } catch (e) {
    logger.error("[transactions] Error:", e);
    return res.status(500).json({ message: e.message });
  }
};

/* ---------------------- WITHDRAW ---------------------- */
exports.withdraw = async (req, res) => {
  try {
    const {
      amount,
      destination,
      method = "santimpay",
      paymentMethod,
      reason = "Wallet Withdrawal",
    } = req.body || {};

    if (!amount || amount <= 0) {
      logger.warn("[withdraw] Invalid amount:", amount);
      return res.status(400).json({ message: "amount must be > 0" });
    }

    const userId = String(req.user.id);
    const role = "driver";
    if (req.user.type !== "driver") {
      logger.warn("[withdraw] Unauthorized attempt by user:", req.user.id);
      return res.status(403).json({ message: "Only drivers can withdraw" });
    }

    const wallet = await Wallet.findOne({ userId, role });
    if (!wallet || wallet.balance < amount) {
      logger.warn("[withdraw] Insufficient balance for user:", userId);
      return res.status(400).json({ message: "Insufficient balance" });
    }

    const tx = await Transaction.create({
      userId,
      role,
      amount,
      type: "debit",
      method,
      status: "PENDING",
      metadata: { destination, reason },
    });
    logger.info("[withdraw] Transaction created:", tx._id.toString());

    // Normalize Ethiopian MSISDN
    const normalizeMsisdnEt = (raw) => {
      if (!raw) return null;
      let s = String(raw).trim();
      s = s.replace(/\s+/g, "").replace(/[-()]/g, "");
      if (/^\+?251/.test(s)) s = s.replace(/^\+?251/, "+251");
      else if (/^0\d+/.test(s)) s = s.replace(/^0/, "+251");
      else if (/^9\d{8}$/.test(s)) s = "+251" + s;
      if (!/^\+2519\d{8}$/.test(s)) return null;
      return s;
    };

    const msisdn = normalizeMsisdnEt(
      destination || req.user.phone || req.user.phoneNumber
    );
    if (!msisdn) {
      logger.warn("[withdraw] Invalid destination phone:", destination);
      return res.status(400).json({ message: "Invalid destination phone" });
    }

    const notifyUrl =
      process.env.SANTIMPAY_WITHDRAW_NOTIFY_URL ||
      `${process.env.PUBLIC_BASE_URL || ""}/v1/wallet/webhook`;

    try {
      const gw = await santim.payoutTransfer({
        id: tx._id.toString(),
        amount,
        paymentReason: reason,
        phoneNumber: msisdn,
        paymentMethod: paymentMethod || "Telebirr",
        notifyUrl,
      });
      const gwTxnId =
        gw?.TxnId || gw?.txnId || gw?.data?.TxnId || gw?.data?.txnId;

      await Transaction.findByIdAndUpdate(tx._id, {
        txnId: gwTxnId,
        metadata: { ...tx.metadata, gatewayResponse: gw },
      });
      logger.info("[withdraw] Payout initiated:", { txId: tx._id, gwTxnId });
    } catch (err) {
      await Transaction.findByIdAndUpdate(tx._id, {
        status: "failed",
        metadata: { ...tx.metadata, gatewayError: err.message },
      });
      logger.error("[withdraw] Payout initiation failed:", err.message);
      return res
        .status(502)
        .json({ message: `Payout initiation failed: ${err.message}` });
    }

    return res.status(202).json({
      message: "Withdrawal initiated",
      transactionId: tx._id.toString(),
    });
  } catch (e) {
    logger.error("[withdraw] Error:", e);
    return res.status(500).json({ message: e.message });
  }
};
