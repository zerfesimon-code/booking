const jwt = require('jsonwebtoken');
require('dotenv').config();

function generateUserInfoToken(user, type, roles = [], permissions = []) {
  const payload = {
    id: user.id || user._id || user._doc?._id,
    type,
    roles,
    permissions
  };
  const secret = process.env.JWT_SECRET || 'secret';
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign(payload, secret, { expiresIn });
}

module.exports = { generateUserInfoToken };

