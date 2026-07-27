const { sendApiError, supabaseFetch } = require('./_supabase');

function publicKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    limit: row.usage_limit,
    used: row.used,
    active: row.active,
  };
}

module.exports = async function handler(req, res) {
  const key = String((req.method === 'GET' ? req.query.key : req.body && req.body.key) || '').trim();
  if (!key || key.length > 100) return res.status(400).json({ error: 'Invalid key' });

  try {
    if (req.method === 'GET') {
      const rows = await supabaseFetch(
        `license_keys?select=id,key,usage_limit,used,active&key=eq.${encodeURIComponent(key)}&limit=1`
      );
      return res.status(200).json(publicKey(rows[0]));
    }
    if (req.method === 'POST') {
      const rows = await supabaseFetch('rpc/consume_license', {
        method: 'POST',
        body: JSON.stringify({ p_key: key }),
      });
      if (!rows.length) return res.status(409).json({ error: 'License cannot be consumed' });
      return res.status(200).json(publicKey(rows[0]));
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return sendApiError(res, error);
  }
};
