const express = require("express");
const router = express.Router();
const ctrl = require("../../modules/wallet/controllers/walletController");
const driverWallet = require("../../modules/driver/controllers/driverWalletController");
const { authenticate, authorize } = require("../../middleware/auth");

router.post("/topup", authenticate, ctrl.topup);
router.get("/transactions", authenticate, ctrl.transactions);
router.get("/transactions/:userId", authenticate, ctrl.transactions);
router.post("/withdraw", authenticate, authorize("driver"), ctrl.withdraw);

// Driver wallet admin endpoints under /wallet to align with deliverables
router.get(
  "/admin/wallets",
  authenticate,
  authorize("admin", "superadmin"),
  driverWallet.adminListWallets
);
router.get(
  "/admin/wallets/:driverId",
  authenticate,
  authorize("admin", "superadmin"),
  driverWallet.adminGetDriverWallet
);

module.exports = router;
