const { sendApiError } = require('../server/_supabase');
const { enforceRateLimit } = require('../server/_rate-limit');
const { enforceProgramVersion } = require('../server/_program-version');
const { requireUser } = require('../server/_user-auth');
const { publicOrigin } = require('../server/_origin');
const { publicPlans } = require('../server/_app-plans');
const account = require('../server/_app-account');
const { appFreeMode } = require('../server/_app-free');
const appUpdate = require('../server/_app-update');

// API программы «Помощник ПВЗ» (/api/app/*, rewrites в vercel.json).
// Отдельный файл не заводим: на Vercel 12 функций — это лимит тарифа, поэтому
// бывшая заглушка api/trial.js стала этим обработчиком, а /api/trial ведёт сюда.

// Пробного периода у «Подбора кодов» больше нет. Старые сборки ещё спрашивают
// этот адрес — всем отвечаем «уже использован», бесплатный подбор не даём.
async function legacyTrial(req, res) {
  if (!await enforceRateLimit(req, res, { scope: 'trial', limit: 10, windowSeconds: 3600 })) return;
  if (!enforceProgramVersion(req, res)) return;
  const hwid = String((req.method === 'GET' ? req.query.hwid : req.body && req.body.hwid) || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(hwid)) return res.status(400).json({ error: 'Invalid hardware id' });
  if (req.method === 'GET') return res.status(200).json({ used: true });
  if (req.method === 'POST') return res.status(200).json({ claimed: false });
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

function sendError(res, error) {
  if (error.code && error.status) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.extra || {}) });
  return sendApiError(res, error);
}

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

// Сессия + регистрация ПК. При лимите ПК токены всё равно отдаём: из программы
// можно сразу отключить лишний компьютер и повторить регистрацию.
async function finishLogin(res, session, userId, deviceHash, deviceName, version) {
  const tokens = account.sessionPayload(session);
  try {
    await account.registerDevice(userId, deviceHash, deviceName, version);
  } catch (error) {
    if (error.code === 'DEVICE_LIMIT') return res.status(409).json({ error: error.message, code: error.code, ...error.extra, session: tokens });
    throw error;
  }
  return res.status(200).json({ session: tokens });
}

const SITE_LINK_TARGETS = /^\/cabinet(\/[a-z-]+)?(\?[a-z0-9=&_-]{0,80})?$/i;

