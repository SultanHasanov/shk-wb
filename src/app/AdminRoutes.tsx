import { Route, Routes } from 'react-router-dom';
import { AdminShell } from '../layout/AdminShell';
import { RequireAdmin } from '../layout/RequireAdmin';
import {
  AdminAccessCodesPage, AdminAnnouncementsPage, AdminAuditPage, AdminCabinetPage, AdminCellPrintPage,
  AdminOverviewPage, AdminPartnerPage, AdminPartnersPage, AdminPaymentsPage, AdminPoolPage, AdminProgramPage,
  AdminSystemPage, AdminUserPage, AdminUserPreviewPage, AdminUsersPage,
} from '../pages/admin';

/**
 * Ветка админки целиком: грузится ленивым чанком из App.
 * Состояние страниц живёт в адресе: карточка — `users/:userId?tab=…`, журнал —
 * `audit?tab=actions|deliveries&userId=&category=`, список — `users?q=&filter=&sort=&page=`.
 */
export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<RequireAdmin />}>
        <Route element={<AdminShell />}>
          <Route index element={<AdminOverviewPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="users/:userId" element={<AdminUserPage />} />
          <Route path="users/:userId/preview" element={<AdminUserPreviewPage />} />
          <Route path="access-codes" element={<AdminAccessCodesPage />} />
          <Route path="sticker-pool" element={<AdminPoolPage kind="stickerPool" title="Диапазон номеров стикеров" />} />
          <Route path="box-pool" element={<AdminPoolPage kind="boxPool" title="Диапазон номеров коробок" />} />
          <Route path="partners" element={<AdminPartnersPage />} />
          <Route path="partners/:partnerId" element={<AdminPartnerPage />} />
          <Route path="payments" element={<AdminPaymentsPage />} />
          <Route path="program" element={<AdminProgramPage />} />
          <Route path="cell-print" element={<AdminCellPrintPage />} />
          <Route path="announcements" element={<AdminAnnouncementsPage />} />
          <Route path="cabinet" element={<AdminCabinetPage section="withdrawals" />} />
          <Route path="broadcasts" element={<AdminCabinetPage section="broadcasts" />} />
          <Route path="audit" element={<AdminAuditPage />} />
          <Route path="system" element={<AdminSystemPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
