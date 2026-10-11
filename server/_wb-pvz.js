const crypto = require('crypto');

const AUTH_ORIGIN = 'https://auth-my-pvz.wb.ru';
const ORGS_ORIGIN = 'https://r-point.wb.ru';
const RATING_ORIGIN = 'https://point-rating.wb.ru';
const DESKTOP_ORIGIN = 'https://s-point.wb.ru';
const POINT_ORIGIN = 'https://point.wb.ru';

class WbPvzError extends Error {
  constructor(message, status, powHeader) {
    super(message);
    this.name = 'WbPvzError';
    this.status = status;
    this.powHeader = powHeader || null;
  }
}

function encryptionKey() {
  const secret = String(process.env.WB_SESSION_SECRET || process.env.STICKER_CLIENT_SECRET || '');
  if (secret.length < 32) throw new Error('WB_SESSION_SECRET must contain at least 32 characters');
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSession(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptSession(value) {
  if (!value) return null;
  const [version, iv, tag, encrypted] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid WB session');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8'));
}

function messageFrom(data, fallback) {
  if (data && typeof data === 'object') {
    if (data.error && typeof data.error === 'object' && data.error.message) return String(data.error.message);
    if (typeof data.message === 'string') return data.message;
    if (typeof data.error === 'string') return data.error;
  }
  return fallback;
}

function cookieHeader(session) {
  return Object.entries(session.cookies || {}).map(([name, value]) => `${name}=${value}`).join('; ');
}

function rememberCookies(session, headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  if (!values.length) return;
  session.cookies = session.cookies || {};
  for (const value of values) {
    const pair = String(value).split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index > 0) session.cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
}

async function request(session, url, options = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://my-pvz.wb.ru',
    Referer: 'https://my-pvz.wb.ru/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    'X-Language': 'ru',
    ...(options.headers || {}),
  };
  const cookies = cookieHeader(session);
  if (cookies) headers.Cookie = cookies;
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  rememberCookies(session, response.headers);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new WbPvzError(messageFrom(data, `Ошибка WB HTTP ${response.status}`), response.status, response.headers.get('x-pow'));
  if (data == null) throw new WbPvzError('WB вернул ответ не в формате JSON', response.status);
  return { data, powHeader: response.headers.get('x-pow') };
}

function extractChallenge(powHeader) {
  const match = String(powHeader || '').match(/challenge=([^;]+)/);
  return match ? match[1] : null;
}

function solvePow(challenge) {
  const parts = String(challenge).split(',');
  if (parts.length < 9) throw new WbPvzError('WB вернул некорректную проверку X-Pow');
  const difficulty = Number(parts[1]);
  const salt = parts[3];
  const fullNibbles = Math.floor(difficulty / 4);
  const remainingBits = difficulty % 4;
  const maxAttempts = 2 ** (difficulty + 6);
  for (let nonce = 0; nonce < maxAttempts; nonce += 1) {
    const digest = crypto.createHash('sha256').update(`${salt}${nonce}`).digest('hex');
    const fullZeroes = digest.startsWith('0'.repeat(fullNibbles));
    const nextNibble = Number.parseInt(digest[fullNibbles] || '0', 16);
    if (fullZeroes && (remainingBits === 0 || nextNibble < 2 ** (4 - remainingBits))) return nonce;
  }
  throw new WbPvzError('Не удалось пройти проверку WB X-Pow');
}

function authHeaders(session, challenge) {
  const headers = { Deviceid: session.deviceId, 'Wb-Appversion': 'v0.0.55' };
  if (challenge) headers['X-Pow'] = `status=valid; nonce=${solvePow(challenge)}; challenge=${challenge}`;
  return headers;
}

function apiHeaders(session, appVersion = 'v0.0.50') {
  if (!session.token) throw new WbPvzError('Сессия WB не подключена', 401);
  return {
    'X-Token': session.token,
    'X-App-Type': 'prod-my-pvz',
    'X-App-Version': appVersion,
    'X-Client-Id': 'my-pvz',
    'X-Language': 'ru',
    ...(session.deviceId ? { Deviceid: session.deviceId } : {}),
  };
}

