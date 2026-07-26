const ALLOWED_PATHS = new Set(['/auth', '/code/wb-captcha']);

function getValidationCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const validationCookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('wbx-validation-key='));

  if (validationCookie) return validationCookie;

  // Allows a trusted client to pass only the WB validation value without
  // forwarding all cookies belonging to the proxy domain.
  const validationKey = req.headers['x-wbx-validation-key'];
  return validationKey ? `wbx-validation-key=${validationKey}` : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Pow, Authorization, deviceId, wb-appversion, X-Language, X-Wbx-Validation-Key',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Pow, X-Correlation-Id');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const rawPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
  const targetPath = rawPath || '/auth';

  if (!ALLOWED_PATHS.has(targetPath)) {
    res.status(400).json({ error: 'Unsupported proxy path' });
    return;
  }

  const targetUrl = `https://auth-my-pvz.wb.ru/v2${targetPath}`;
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: 'https://my-pvz.wb.ru',
    Referer: 'https://my-pvz.wb.ru/',
    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
    'X-Language': req.headers['x-language'] || 'ru',
  };

  if (req.headers['x-pow']) headers['X-Pow'] = req.headers['x-pow'];
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers.deviceid) headers.Deviceid = req.headers.deviceid;
  if (req.headers['wb-appversion']) {
    headers['Wb-Appversion'] = req.headers['wb-appversion'];
  }

  const validationCookie = getValidationCookie(req);
  if (validationCookie) headers.Cookie = validationCookie;

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(15000),
    });

    const responsePow = response.headers.get('x-pow');
    const correlationId = response.headers.get('x-correlation-id');
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();

    if (responsePow) res.setHeader('X-Pow', responsePow);
    if (correlationId) res.setHeader('X-Correlation-Id', correlationId);

    let data;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      data = {
        error: 'Wildberries returned a non-JSON response',
        message: `Wildberries returned HTTP ${response.status} instead of JSON`,
        upstreamStatus: response.status,
        upstreamContentType: contentType,
        // Keep the response useful for diagnostics without returning a full
        // anti-bot or nginx HTML page to the browser.
        upstreamBody: responseText.slice(0, 1000),
      };
    }

    console.log('[proxy] <-', {
      path: targetPath,
      status: response.status,
      contentType,
      correlationId,
      hasPowChallenge: Boolean(responsePow),
      hasValidationCookie: Boolean(validationCookie),
    });

    res.status(response.status).json(data);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    console.error('[proxy] request failed', {
      path: targetPath,
      name: error?.name,
      message: error?.message,
    });
    res.status(502).json({
      error: timedOut
        ? 'Wildberries authentication service timed out'
        : 'Unable to reach Wildberries authentication service',
      details: error?.message || String(error),
    });
  }
}
