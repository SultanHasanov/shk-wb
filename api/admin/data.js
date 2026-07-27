const { requireAdmin } = require('../_admin-auth');

const RESOURCE_PATHS = { key: 'key', message: 'message' };

module.exports = async function handler(req, res) {
  if (!requireAdmin(req, res)) return;

  const resourcePath = RESOURCE_PATHS[req.query.resource];
  const id = req.query.id;
  if (!resourcePath || (id && !/^[A-Za-z0-9_-]+$/.test(String(id)))) {
    return res.status(400).json({ error: 'Invalid resource' });
  }

  const base = (process.env.MOKKY_API_BASE || 'https://5f517982e1d5a6b7.mokky.dev').replace(/\/$/, '');
  const url = `${base}/${resourcePath}${id ? `/${id}` : ''}`;
  const options = {
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (!['GET', 'HEAD'].includes(req.method) && req.body !== undefined) {
    options.body = JSON.stringify(req.body);
  }

  try {
    const upstream = await fetch(url, options);
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (error) {
    console.error('Mokky request failed:', error);
    return res.status(502).json({ error: 'Upstream request failed' });
  }
};