function desktopHeaders(session, includeToken = false) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'WBPoint Android',
    'X-App-Type': process.env.WB_DESKTOP_APP_TYPE || 'staff',
    'X-App-Version': process.env.WB_DESKTOP_APP_VERSION || 'v0.37.0',
    Deviceid: session.deviceId,
  };
  if (includeToken) {
    const token = session.desktopToken || session.token;
    if (!token) throw new WbPvzError('Сессия WB Desktop не подключена', 401);
    headers['X-Token'] = token;
  }
  return headers;
}

async function requestCode(session, phone) {
  const result = await request(session, `${ORGS_ORIGIN}/api/v1/login`, {
    method: 'POST', headers: desktopHeaders(session), body: {
      device_type: 'DEVICE_ANDROID',
      device_uuid: session.deviceId,
      phone: String(phone),
      resend: false,
    },
  });
  const payload = result.data?.data ?? result.data;
  const loginToken = tokenValue(payload) || tokenValue(payload?.token) || tokenValue(result.data?.token);
  if (!loginToken) throw new WbPvzError(messageFrom(result.data, 'WB Desktop не вернул токен подтверждения'));
  session.phone = phone;
  session.desktopLoginToken = loginToken;
  session.authKind = 'desktop';
  return { session, ttl: Number(payload?.ttl || payload?.expires_in || result.data?.ttl || 60) };
}

async function confirmCode(session, code) {
  if (!session.desktopLoginToken) throw new WbPvzError('Сначала запросите код WB Desktop');
  const result = await request(session, `${ORGS_ORIGIN}/api/v1/validate`, {
    method: 'POST', headers: desktopHeaders(session),
    body: {
      code: String(code),
      device_type: 'DEVICE_ANDROID',
      device_uuid: session.deviceId,
      token: session.desktopLoginToken,
    },
  });
  const payload = result.data?.data && typeof result.data.data === 'object' ? result.data.data : result.data;
  const token = tokenValue(payload?.access) || tokenValue(payload?.token) || tokenValue(payload?.access_token);
  if (!token) throw new WbPvzError(messageFrom(result.data, 'WB Desktop не вернул access token'));
  session.token = token;
  session.desktopToken = token;
  session.authKind = 'desktop';
  session.points = normalizePoints(payload);
  delete session.desktopLoginToken;
  return session;
}

function normalizePoints(data) {
  const root = data?.data && typeof data.data === 'object' ? data.data : data;
  const candidates = [
    Array.isArray(root) ? root : null,
    root?.pickpoints,
    root?.pick_points,
    root?.offices,
    root?.user?.pickpoints,
    root?.user?.offices,
  ];
  const source = candidates.find(Array.isArray) || [];
  const points = [];
  for (const item of source) {
    const officeId = Number(item?.id ?? item?.office_id);
    const externalId = Number(item?.external_id ?? item?.eapid ?? item?.pickpoint_id ?? officeId);
    const id = externalId;
    if (!Number.isSafeInteger(id) || id <= 0 || points.some(point => point.id === id)) continue;
    const shard = Number(item?.shard ?? item?.pickpoint_shard);
    points.push({
      ...item,
      id,
      officeId: Number.isSafeInteger(officeId) && officeId > 0 ? officeId : id,
      externalId: id,
      shard: Number.isSafeInteger(shard) && shard > 0 ? shard : null,
    });
  }
  return points;
}

