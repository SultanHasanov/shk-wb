const { sendApiError, supabaseFetch } = require('./_supabase');

async function currentTotal() {
  const rows = await supabaseFetch('site_stats?select=total_visits&id=eq.1&limit=1');
  return rows.length ? rows[0].total_visits : 0;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.status(200).json({ count: await currentTotal() });
    if (req.method === 'POST') {
      const visitorId = String(req.body && req.body.visitorId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(visitorId)) {
        return res.status(400).json({ error: 'Invalid visitor id' });
      }
      const total = await supabaseFetch('rpc/record_visit', {
        method: 'POST',
        body: JSON.stringify({ p_visitor_id: visitorId }),
      });
      return res.status(200).json({ count: total });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return sendApiError(res, error);
  }
};
