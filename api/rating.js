const RATING_ORIGIN = 'https://point-rating.wb.ru';

function getToken(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return req.headers['x-token'] || '';
}

function getWbSessionCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => (
      part.startsWith('wbx-refresh=') ||
      part.startsWith('wbx-validation-key=')
    ))
    .join('; ');
}

function sendError(res, status, message, details) {
  res.status(status).json({ error: message, details });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Token');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const token = getToken(req);
  const sessionCookies = getWbSessionCookies(req);
  if (!token) {
    sendError(res, 401, 'Сначала войдите в аккаунт WB');
    return;
  }

  const action = String(req.query.action || '');
  let targetUrl;
  let method;
  let body;

  if (action === 'points' && req.method === 'POST') {
    targetUrl = `${RATING_ORIGIN}/external/api/v1/list`;
    method = 'POST';
    body = {
      pickup_point_ids: Array.isArray(req.body?.pickup_point_ids)
        ? req.body.pickup_point_ids
        : [],
      limit: Math.min(Math.max(Number(req.body?.limit) || 11, 1), 200),
      offset: Math.max(Number(req.body?.offset) || 0, 0),
      only_disputable: Boolean(req.body?.only_disputable),
    };
  } else if (action === 'reviews' && req.method === 'GET') {
    const pointId = Number(req.query.point_id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    if (!Number.isSafeInteger(pointId) || pointId <= 0) {
      sendError(res, 400, 'Некорректный ID ПВЗ');
      return;
    }

    const params = new URLSearchParams();
    params.set('pickpoint_id', String(pointId));
    [1, 2, 3, 4, 5].forEach((stars) => {
      params.append('filter.stars', String(stars));
    });
    params.set('filter.limit', String(limit));
    params.set('filter.offset', String(offset));
    params.set('filter.only_disputable', 'false');
    targetUrl = `${RATING_ORIGIN}/external/api/v3/feedbacks/pickpoint?${params}`;
    method = 'GET';
  } else {
    sendError(res, 404, 'Неизвестная операция рейтинга');
    return;
  }

  const upstreamHeaders = {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://my-pvz.wb.ru',
    Referer: 'https://my-pvz.wb.ru/rating',
    Authorization: `Bearer ${token}`,
    'X-Token': token,
    'WB-Access-Token': token,
    'X-Client-Type': 'web',
    'X-Device-Type': 'web',
    'X-App-Type': 'web',
    'X-App-Version': 'v0.0.55',
    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
  };

  if (sessionCookies) upstreamHeaders.Cookie = sessionCookies;
  if (body) upstreamHeaders['Content-Type'] = 'application/json';

  try {
    const response = await fetch(targetUrl, {
      method,
      headers: upstreamHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    const responseText = await response.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      data = {
        error: 'WB вернул ответ не в формате JSON',
        upstreamStatus: response.status,
        upstreamBody: responseText.slice(0, 1000),
      };
    }

    res.status(response.status).json(data);
  } catch (error) {
    sendError(
      res,
      502,
      'Не удалось получить данные рейтинга WB',
      error?.message || String(error),
    );
  }
}
