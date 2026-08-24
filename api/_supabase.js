function getConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase environment variables are not configured');
  return { url: url.replace(/\/$/, ''), key };
}

async function supabaseFetch(path, options = {}) {
  const { url, key } = getConfig();
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!response.ok) {
    const error = new Error(`Supabase request failed (${response.status})`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function supabaseFetchWithMeta(path, options = {}) {
  const { url, key } = getConfig();
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    Prefer: 'count=exact',
    ...(options.headers || {}),
  };
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!response.ok) {
    const error = new Error(`Supabase request failed (${response.status})`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  const contentRange = response.headers.get('content-range') || '';
  const match = contentRange.match(/\/(\d+|\*)$/);
  return { data, count: match && match[1] !== '*' ? Number(match[1]) : null };
}

function sendApiError(res, error) {
  console.error(error.message, error.details || '');
  return res.status(502).json({ error: 'Database request failed' });
}

module.exports = { sendApiError, supabaseFetch, supabaseFetchWithMeta };