async function loadPoints(session) {
  if (session.authKind === 'desktop') {
    if (Array.isArray(session.points) && session.points.length) return session.points;
    const configuredExternalId = Number(process.env.WB_DESKTOP_EXTERNAL_POINT_ID || 0);
    const configuredOfficeId = Number(process.env.WB_DESKTOP_POINT_ID || 0);
    const configuredShard = Number(process.env.WB_DESKTOP_SHARD || 0);
    if (Number.isSafeInteger(configuredExternalId) && configuredExternalId > 0
      && Number.isSafeInteger(configuredOfficeId) && configuredOfficeId > 0) {
      const points = [{
        id: configuredExternalId,
        officeId: configuredOfficeId,
        shard: Number.isSafeInteger(configuredShard) && configuredShard > 0 ? configuredShard : null,
      }];
      session.points = points;
      return points;
    }
    const { data } = await request(session, `${POINT_ORIGIN}/api/v2/pickpoint/list`, {
      headers: desktopHeaders(session, true),
    });
    const points = normalizePoints(data);
    session.points = points;
    return points;
  }
  const { data } = await request(session, `${ORGS_ORIGIN}/auth-api/v3/my-orgs`, { headers: apiHeaders(session) });
  const organizations = Array.isArray(data) ? data : [];
  const points = [];
  for (const organization of organizations) {
    for (const rawPointId of organization.eapids || []) {
      const pointId = Number(rawPointId);
      if (!Number.isSafeInteger(pointId) || pointId <= 0 || points.some(point => point.id === pointId)) continue;
      points.push({ id: pointId, organizationId: organization.id, position: organization.position || null });
    }
  }
  session.points = points;
  return points;
}

async function selectPoint(session, pointId) {
  const point = (session.points || []).find(item => Number(item.id) === Number(pointId));
  if (!point) throw new WbPvzError('Выбранный ПВЗ недоступен этому аккаунту');
  if (session.authKind === 'desktop') {
    session.pointId = Number(pointId);
    session.desktopOfficeId = Number(point.officeId || point.office_id || point.id);
    if (point.shard) session.desktopShard = Number(point.shard);
    session.desktopToken = null;
    await switchDesktopPoint(session);
    session.token = session.desktopToken;
    return session;
  }
  const { data } = await request(session, `${ORGS_ORIGIN}/auth-api/v3/enrich`, {
    method: 'POST', headers: apiHeaders(session), body: { org_id: point.organizationId, position: point.position },
  });
  const token = data.access && data.access.token;
  if (!token) throw new WbPvzError(messageFrom(data, 'WB не вернул токен выбранного ПВЗ'));
  session.token = token;
  session.pointId = Number(pointId);
  const shard = Number(data.shard || data.pickpoint_shard || data.access?.shard || point.shard);
  if (Number.isSafeInteger(shard) && shard > 0) session.desktopShard = shard;
  return session;
}

async function loadReviews(session, stars, page, pageSize = 5) {
  const officeId = Number(session.desktopOfficeId || session.pointId);
  const externalId = Number(session.pointId);
  const params = new URLSearchParams();
  params.set('pickpoint_id', String(officeId));
  for (const star of stars) params.append('filter.stars', String(star));
  params.set('filter.limit', String(pageSize));
  params.set('filter.offset', String(Math.max(0, page) * pageSize));
  params.set('filter.only_disputable', 'false');
  const headers = {
    ...desktopHeaders(session, true),
    'X-Pickpoint-Id': String(officeId),
    'X-Pickpoint-External-Id': String(externalId),
  };
  const { data } = await request(session, `${RATING_ORIGIN}/external/api/v3/feedbacks/pickpoint?${params}`, { headers });
  return { data: Array.isArray(data.data) ? data.data : [], total: Number(data.total || 0) };
}

async function loadUsers(session, userIds) {
  const ids = [...new Set(userIds.map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return [];
  const officeId = Number(session.desktopOfficeId || session.pointId);
  const externalId = Number(session.pointId);
  const { data } = await request(session, `${ORGS_ORIGIN}/gw/common/v1/users-data`, {
    method: 'POST',
    headers: {
      ...desktopHeaders(session, true),
      'X-Pickpoint-Id': String(officeId),
      'X-Pickpoint-External-Id': String(externalId),
    },
    body: { user_ids: ids },
  });
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.data?.users)) return data.data.users;
  if (Array.isArray(data.users)) return data.users;
  return [];
}

