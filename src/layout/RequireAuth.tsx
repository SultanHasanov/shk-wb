import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { observer } from 'mobx-react-lite';
import { useStores } from '../stores/root-store';

/**
 * Заглушка доступа поверх мок-авторизации: раньше /cabinet открывался кому угодно
 * и показывал захардкоженный demo@shk-wb.ru.
 *
 * Это НЕ безопасность — данные всё равно приходят с сервера, который проверяет
 * права сам. Здесь только маршрутизация, чтобы кабинет не выглядел публичным.
 * Заменить на реальную проверку сессии при подключении Supabase Auth.
 */
export const RequireAuth = observer(() => {
  const { auth } = useStores();
  const location = useLocation();

  if (auth.status === 'initializing') {
    return (
      <div role="status" aria-live="polite" style={{ padding: '2rem', textAlign: 'center' }}>
        Проверяем сессию…
      </div>
    );
  }

  if (!auth.user) {
    // from — чтобы после входа вернуть человека туда, куда он шёл.
    // Вместе с query: на /cabinet/payment-result в нём лежит token заказа,
    // без него человек вернётся на пустую страницу «заказ не найден».
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }

  return <Outlet />;
});
