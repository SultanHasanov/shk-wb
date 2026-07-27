const { requireAdmin } = require('../_admin-auth');
const { sendApiError, supabaseFetch } = require('../_supabase');

module.exports = async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const [siteRows, appRows, dailyRows] = await Promise.all([
      supabaseFetch('site_stats?select=total_visits&id=eq.1&limit=1'),
      supabaseFetch('app_stats?select=total_launches&id=eq.1&limit=1'),
      supabaseFetch('daily_analytics?select=day,event_type,event_count&order=day.desc&limit=730'),
    ]);
    const byDay = {};
    for (const row of dailyRows) {
      if (!byDay[row.day]) byDay[row.day] = { day: row.day, siteVisits: 0, appLaunches: 0 };
      if (row.event_type === 'site_visit') byDay[row.day].siteVisits = Number(row.event_count);
      if (row.event_type === 'app_launch') byDay[row.day].appLaunches = Number(row.event_count);
    }
    return res.status(200).json({
      totals: {
        siteVisits: Number(siteRows[0] && siteRows[0].total_visits || 0),
        appLaunches: Number(appRows[0] && appRows[0].total_launches || 0),
      },
      days: Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day)),
    });
  } catch (error) {
    return sendApiError(res, error);
  }
};
