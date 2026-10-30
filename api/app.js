const { sendApiError } = require('../server/_supabase');
const { enforceRateLimit } = require('../server/_rate-limit');
const { enforceProgramVersion } = require('../server/_program-version');
const { requireUser, optionalUser } = require('../server/_user-auth');
const { publicOrigin } = require('../server/_origin');
const { publicPlans } = require('../server/_app-plans');
const account = require('../server/_app-account');
const QRCode = require('qrcode');
const sync = require('../server/_app-sync');
const relay = require('../server/_app-relay');
const { appFreeMode } = require('../server/_app-free');
const { crackFallbackEnabled } = require('../server/_app-flags');
const { buildClientQr } = require('../server/_wb-code');
const { crackClientQr } = require('../server/_wb-crack');
const wallet = require('../server/_wallet');
const appUpdate = require('../server/_app-update');
const payments = require('./payments');
const permissions = require('../server/_app-permissions');
const { generationPrices } = require('../server/_generation-billing');
const { CELL_PRINT_PRICES } = require('../server/_payments');
const cabinet = require('./cabinet');

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
  if (error.code === 'SYNC_NOT_CONFIGURED') return res.status(503).json({ error: error.publicMessage, code: error.code });
  if (error.code && error.status) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.extra || {}) });
  return sendApiError(res, error);
}

// Действие закрыто владельцем на этом ПК (кабинет → «Доступ сотрудников») — 403 DENIED_BY_OWNER.
// Для эндпоинтов до requireUser: без входа (ключ WBPK) ограничений нет — их ставит аккаунт.
async function ownerAllows(req, key) {
  if (!req.headers['x-device-id']) return;
  const user = await optionalUser(req).catch(() => null);
  if (!user) return;
  await account.requireAllowed(req, user.id, key).catch(error => {
    if (error.code === 'DENIED_BY_OWNER') throw error;
  });
}

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function codeFromQrText(qrText) {
  const value = String(qrText || '').split('_')[1];
  return /^\d{5}$/.test(value) ? Number(value) : null;
}

