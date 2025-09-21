const { Pricing } = require('../models/pricing');
const { crudController } = require('./basic.crud');
const { broadcast } = require('../sockets');

const base = crudController(Pricing);

async function updateAndBroadcast(req, res) {
  try {
    const item = await Pricing.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return res.status(404).json({ message: 'Not found' });
    broadcast('pricing:update', item);
    return res.json(item);
  } catch (e) { return res.status(500).json({ message: e.message }); }
}

module.exports = { ...base, updateAndBroadcast };