module.exports = async function handler(req, res) {
  const action = String(req.query?.action || '');
  try {
    if (action === 'trial') return await legacyTrial(req, res);

    if (action === 'plans' && req.method === 'GET') {
      // Короткий кэш: freeMode переключается из админки и должен доехать быстро.
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.status(200).json({ ...publicPlans(), freeMode: await appFreeMode() });
    }

    // Подтверждение входа со страницы сайта — без заголовка версии программы.
    if (action === 'login-request' && req.method === 'GET') {
      const code = account.normalizeLoginCode(req.query.code);
      if (!code) return res.status(400).json({ error: 'Некорректный код', code: 'VALIDATION_ERROR' });
      const row = await account.loginRequest(code);
      return res.status(200).json({ deviceName: row.device_name, status: row.status });
    }
    if (action === 'login-approve' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-login-approve', limit: 20, windowSeconds: 600 })) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const code = account.normalizeLoginCode(body(req).code);
      if (!code) return res.status(400).json({ error: 'Некорректный код', code: 'VALIDATION_ERROR' });
      return res.status(200).json(await account.approveBrowserLogin(user.id, code));
    }
    if (action === 'me' && req.method === 'GET' && !req.headers['x-device-id']) {
      // Кабинет на сайте: та же сводка, без привязки к ПК.
      const user = await requireUser(req, res);
      if (!user) return;
      return res.status(200).json(await account.accountSummary(user, null));
    }
    if (action === 'device' && req.method === 'DELETE') {
      const user = await requireUser(req, res);
      if (!user) return;
      await account.revokeDevice(user.id, req.query.id);
      return res.status(204).end();
    }

    // Обновление и аренда — ДО проверки версии: устаревшая программа должна узнать,
    // куда обновляться, и получить аренду (в ней же флаг обязательного обновления).
    if (action === 'update' && req.method === 'GET') return appUpdate.updateResponse(req, res, publicOrigin(req));
    if (action === 'update-download' && req.method === 'GET') return appUpdate.downloadResponse(res);
    if (action === 'lease' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-lease', limit: 120, windowSeconds: 3600 })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      return appUpdate.leaseResponse(req, res, deviceHash);
    }

    // Дальше — только программа.
    if (!enforceProgramVersion(req, res)) return;
    const version = String(req.headers['x-app-version'] || '');

    if (action === 'login' && req.method === 'POST') {
      const { email, password, deviceName } = body(req);
      const login = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login) || !password) return res.status(400).json({ error: 'Введите почту и пароль', code: 'VALIDATION_ERROR' });
      if (!await enforceRateLimit(req, res, { scope: 'app-login', limit: 10, windowSeconds: 600 })) return;
      if (!await enforceRateLimit(req, res, { scope: 'app-login-email', limit: 10, windowSeconds: 600, key: login })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      const session = await account.passwordLogin(login, String(password));
      return await finishLogin(res, session, session.user.id, deviceHash, deviceName, version);
    }
    if (action === 'login-start' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-login-start', limit: 10, windowSeconds: 600 })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      const { code, secret } = await account.startBrowserLogin(deviceHash, body(req).deviceName, version);
      return res.status(201).json({ code, secret, url: `${publicOrigin(req)}/app-login?code=${code}`, expiresIn: 600 });
    }
    if (action === 'login-poll' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-login-poll', limit: 200, windowSeconds: 600 })) return;
      const code = account.normalizeLoginCode(body(req).code);
      if (!code || !body(req).secret) return res.status(400).json({ error: 'Некорректный запрос', code: 'VALIDATION_ERROR' });
      const result = await account.pollBrowserLogin(code, String(body(req).secret));
      if (result.status === 'pending') return res.status(202).json({ status: 'pending' });
      return await finishLogin(res, result.session, result.userId, result.deviceHash, result.deviceName, result.appVersion);
    }
    if (action === 'refresh' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-refresh', limit: 60, windowSeconds: 600 })) return;
      const token = String(body(req).refreshToken || '');
      if (!token) return res.status(400).json({ error: 'Нет сессии', code: 'VALIDATION_ERROR' });
      const session = await account.refreshSession(token);
      req.headers.authorization = `Bearer ${session.access_token}`;
      await account.requireDevice(req, session.user.id);
      return res.status(200).json({ session: account.sessionPayload(session) });
    }

    const user = await requireUser(req, res);
    if (!user) return;

    if (action === 'register-device' && req.method === 'POST') {
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      await account.registerDevice(user.id, deviceHash, body(req).deviceName, version);
      return res.status(200).json({ ok: true });
    }

    const device = await account.requireDevice(req, user.id);

    if (action === 'me' && req.method === 'GET') {
      return res.status(200).json(await account.accountSummary(user, account.deviceHashFrom(req)));
    }
    if (action === 'consume' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-consume', limit: 30, windowSeconds: 60, key: user.id })) return;
      const meta = body(req).meta && typeof body(req).meta === 'object' ? body(req).meta : {};
      const safeMeta = { cell: String(meta.cell || '').slice(0, 16) || undefined, via: String(meta.via || '').slice(0, 16) || undefined };
      const result = await account.consumeCode(user.id, device.id, safeMeta);
      return res.status(200).json({ ...result, account: await account.accountSummary(user, account.deviceHashFrom(req)) });
    }
    if (action === 'usage' && req.method === 'GET') {
      return res.status(200).json({ items: await account.usageHistory(user.id, req.query.limit) });
    }
    if (action === 'claim-key' && req.method === 'POST') {
      const key = await account.claimKey(user.id, body(req).key);
      return res.status(200).json({ key });
    }
    if (action === 'site-link' && req.method === 'POST') {
      const next = String(body(req).next || '/cabinet/subscription');
      if (!SITE_LINK_TARGETS.test(next)) return res.status(400).json({ error: 'Некорректная страница', code: 'VALIDATION_ERROR' });
      const tokenHash = await account.magicTokenHash(user.id);
      return res.status(200).json({ url: `${publicOrigin(req)}/app-login?th=${encodeURIComponent(tokenHash)}&next=${encodeURIComponent(next)}` });
    }
    if (action === 'logout' && req.method === 'POST') {
      await account.revokeDevice(user.id, device.id).catch(() => {});
      await account.logout(user._accessToken);
      return res.status(204).end();
    }

    return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  } catch (error) {
    return sendError(res, error);
  }
};
