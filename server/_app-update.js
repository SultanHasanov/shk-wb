/**
 * Обновления и «аренда» программы «Помощник ПВЗ» (Tauri).
 *
 * Релиз лежит ВНЕ папки сайта (переживает деплои): $PVZ_APP_UPDATES_DIR/latest.json
 *   { "version": "1.4.1", "notes": "…", "pub_date": "2026-10-20T10:00:00Z",
 *     "file": "Помощник ПВЗ_1.4.1_x64-setup.exe", "signature": "<содержимое .sig>",
 *     "min_version": "1.4.0", "mandatory": false,
 *     "auto": true, "mandatory_after": "2026-10-25T21:00:00Z" }
 * Выпуск версии = залить установщик, его .sig и latest.json по scp. Деплой сайта не нужен.
 *
 * Обязательность: min_version = max(env PVZ_APP_MIN_VERSION, latest.min_version);
 * версия программы ниже min_version (или latest.mandatory) → обновление обязательное.
 * mandatory_after — mandatory включается только с этой даты (до неё версия ставится как обычная).
 * auto: false — программа не ставит версию сама в простое, только по кнопке (по умолчанию — ставит).
 *
 * Аренда: программа работает только пока у неё есть подписанное (Ed25519) подтверждение
 * сервера не старше PVZ_LEASE_SECONDS (по умолчанию час). Ключ — PVZ_LEASE_PRIVATE_KEY (PEM PKCS8).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isOlder } = require('./_program-version');

const APP_NAME = 'pvz-helper';

function updatesDir() {
  return process.env.PVZ_APP_UPDATES_DIR || '/srv/shk-wb/app-updates/pvz-helper';
}

function readLatest() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(updatesDir(), 'latest.json'), 'utf8'));
    if (!raw || !raw.version) return null;
    return raw;
  } catch {
    return null;
  }
}

function maxVersion(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return isOlder(a, b) ? b : a;
}

/** Политика для конкретной версии программы: что последнее и обязательно ли обновиться. */
function policy(current) {
  const latest = readLatest();
  const envMin = String(process.env.PVZ_APP_MIN_VERSION || '').trim();
  const minVersion = maxVersion(envMin === '0' ? '' : envMin, latest && latest.min_version ? String(latest.min_version) : '');
  const newer = !!(latest && current && isOlder(current, latest.version));
  const after = latest && latest.mandatory_after ? Date.parse(latest.mandatory_after) : NaN;
  const mandatoryNow = latest && latest.mandatory === true && !(after > Date.now());
  const mandatory = !!current && (
    (minVersion && isOlder(current, minVersion)) ||
    (newer && mandatoryNow)
  );
  return { latest, newer, mandatory: !!mandatory, minVersion: minVersion || null };
}

/** GET /api/app/update — формат Tauri updater + mandatory/min_version. 204 — новее нет. */
function updateResponse(req, res, origin) {
  const current = String(req.query.current || req.headers['x-app-version'] || '').trim();
  const { latest, newer, mandatory, minVersion } = policy(current);
  res.setHeader('Cache-Control', 'no-store');
  if (!latest || !newer || !latest.file || !latest.signature) return res.status(204).end();
  return res.status(200).json({
    version: latest.version,
    notes: latest.notes || '',
    pub_date: latest.pub_date || new Date().toISOString(),
    url: `${origin}/api/app/update/download?v=${encodeURIComponent(latest.version)}`,
    signature: latest.signature,
    mandatory,
    min_version: minVersion,
    mandatory_after: latest.mandatory === true && latest.mandatory_after ? String(latest.mandatory_after) : null,
    auto: latest.auto !== false,
  });
}

/** GET /api/app/update/download — установщик текущего релиза потоком. */
function downloadResponse(res) {
  const latest = readLatest();
  if (!latest || !latest.file) return res.status(404).json({ error: 'Обновление не найдено' });
  // Только имя файла: из latest.json не даём выйти за пределы папки обновлений.
  const file = path.join(updatesDir(), path.basename(String(latest.file)));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return res.status(404).json({ error: 'Файл обновления не найден' });
  }
  res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `attachment; filename="pvz-helper-${latest.version}-setup.exe"`);
  res.setHeader('Cache-Control', 'no-store');
  return fs.createReadStream(file).pipe(res);
}

function leaseSeconds() {
  const n = parseInt(process.env.PVZ_LEASE_SECONDS || '', 10);
  return Number.isFinite(n) && n >= 60 ? n : 3600;
}

let cachedKey = null;
function leaseKey() {
  const pem = String(process.env.PVZ_LEASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!pem) return null;
  if (!cachedKey || cachedKey.pem !== pem) cachedKey = { pem, key: crypto.createPrivateKey(pem) };
  return cachedKey.key;
}

/**
 * POST /api/app/lease — подписанное подтверждение «сервер на связи».
 * Подписываются ровно байты поля payload (JSON-строка): программа проверяет их как есть.
 * С токеном сессии в payload кладутся права (тариф, разделы, срок архива) — программа
 * открывает разделы только по подписанным правам.
 */
function leaseResponse(req, res, deviceHash, rights) {
  const key = leaseKey();
  if (!key) return res.status(503).json({ error: 'Аренда не настроена', code: 'LEASE_DISABLED' });
  const version = String(req.headers['x-app-version'] || '').trim();
  const { latest, mandatory, minVersion } = policy(version);
  const iat = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    app: APP_NAME,
    device: deviceHash,
    version,
    iat,
    exp: iat + leaseSeconds(),
    min_version: minVersion,
    mandatory,
    latest: latest ? latest.version : null,
    // Права аккаунта на этом ПК (server/_app-account.js leaseRights). Старые программы поле не читают.
    rights: rights || null,
  });
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ payload, signature });
}

module.exports = { APP_NAME, policy, updateResponse, downloadResponse, leaseResponse, readLatest, updatesDir };
