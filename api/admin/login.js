const { createSessionCookie, getRequiredEnv, safeEqual } = require('../_admin-auth');

module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let configuredPassword;
  try {
    configuredPassword = getRequiredEnv('ADMIN_PASSWORD');
    getRequiredEnv('ADMIN_SESSION_SECRET');
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({ error: 'Server is not configured' });
  }

  const password = req.body && req.body.password;
  if (typeof password !== 'string' || !safeEqual(password, configuredPassword)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.setHeader('Set-Cookie', createSessionCookie());
  return res.status(204).end();
};
