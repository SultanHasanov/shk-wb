const { requireAdmin } = require('../_admin-auth');
const { sendApiError, supabaseFetch } = require('../_supabase');

const RESOURCES = {
  key: {
    table: 'license_keys',
    toDb(body) {
      const out = {};
      if ('key' in body) out.key = body.key;
      if ('limit' in body) out.usage_limit = body.limit;
      if ('used' in body) out.used = body.used;
      if ('active' in body) out.active = body.active;
      if ('note' in body) out.note = body.note;
      if ('createdAt' in body) out.created_at = body.createdAt;
      return out;
    },
    fromDb(row) {
      return {
        id: row.id, key: row.key, limit: row.usage_limit, used: row.used,
        active: row.active, note: row.note, createdAt: row.created_at,
      };
    },
  },
  message: {
    table: 'announcements',
    toDb(body) {
      const out = {};
      for (const field of ['text', 'url', 'button', 'active']) {
        if (field in body) out[field] = body[field];
      }
      if ('createdAt' in body) out.created_at = body.createdAt;
      return out;
    },
    fromDb(row) {
      return {
        id: row.id, text: row.text, url: row.url, button: row.button,
        active: row.active, createdAt: row.created_at,
      };
    },
  },
};

module.exports = async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  const config = RESOURCES[req.query.resource];
  const id = req.query.id;
  if (!config || (id && !/^\d+$/.test(String(id)))) {
    return res.status(400).json({ error: 'Invalid resource' });
  }

  try {
    if (req.method === 'GET') {
      const rows = await supabaseFetch(`${config.table}?select=*&order=id.desc`);
      return res.status(200).json(rows.map(config.fromDb));
    }
    if (req.method === 'POST') {
      const rows = await supabaseFetch(config.table, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(config.toDb(req.body || {})),
      });
      return res.status(201).json(config.fromDb(rows[0]));
    }
    if (req.method === 'PATCH' && id) {
      const rows = await supabaseFetch(`${config.table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(config.toDb(req.body || {})),
      });
      return res.status(200).json(config.fromDb(rows[0]));
    }
    if (req.method === 'DELETE' && id) {
      await supabaseFetch(`${config.table}?id=eq.${id}`, { method: 'DELETE' });
      return res.status(204).end();
    }
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return sendApiError(res, error);
  }
};