async function clientQrImage(qrText) {
  if (!/^\d{1,12}_\d{5}_\d{6}_\d$/.test(String(qrText || ''))) throw account.appError(400, 'VALIDATION_ERROR', 'Некорректный QR-код');
  return QRCode.toDataURL(qrText, { width: 240, margin: 1 });
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
      const program = String(row.app_version || '').startsWith('cell-print') ? 'Печать ячеек' : 'Помощник ПВЗ';
      return res.status(200).json({ deviceName: row.device_name, status: row.status, program });
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
    if (action === 'point' && req.method === 'DELETE' && !req.headers['x-device-id']) {
      // кабинет на сайте: отключить пункт (облачные данные пункта сохраняются)
      const user = await requireUser(req, res);
      if (!user) return;
      await sync.revokePoint(user.id, req.query.id);
      return res.status(204).end();
    }
    if (action === 'device' && req.method === 'DELETE') {
      const user = await requireUser(req, res);
      if (!user) return;
      await account.requireAllowed(req, user.id, 'act.account');
      await account.revokeDevice(user.id, req.query.id);
      return res.status(204).end();
    }
    if (action === 'device' && req.method === 'PATCH') {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!await enforceRateLimit(req, res, { scope: 'app-device-rename', limit: 30, windowSeconds: 600, key: user.id })) return;
      const b = body(req);
      // кабинет: что закрыто на этом ПК (только с сайта — программа себе доступ не меняет)
      if (Array.isArray(b.denied)) {
        if (req.headers['x-device-id']) return res.status(403).json({ error: 'Доступ меняется только в кабинете на сайте', code: 'DENIED_BY_OWNER' });
        return res.status(200).json(await account.setDeviceAccess(user.id, req.query.id, b.denied));
      }
      return res.status(200).json(await account.renameDevice(user.id, req.query.id, b.name));
    }

    // Обновление и аренда — ДО проверки версии: устаревшая программа должна узнать,
    // куда обновляться, и получить аренду (в ней же флаг обязательного обновления).
    if (action === 'update' && req.method === 'GET') return appUpdate.updateResponse(req, res, publicOrigin(req));
    if (action === 'update-download' && req.method === 'GET') return appUpdate.downloadResponse(res);
    if (action === 'lease' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-lease', limit: 120, windowSeconds: 3600 })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      // Права считаем, только если ключ аренды настроен (иначе ответ всё равно 503).
      // Сбой базы не должен ронять аренду: rights=null — «неизвестно», программа держит прошлые права.
      const rights = process.env.PVZ_LEASE_PRIVATE_KEY ? await account.leaseRights(req).catch(() => null) : null;
      return appUpdate.leaseResponse(req, res, deviceHash, rights);
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
    // Регистрация из программы: письмо → человек жмёт ссылку → программа входит сама.
    if (action === 'signup' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-signup', limit: 5, windowSeconds: 3600 })) return;
      const b = body(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (email && !await enforceRateLimit(req, res, { scope: 'app-signup-email', limit: 3, windowSeconds: 3600, key: email })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      const result = await account.startSignup({ email, password: b.password, deviceHash, deviceName: b.deviceName, version, origin: publicOrigin(req) });
      if (result.session) return await finishLogin(res, result.session, result.userId, deviceHash, b.deviceName, version);
      return res.status(201).json({ status: 'pending', id: result.id, secret: result.secret, email: result.email });
    }
    if (action === 'signup-poll' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-signup-poll', limit: 300, windowSeconds: 3600 })) return;
      const b = body(req);
      const result = await account.pollSignup(String(b.id || ''), String(b.secret || ''));
      if (result.status === 'pending') return res.status(202).json({ status: 'pending' });
      return await finishLogin(res, result.session, result.userId, result.deviceHash, result.deviceName, result.appVersion);
    }
    if (action === 'signup-resend' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-signup-resend', limit: 5, windowSeconds: 3600 })) return;
      const b = body(req);
      return res.status(200).json(await account.resendSignup(String(b.id || ''), String(b.secret || ''), publicOrigin(req)));
    }
    if (action === 'password-reset' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-password-reset', limit: 5, windowSeconds: 3600 })) return;
      const email = String(body(req).email || '').trim().toLowerCase();
      if (email && !await enforceRateLimit(req, res, { scope: 'app-password-reset-email', limit: 3, windowSeconds: 3600, key: email })) return;
      return res.status(200).json(await account.sendPasswordReset(email, publicOrigin(req)));
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

    // --- Код клиента: формула и подбор живут только на сервере (server/_wb-code.js,
    // server/_wb-crack.js). Биллинг — аккаунтом (Bearer) или WBPK-ключом из тела, поэтому
    // эндпоинты до requireUser: «Базовый» без входа тоже должен получать коды.
    if (action === 'qr-image' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-qr-image', limit: 120, windowSeconds: 60 })) return;
      return res.status(200).json({ qrImage: await clientQrImage(body(req).qrText) });
    }
    if (action === 'client-qr' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-client-qr', limit: 60, windowSeconds: 60 })) return;
      await ownerAllows(req, 'act.client_qr');
      const b = body(req);
      const sid = String(b.sid || '').replace(/\D/g, '');
      if (!sid) return res.status(400).json({ error: 'Нет SID клиента', code: 'VALIDATION_ERROR' });
      const meta = { cell: String(b.cell || '').slice(0, 16) || undefined, via: 'client-qr' };
      if (b.requestId) {
        const qr = buildClientQr(sid);
        const result = await account.billClientCode(req, { key: b.key, meta, requestId: b.requestId, sid, qrText: qr.qrText });
        return res.status(200).json({ code: codeFromQrText(result.qrText), qrText: result.qrText, qrImage: await clientQrImage(result.qrText), billing: result.billing, replayed: result.replayed });
      }
      const billing = await account.billCode(req, { key: b.key, meta });
      const { code, qrText } = buildClientQr(sid);
      return res.status(200).json({ code, qrText, qrImage: await clientQrImage(qrText), billing });
    }
    if (action === 'crack-code' && req.method === 'POST') {
      if (!await crackFallbackEnabled()) return res.status(403).json({ error: 'Резервный подбор отключён', code: 'CRACK_DISABLED' });
      if (!await enforceRateLimit(req, res, { scope: 'app-crack-code', limit: 5, windowSeconds: 60 })) return;
      await ownerAllows(req, 'act.client_qr');
      const b = body(req);
      const sid = String(b.sid || '').replace(/\D/g, '');
      if (!sid) return res.status(400).json({ error: 'Нет SID клиента', code: 'VALIDATION_ERROR' });
      await account.authorizeCodeAttempt(req, b.key);
      const hashes = Array.isArray(b.hashes) ? b.hashes.slice(0, 50) : [];
      const found = crackClientQr(sid, hashes);
      if (!found) return res.status(404).json({ error: 'Код не найден по хешам', code: 'CODE_NOT_FOUND' });
      const meta = { cell: String(b.cell || '').slice(0, 16) || undefined, via: 'crack' };
      if (b.requestId) {
        const result = await account.billClientCode(req, { key: b.key, meta, requestId: b.requestId, sid, qrText: found.qrText });
        return res.status(200).json({ code: codeFromQrText(result.qrText), qrText: result.qrText, qrImage: await clientQrImage(result.qrText), billing: result.billing, replayed: result.replayed });
      }
      const billing = await account.billCode(req, { key: b.key, meta });
      return res.status(200).json({ code: found.code, qrText: found.qrText, qrImage: await clientQrImage(found.qrText), billing });
    }

    const user = await requireUser(req, res);
    if (!user) return;

    if (action === 'register-device' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-register-device', limit: 30, windowSeconds: 600, key: user.id })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      await account.registerDevice(user.id, deviceHash, body(req).deviceName, version);
      return res.status(200).json({ ok: true });
    }

    // Оплата из программы по QR-коду СБП: тот же заказ, что на сайте (api/payments.js),
    // только ЮKassa отдаёт ссылку для QR вместо страницы оплаты. До проверки ПК: из окна
    // «лимит компьютеров» докупают компьютер, пока этот ещё не подключён.
    if (action === 'pay' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-pay', limit: 20, windowSeconds: 600, key: user.id })) return;
      // ПК ещё не подключён (окно «лимит компьютеров») — ограничений по нему нет
      await account.requireAllowed(req, user.id, 'act.pay').catch(error => {
        if (error.code === 'DENIED_BY_OWNER') throw error;
      });
      const b = body(req);
      const product =
        b.kind === 'addon' ? { productKind: 'app_addon', appAddon: String(b.addon || ''), appAddonMonths: Number(b.months || 0) }
        : b.kind === 'wallet' ? { productKind: 'wallet_topup', walletAmount: Number(b.amount || 0) }
        : b.kind === 'cell_print' ? {
          productKind: 'cell_print_license',
          durationDays: Number(b.days || 0),
          deviceLimit: Number(b.devices || 0),
          marketplaceScope: String(b.scope || 'wb'),
          ...(b.renewalTargetKey ? { renewalTargetKey: String(b.renewalTargetKey) } : {}),
        }
        : { productKind: 'app_subscription', appPlan: String(b.plan || ''), appTermMonths: Number(b.months || 0) };
      req.query.action = 'create';
      req.body = {
        ...product,
        accepted: b.accepted === true,
        paymentMethod: 'sbp_qr',
        returnTo: 'cabinet',
      };
      return payments(req, res);
    }
    if (action === 'pay-status' && req.method === 'GET') {
      req.query.action = 'status';
      return payments(req, res);
    }
    const device = await account.requireDevice(req, user.id);

    // --- загрузка данных пункта с другого ПК (server/_app-relay.js) — свой потолок частоты:
    // ПК держит inbox постоянно, а большая загрузка идёт сотней кусков ---
    if (action.startsWith('relay-')) {
      if (!await enforceRateLimit(req, res, { scope: 'app-relay', limit: 3000, windowSeconds: 600, key: user.id })) return;
      // inbox — этот ПК отдаёт свои данные другим; закрыта только загрузка к себе
      if (['relay-ask', 'relay-get', 'relay-ack'].includes(action) && permissions.isDenied(device, 'act.load_pc')) {
        return res.status(403).json({ error: 'Владелец закрыл загрузку с другого ПК на этом компьютере', code: 'DENIED_BY_OWNER', key: 'act.load_pc' });
      }
      if (action === 'relay-inbox' && req.method === 'POST') return res.status(200).json(await relay.inbox(user.id, device, body(req)));
      if (action === 'relay-peers' && req.method === 'GET') return res.status(200).json(relay.peers(user.id, device));
      if (action === 'relay-ask' && req.method === 'POST') return res.status(200).json(await relay.ask(user.id, device, body(req)));
      if (action === 'relay-put' && req.method === 'POST') return res.status(200).json(relay.put(user.id, device, req.query, req.body));
      if (action === 'relay-ack' && req.method === 'POST') return res.status(200).json(relay.ack(user.id, device, req.query));
      if (action === 'relay-get' && req.method === 'GET') {
        const out = await relay.get(user.id, device, req.query);
        if (!out.bytes) return res.status(200).json(out);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Relay-Last', out.last ? '1' : '0');
        return res.status(200).end(out.bytes);
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Общий потолок на всё остальное с одного аккаунта (синхронизация ходит пачками).
    if (!await enforceRateLimit(req, res, { scope: 'app-user', limit: 900, windowSeconds: 600, key: user.id })) return;

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
    // Полные данные аккаунта с сайта: баланс, покупки, активы (ключи WBPK + лицензии печати
    // ячеек с устройствами), рефералы. Делегируем серверным функциям кабинета.
    if (action === 'wallet' && req.method === 'GET') {
      // цены генерации — для раздела «Стикеры» программы (не дублировать их там)
      const [summary, prices] = await Promise.all([
        wallet.walletSummary(user.id, req.query.limit),
        generationPrices(user.id).catch(() => null),
      ]);
      return res.status(200).json({ ...summary, ...(prices ? { stickerPrices: prices } : {}) });
    }
    if (action === 'cell-print-prices' && req.method === 'GET') {
      // цены лицензии «Печати ячеек» для окна оплаты в программе: {дней: {ПК: ₽}}
      return res.status(200).json({ prices: CELL_PRINT_PRICES });
    }
    if (action === 'orders' && req.method === 'GET') {
      return res.status(200).json({ items: await cabinet.getOrders(user.id, 25) });
    }
    if (action === 'assets' && req.method === 'GET') {
      return res.status(200).json({ items: await cabinet.getAssets(user.id) });
    }
    if (action === 'referrals' && req.method === 'GET') {
      return res.status(200).json(await cabinet.getReferral(user.id));
    }
    if (action === 'claim-key' && req.method === 'POST') {
      // от перебора ключей: попыток мало, ключ из 12 hex-символов
      if (!await enforceRateLimit(req, res, { scope: 'app-claim-key', limit: 10, windowSeconds: 600, key: user.id })) return;
      return res.status(200).json(await account.claimKey(user.id, body(req).key));
    }
    if (action === 'password-change' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-password-change', limit: 5, windowSeconds: 600, key: user.id })) return;
      if (permissions.isDenied(device, 'act.account')) throw account.appError(403, 'DENIED_BY_OWNER', 'Владелец закрыл управление аккаунтом на этом компьютере', { key: 'act.account' });
      const b = body(req);
      return res.status(200).json(await account.changePassword(user, b.current, b.password));
    }
    if (action === 'logout-others' && req.method === 'POST') {
      if (permissions.isDenied(device, 'act.account')) throw account.appError(403, 'DENIED_BY_OWNER', 'Владелец закрыл управление аккаунтом на этом компьютере', { key: 'act.account' });
      return res.status(200).json(await account.logoutOthers(user, device.id));
    }
    if (action === 'security-log' && req.method === 'GET') {
      return res.status(200).json({ items: await sync.secretAccessLog(user.id, req.query.limit) });
    }

    // --- пункты и облако ---
    if (action === 'points' && req.method === 'GET') {
      return res.status(200).json({ points: await sync.listPoints(user.id) });
    }
    if (action === 'points' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.registerPoint(user.id, device.id, b.wbPointId, b.name));
    }
    if (action === 'point' && req.method === 'DELETE') {
      if (permissions.isDenied(device, 'act.account')) throw account.appError(403, 'DENIED_BY_OWNER', 'Владелец закрыл управление аккаунтом на этом компьютере', { key: 'act.account' });
      await sync.revokePoint(user.id, req.query.id);
      return res.status(204).end();
    }
    if (action === 'point-purge' && req.method === 'POST') {
      // удалить облачные данные пункта — только с паролем (если он есть у аккаунта)
      const b = body(req);
      if (user.email && !String(user.email).endsWith('@users.invalid')) {
        await account.passwordLogin(user.email, String(b.password || '')).catch(() => {
          throw account.appError(401, 'BAD_PASSWORD', 'Неверный пароль');
        });
      }
      await sync.purgePoint(user.id, b.point);
      return res.status(204).end();
    }
    if (action === 'archive-push' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.archivePush(user.id, String(b.point || ''), b));
    }
    if (action === 'archive-pull' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.archivePull(user.id, String(b.point || ''), b.since || {}, b.limit, { exportAll: b.export === true }));
    }
    if (action === 'mirror-push' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.mirrorPush(user.id, String(b.point || ''), b));
    }
    if (action === 'mirror-pull' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.mirrorPull(user.id, String(b.point || ''), b.since, b.limit));
    }
    if ((action === 'docs' || action === 'secrets') && req.method === 'GET') {
      const point = req.query.point ? String(req.query.point) : null;
      return res.status(200).json({ docs: await sync.docsGet(user.id, device.id, { point, secret: action === 'secrets' }) });
    }
    if ((action === 'docs' || action === 'secrets') && req.method === 'PUT') {
      const b = body(req);
      return res.status(200).json(await sync.docPut(user.id, device.id, {
        key: b.key, point: b.point || null, base: b.base, data: b.data, secret: action === 'secrets',
      }));
    }
    if (action === 'site-link' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-site-link', limit: 20, windowSeconds: 600, key: user.id })) return;
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
