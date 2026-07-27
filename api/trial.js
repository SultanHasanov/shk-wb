const { sendApiError, supabaseFetch } = require('./_supabase');

module.exports = async function handler(req, res) {
  const hwid = String((req.method === 'GET' ? req.query.hwid : req.body && req.body.hwid) || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(hwid)) return res.status(400).json({ error: 'Invalid hardware id' });

  try {
    if (req.method === 'GET') {
      const rows = await supabaseFetch(
        `trial_claims?select=hwid&hwid=eq.${encodeURIComponent(hwid)}&limit=1`
      );
      return res.status(200).json({ used: rows.length > 0 });
    }
    if (req.method === 'POST') {
      const claimed = await supabaseFetch('rpc/claim_trial', {
        method: 'POST',
        body: JSON.stringify({ p_hwid: hwid }),
      });
      return res.status(200).json({ claimed: claimed === true });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return sendApiError(res, error);
  }
};
