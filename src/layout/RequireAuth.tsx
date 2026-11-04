import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { observer } from 'mobx-react-lite';
import { useStores } from '../stores/root-store';
import { useT } from '../i18n';

/**
 * Гард кабинета. Это НЕ безопасность — данные всё равно приходят с сервера, который проверяет
 * права сам. Здесь только маршрутизация: без сессии уводим на главную и открываем модалку входа,
 * а after входа возвращаем туда, куда человек шёл.
 */
export const RequireAuth = observer(() => {
  const { auth, ui } = useStores();
  const location = useLocation();
  const t = useT();
  const anonymous = auth.status !== 'initializing' && !auth.user;
  // from вместе с query: на /cabinet/payment-result в нём лежит token заказа,
  // без него человек вернётся на пустую страницу «заказ не найден».
  const from = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (anonymous) ui.openAuth('login', { from });
  }, [anonymous, from, ui]);

  if (auth.status === 'initializing') {
    return (
      <div role="status" aria-live="polite" style={{ padding: '2rem', textAlign: 'center' }}>
        {t('Проверяем сессию…', 'Сессияны тексеріп жатырмыз…')}
      </div>
    );
  }

  if (!auth.user) return <Navigate to="/" replace />;

  return <Outlet />;
});
