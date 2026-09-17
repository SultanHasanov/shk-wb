import { Route, Routes } from 'react-router-dom';
import { AdminShell } from '../layout/AdminShell';
import { RequireAdmin } from '../layout/RequireAdmin';
import {
  AdminAccessCodesPage, AdminAnnouncementsPage, AdminCabinetPage, AdminCellPrintPage,
  AdminOverviewPage, AdminPaymentsPage, AdminPoolPage, AdminProgramPage, AdminUserPage,
  AdminUserPreviewPage,
  AdminUsersPage,
} from '../pages/admin';

/** Ветка админки целиком: грузится ленивым чанком из App. */
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
          <Route path="payments" element={<AdminPaymentsPage />} />
          <Route path="program" element={<AdminProgramPage />} />
          <Route path="cell-print" element={<AdminCellPrintPage />} />
          <Route path="announcements" element={<AdminAnnouncementsPage />} />
          <Route path="cabinet" element={<AdminCabinetPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
