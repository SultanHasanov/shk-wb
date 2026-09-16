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
  PackagesPage,
  ProfilePage,
  ReferralsPage,
  SettingsPage,
} from '../pages/cabinet';

/**
 * Ветка кабинета целиком: грузится ленивым чанком из App — по образцу
 * AdminRoutes. Десять страниц кабинета лежали во входном бандле и приезжали к
 * посетителю из поиска, которому нужен только лендинг.
 */
export default function CabinetRoutes() {
  return (
    <Routes>
      <Route element={<RequireAuth />}>
        <Route element={<CabinetShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="generator" element={<CabinetGeneratorPage />} />
          {/* Покупка из кабинета возвращается сюда же, а не на публичную страницу */}
          <Route path="payment-result" element={<PaymentResultPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="packages" element={<PackagesPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="referrals" element={<ReferralsPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
