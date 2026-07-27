const { sendApiError, supabaseFetch } = require('./_supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const rows = await supabaseFetch(
      'announcements?select=id,text,url,button,active,created_at&active=eq.true&order=id.desc'
    );
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    return res.status(200).json(rows.map((row) => ({
      id: row.id,
      text: row.text,
      url: row.url,
      button: row.button,
      active: row.active,
      createdAt: row.created_at,
    })));
  } catch (error) {
    return sendApiError(res, error);
  }
};
