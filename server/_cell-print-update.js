/** Подписанный канал обновлений «Печати ячеек» 2.x (формат Tauri updater). */
const fs = require('fs');
const path = require('path');
const { isOlder } = require('./_program-version');

const MAX_BYTES = 250 * 1024 * 1024;

function updatesDir() {
  return process.env.CELL_PRINT_UPDATES_DIR || '/srv/shk-wb/app-updates/cell-print';
}

function readLatest() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(updatesDir(), 'latest.json'), 'utf8'));
    return value && value.version ? value : null;
  } catch {
    return null;
  }
}

function updateResponse(req, res, origin) {
  const current = String(req.query.current || req.headers['x-app-version'] || '').trim();
  const latest = readLatest();
  res.setHeader('Cache-Control', 'no-store');
  if (!latest || !current || !isOlder(current, latest.version) || !latest.file || !latest.signature) {
    return res.status(204).end();
  }
  const mandatory = latest.mandatory === true || (latest.min_version && isOlder(current, latest.min_version));
  return res.status(200).json({
    version: latest.version,
    notes: latest.notes || '',
    pub_date: latest.pub_date || new Date().toISOString(),
    url: `${origin}/api/cell-print/update/download?v=${encodeURIComponent(latest.version)}`,
    signature: latest.signature,
    mandatory: Boolean(mandatory),
    min_version: latest.min_version || null,
    auto: false,
  });
}

function downloadResponse(res) {
  const latest = readLatest();
  if (!latest || !latest.file) return res.status(404).json({ error: 'Обновление не найдено' });
  const file = path.join(updatesDir(), path.basename(String(latest.file)));
  let stat;
  try { stat = fs.statSync(file); } catch { return res.status(404).json({ error: 'Файл обновления не найден' }); }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) {
    return res.status(413).json({ error: 'Недопустимый размер файла обновления' });
  }
  res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `attachment; filename="cell-print-${latest.version}-setup.exe"`);
  res.setHeader('Cache-Control', 'no-store');
  return fs.createReadStream(file).pipe(res);
}

module.exports = { updateResponse, downloadResponse };