function normalizeGoodsInPickPoint(data) {
  const root = data && typeof data === 'object' && data.data && !Array.isArray(data.data)
    ? data.data
    : data;
  const candidates = [
    Array.isArray(data) ? data : null,
    Array.isArray(data?.data) ? data.data : null,
    root?.goods,
    root?.items,
    root?.list,
  ];
  const goods = candidates.find(Array.isArray) || [];
  const cursorValue = root?.max_last_id ?? root?.response_last_id ?? root?.last_id
    ?? data?.max_last_id ?? data?.response_last_id ?? data?.last_id;
  const cursor = Number(cursorValue);
  return {
    goods,
    cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null,
  };
}

function desktopShard(session) {
  const value = Number(session.desktopShard || process.env.WB_DESKTOP_SHARD || 0);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 999) {
    throw new WbPvzError('Не указан shard WB Desktop. Для теста задайте WB_DESKTOP_SHARD.', 400);
  }
  return value;
}

function tokenValue(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  return value.token || value.access_token || value.accessToken || null;
}

async function switchDesktopPoint(session) {
  if (session.desktopToken && session.pointId && session.desktopPointId === session.pointId) return session;
  if (!session.pointId) throw new WbPvzError('Сначала выберите ПВЗ', 400);
  const officeId = Number(session.desktopOfficeId || session.pointId);
  const externalId = Number(session.pointId);
  const shard = desktopShard(session);
  const result = await request(session, `${DESKTOP_ORIGIN}/s${shard}/api/v2/pickpoint/${officeId}/switch`, {
    headers: {
      ...desktopHeaders(session, true),
      'X-Pickpoint-Id': String(officeId),
      'X-Pickpoint-External-Id': String(externalId),
    },
  });
  const { data } = result;
  const root = data?.data && typeof data.data === 'object' ? data.data : data;
  const token = tokenValue(root?.access) || tokenValue(root?.token) || tokenValue(root?.access_token);
  if (!token) throw new WbPvzError(messageFrom(data, 'WB не вернул Desktop-токен выбранного ПВЗ'));
  session.desktopToken = token;
  session.desktopPointId = Number(session.pointId);
  const responseShard = Number(root?.shard || root?.pickpoint_shard || root?.office?.shard || root?.pickpoint?.shard);
  if (Number.isSafeInteger(responseShard) && responseShard > 0) session.desktopShard = responseShard;
  return session;
}

async function loadGoodsInPickPoint(session, lastId = 0) {
  await switchDesktopPoint(session);
  const cursor = Number(lastId);
  const safeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  const shard = desktopShard(session);
  const officeId = String(session.desktopOfficeId || session.pointId);
  const externalId = String(session.pointId);
  const params = new URLSearchParams({
    last_id: String(safeCursor),
    pickpoint_id: officeId,
    x_pickpoint_id: externalId,
  });
  const desktopSession = { ...session, token: session.desktopToken };
  const headers = {
    ...apiHeaders(desktopSession, process.env.WB_DESKTOP_APP_VERSION || 'v0.37.0'),
    'X-App-Type': process.env.WB_DESKTOP_APP_TYPE || 'staff',
    'X-Pickpoint-Id': officeId,
    'X-Pickpoint-External-Id': externalId,
  };
  const { data } = await request(desktopSession, `${DESKTOP_ORIGIN}/s${shard}/api/v5/pickpoint/goods/list?${params}`, { headers });
  return normalizeGoodsInPickPoint(data);
}

module.exports = {
  WbPvzError, apiHeaders, confirmCode, decryptSession, encryptSession, extractChallenge,
  loadGoodsInPickPoint, loadPoints, loadReviews, loadUsers, normalizeGoodsInPickPoint,
  normalizePoints, requestCode, selectPoint, solvePow, switchDesktopPoint, tokenValue,
};
