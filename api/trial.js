const { enforceRateLimit } = require('../server/_rate-limit');
const { enforceProgramVersion } = require('../server/_program-version');

// Пробного периода у «Подбора кодов» больше нет: программа работает только по ключу.
// Старые сборки ещё спрашивают этот адрес — всем отвечаем «уже использован»,
// тогда они показывают «Нужен платный ключ» и бесплатный подбор не дают.
module.exports = async function handler(req, res) {
  if (!await enforceRateLimit(req,res,{scope:'trial',limit:10,windowSeconds:3600})) return;
  if (!enforceProgramVersion(req, res)) return;
  const hwid = String((req.method === 'GET' ? req.query.hwid : req.body && req.body.hwid) || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(hwid)) return res.status(400).json({ error: 'Invalid hardware id' });

  if (req.method === 'GET') return res.status(200).json({ used: true });
  if (req.method === 'POST') return res.status(200).json({ claimed: false });
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
