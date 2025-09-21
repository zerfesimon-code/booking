const express = require('express');
const router = express.Router();
const ctrl = require('../../modules/mapping/controllers/mappingController');
const { authenticate, authorize } = require('../../middleware/auth');

router.post('/route', authenticate, authorize('admin','staff','passenger','driver'), ctrl.route);
router.post('/eta', authenticate, authorize('admin','staff','passenger','driver'), ctrl.eta);
router.get('/booking/:id/progress', authenticate, authorize('admin','staff','passenger'), ctrl.bookingProgress);

module.exports = router;

