const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth");

router.use("/auth", require("./auth.routes"));
// Public webhooks (no auth) MUST be mounted before authenticate
router.use(
  "/wallet",
  (() => {
    const express = require("express");
    const r = express.Router();
    const ctrl = require("../../controllers/wallet.controller");
    // public webhook only
    r.post("/webhook", ctrl.webhook);
    return r;
  })()
);

// Everything below requires auth
router.use(authenticate);

router.use("/bookings", require("./booking.routes"));
router.use(
  "/assignments",
  authorize("admin", "staff"),
  require("./assignment.routes")
);
router.use("/trips", authorize("admin", "staff"), require("./trip.routes"));
router.use("/live", require("./live.routes"));
router.use("/pricing", authorize("admin"), require("./pricing.routes"));
router.use("/admins", authorize("admin"), require("./admin.routes"));
router.use("/drivers", require("./driver.routes"));
router.use("/mapping", require("./mapping.routes"));
router.use("/passengers", require("./passenger.routes"));
router.use("/analytics", require("./analytics.routes"));
router.use("/wallet", require("./wallet.routes"));

module.exports = router;
