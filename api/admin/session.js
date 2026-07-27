const { isAuthenticated } = require('../_admin-auth');

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return res.status(isAuthenticated(req) ? 204 : 401).end();
};
