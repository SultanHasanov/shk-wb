import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';

export function ReferralCapturePage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    // Раньше отсюда уводили на /register: человек по приглашению упирался в форму,
    // не увидев сам сервис. Приглашение лежит в cookie shk_ref 30 дней, поэтому
    // показываем обычную главную — можно сразу генерировать и покупать, а код
    // закрепится за аккаунтом в момент регистрации.
    api<void>('/api/referrals/capture', { method: 'POST', body: JSON.stringify({ code }) })
      .catch(() => {})
      .finally(() => navigate('/', { replace: true }));
  }, [code, navigate]);

  return (
    <div role="status" style={{ padding: '3rem', textAlign: 'center' }}>
      Открываем сайт…
    </div>
  );
}
