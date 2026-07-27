const { requireAdmin } = require('../_admin-auth');
const { sendApiError, supabaseFetch } = require('../_supabase');

const MOKKY_BASE = 'https://5f517982e1d5a6b7.mokky.dev';

async function mokky(resource) {
  const response = await fetch(`${MOKKY_BASE}/${resource}`);
  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Mokky ${resource} failed (${response.status})`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function upsert(table, rows, conflict) {
  if (!rows.length) return 0;
  await supabaseFetch(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  return rows.length;
}

module.exports = async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const [keys, messages, trials, items] = await Promise.all([
      mokky('key'), mokky('message'), mokky('trials'), mokky('items'),
    ]);
    const result = {};
    result.license_keys = await upsert('license_keys', keys.map((row) => ({
      id: row.id, key: row.key, usage_limit: row.limit, used: row.used || 0,
      active: row.active !== false, note: row.note || '',
      created_at: row.createdAt || new Date().toISOString(),
    })), 'key');
    result.announcements = await upsert('announcements', messages.map((row) => ({
      id: row.id, text: row.text, url: row.url || '', button: row.button || '',
      active: row.active !== false,
      created_at: row.createdAt || new Date().toISOString(),
    })), 'id');
    result.trial_claims = await upsert('trial_claims', trials.filter((row) => row.hwid).map((row) => ({
      hwid: row.hwid, claimed_at: row.claimedAt || new Date().toISOString(),
    })), 'hwid');

    const total = items.find((row) => row.id === 1);
    if (total && Number.isFinite(Number(total.count))) {
      await supabaseFetch('site_stats?id=eq.1', {
        method: 'PATCH',
        body: JSON.stringify({ total_visits: Number(total.count) }),
      });
    }
    result.site_visitors = await upsert('site_visitors', items.filter((row) => row.visitorId).map((row) => ({
      visitor_id: row.visitorId, visit_count: row.count || 1,
      first_visit: row.firstVisit || new Date().toISOString(),
      last_visit: row.lastVisit || row.firstVisit || new Date().toISOString(),
    })), 'visitor_id');
    result.total_visits = total ? Number(total.count) || 0 : 0;
    return res.status(200).json({ migrated: result });
  } catch (error) {
    return sendApiError(res, error);
  }
};
