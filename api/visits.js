const { sendApiError, supabaseFetch } = require('../server/_supabase');
const handleMessages = require('../server/_messages-handler');
const { isNetworkError } = require('../server/_fetch-retry');

const STATS_TTL_MS = 30_000;
const STATS_STALE_MS = 5 * 60_000;
let cachedStats = null;
let statsRequest = null;

async function currentTotal() {
  const rows = await supabaseFetch('site_stats?select=total_visits&id=eq.1&limit=1');
  return rows.length ? rows[0].total_visits : 0;
}

async function stickerStats() {
  const age = cachedStats ? Date.now() - cachedStats.at : Infinity;
  if (age < STATS_TTL_MS) return cachedStats.value;
  if (!statsRequest) {
    statsRequest = loadStickerStats()
      .then(value => {
        cachedStats = { value, at: Date.now() };
        return value;
      })
      .catch(error => {
        if (isNetworkError(error) && cachedStats && Date.now() - cachedStats.at < STATS_STALE_MS) {
          console.warn('sticker stats: serving cached counts after network error', error.message);
          return cachedStats.value;
        }
        throw error;
      })
      .finally(() => { statsRequest = null; });
  }
  return statsRequest;
}

async function loadStickerStats() {
  const rows = await supabaseFetch('rpc/get_sticker_generation_stats', {
    method: 'POST',
    body: '{}',
  });
  const stats = Array.isArray(rows) && rows.length ? rows[0] : {};
  return {
    returnStickers: safeCount(stats.return_stickers),
    customStickers: safeCount(stats.custom_stickers),
  };
}

function safeCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

module.exports = async function handler(req, res) {
  try {
    if (req.query && req.query.action === 'messages') return handleMessages(req, res);
    if (req.query && req.query.action === 'stickerStats') {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return res.status(200).json(await stickerStats());
    }
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
