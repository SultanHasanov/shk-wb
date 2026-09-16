import { Outlet } from 'react-router-dom';
import { AdminUnauthorized, useAdminSession } from '../api/admin';
import { AdminLoginPage } from '../pages/admin/AdminLoginPage';
import { Alert, Spinner } from '../ui';

/**
 * Ворота админки. Форма входа рисуется на месте, без редиректа: адрес панели
 * секретный, и уводить с него на /login значит светить его в истории браузера
 * и в реферере. Настоящая защита всё равно серверная — requireAdmin в
 * api/admin/data.js; здесь только маршрутизация.
 */
export function RequireAdmin() {
  const session = useAdminSession();

  if (session.isPending) {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <Spinner size={28} />
      </div>
    );
  }

  if (session.isError) {
    if (session.error instanceof AdminUnauthorized) return <AdminLoginPage />;
    return (
      <div className="page">
        <Alert tone="error">Не удалось проверить доступ: {session.error.message}</Alert>
      </div>
    );
  }

  return <Outlet />;
}
