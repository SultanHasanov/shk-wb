/**
 * Минимальная версия программы «Подбор кодов» для доступа к лицензии и пробному подбору.
 *
 * Старые сборки (1.3.2 и ниже) не умеют обязательное обновление: у их плашки есть
 * кнопка «Позже», и заставить их обновиться можно только отсюда — отказом сервера.
 * Отличить старую сборку от новой можно ровно по одному признаку: с 1.3.3 программа
 * шлёт заголовок X-App-Version, раньше не слала ничего. Поэтому запрос без заголовка
 * считается устаревшим — но только когда проверка включена.
 *
 * PROGRAM_MIN_VERSION пустая или '0' — проверка выключена (так и должно быть, пока
 * новая версия не выложена: иначе отсекутся все работающие сейчас программы).
 */
function versionTuple(value) {
  return String(value || '0').split('.').map(part => {
    const number = parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
}

function isOlder(left, right) {
  const a = versionTuple(left), b = versionTuple(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

function enforceProgramVersion(req, res) {
  const minimum = String(process.env.PROGRAM_MIN_VERSION || '').trim();
  if (!minimum || minimum === '0') return true;
  const sent = String(req.headers['x-app-version'] || '').trim();
  if (sent && !isOlder(sent, minimum)) return true;
  // 426 Upgrade Required: сборки до 1.3.3 показывают своё «нет связи с сервером»,
  // 1.3.3 и новее берут отсюда текст и выводят его в строке статуса лицензии.
  res.status(426).json({
    error: `Программа устарела: нужна версия ${minimum} или новее. Обновитесь через плашку в программе или скачайте установщик на shk-wb.vercel.app/program`,
  });
  return false;
}

module.exports = { enforceProgramVersion, versionTuple, isOlder };
