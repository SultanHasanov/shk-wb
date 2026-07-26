// api/auth.js
export default async function handler(req, res) {
  // Разрешаем CORS для ответа (но это не обязательно, т.к. клиент и сервер на одном origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pow, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Только POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  // Целевой путь приходит от vercel.json rewrite (?path=/auth или /code/wb-captcha)
  const targetPath = req.query.path || '/auth';
  const targetUrl = `https://auth-my-pvz.wb.ru/v2${targetPath}`;

  // Копируем заголовки, которые нужно передать
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Origin': 'https://my-pvz.wb.ru',
    'Referer': 'https://my-pvz.wb.ru/',
    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 ...',
  };

  // Если клиент прислал X-Pow или Authorization – передаём их
  if (req.headers['x-pow']) headers['X-Pow'] = req.headers['x-pow'];
  if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

  console.log('[proxy] ->', targetUrl, JSON.stringify({ headers, body: req.body }));

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

    // Получаем тело ответа
    const responsePow = response.headers.get('x-pow');
    if (responsePow) {
      res.setHeader('X-Pow', responsePow);
    }

    const data = await response.json();

    console.log('[proxy] <-', response.status, JSON.stringify(Object.fromEntries(response.headers.entries())), JSON.stringify(data));

    // Передаём клиенту статус и данные
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
