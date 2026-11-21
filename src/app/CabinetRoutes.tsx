import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { CabinetShell } from '../layout/CabinetShell';
import { RequireAuth } from '../layout/RequireAuth';
import { PaymentResultPage } from '../pages/PaymentResultPage';
import {
  CabinetGeneratorPage,
  HistoryPage,
  KeysPage,
  NotificationsPage,
  OrdersPage,
  OverviewPage,
  PartnerPage,
  PackagesPage,
  ProfilePage,
  ReferralsPage,
  SettingsPage,
  SubscriptionPage,
  AccessPage,
  PcMessagesPage,
  FeedbackPage,
} from '../pages/cabinet';

// «Сотрудники» — большой раздел (табель, зарплата, выгрузка в Excel): отдельный чанк, остальной кабинет его не грузит.
const StaffPage = lazy(() => import('../pages/cabinet/staff/StaffPage').then(m => ({ default: m.StaffPage })));
// Веб-версия «Помощника ПВЗ» (/cabinet/pvz-web): отдельное приложение внутри кабинета, грузится только по переходу.
const PvzWebApp = lazy(() => import('../pages/pvz-web/PvzWebApp'));

/**
 * Ветка кабинета целиком: грузится ленивым чанком из App — по образцу
 * AdminRoutes. Десять страниц кабинета лежали во входном бандле и приезжали к
 * посетителю из поиска, которому нужен только лендинг.
 */
export default function CabinetRoutes() {
  return (
    <Routes>
      <Route element={<RequireAuth />}>
        {/* Веб-версия Помощника — на весь экран, со своим меню: под входом, но вне оболочки кабинета */}
        <Route path="pvz-web" element={<Suspense fallback={null}><PvzWebApp /></Suspense>} />
        <Route element={<CabinetShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="generator" element={<CabinetGeneratorPage />} />
          {/* Покупка из кабинета возвращается сюда же, а не на публичную страницу */}
          <Route path="payment-result" element={<PaymentResultPage />} />
          <Route path="subscription" element={<SubscriptionPage />} />
          <Route path="access" element={<AccessPage />} />
          <Route path="pc-messages" element={<PcMessagesPage />} />
          <Route path="feedback" element={<FeedbackPage />} />
          <Route path="staff" element={<Suspense fallback={null}><StaffPage /></Suspense>} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="packages" element={<PackagesPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="referrals" element={<ReferralsPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="partner" element={<PartnerPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
