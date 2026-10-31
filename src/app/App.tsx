import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { PublicShell } from '../layout/PublicShell';
import { AuthShell } from '../layout/AuthShell';
import { AuthPage } from '../pages/AuthPage';
import { ResetPasswordPage } from '../pages/ResetPasswordPage';
import { GeneratorPage } from '../pages/GeneratorPage';
import { CellPrintPage } from '../pages/CellPrintPage';
import { ProgramPage } from '../pages/ProgramPage';
import { TarifyPage } from '../pages/TarifyPage';
import { ComparePage } from '../pages/ComparePage';
import { ReturnStickersPage } from '../pages/ReturnStickersPage';
import { BoxCodesPage } from '../pages/BoxCodesPage';
import { ContactsPage } from '../pages/ContactsPage';
import { CookiePage, OfferPage, PrivacyPage } from '../pages/LegalPages';
import { PaymentResultPage } from '../pages/PaymentResultPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { UiInventoryPage } from '../pages/UiInventoryPage';
import { ReferralCapturePage } from '../pages/ReferralCapturePage';
import { BotCheckoutPage } from '../pages/BotCheckoutPage';
import { TelegramAccountPage } from '../pages/TelegramAccountPage';
import { AppLoginPage } from '../pages/AppLoginPage';
import { ScrollToHash } from './ScrollToHash';
import { useMetrikaPageviews } from '../lib/metrika';
import { useLocaleEffects } from '../i18n';
import { useKeyboardOpen } from '../lib/useKeyboardOpen';

// Админка грузится отдельным чанком: её видит один человек, а весит она как
// половина публичного сайта. Кабинет — по той же причине: посетителю из поиска
// нужен лендинг, а не десять страниц личного кабинета во входном бандле.
const AdminRoutes = lazy(() => import('./AdminRoutes'));
const CabinetRoutes = lazy(() => import('./CabinetRoutes'));

/** Публичные маршруты: монтируются дважды — на русском (/) и казахском (/kz). */
const publicRoutes = (
  <>
    <Route index element={<GeneratorPage />} />
    <Route path="cell-print" element={<CellPrintPage />} />
    <Route path="program" element={<ProgramPage />} />
    <Route path="tarify" element={<TarifyPage />} />
    <Route path="sravnenie" element={<ComparePage />} />
    <Route path="vozvratnye-stikery-wb" element={<ReturnStickersPage />} />
    <Route path="qr-korobov-wb" element={<BoxCodesPage />} />
    <Route path="contacts" element={<ContactsPage />} />
    <Route path="r/:code" element={<ReferralCapturePage />} />

    {/* Юридические и сервисные: раньше — отдельные .html со старым CSS */}
    <Route path="offer" element={<OfferPage />} />
    <Route path="privacy" element={<PrivacyPage />} />
    <Route path="cookie" element={<CookiePage />} />
    <Route path="payment-result" element={<PaymentResultPage />} />

    {/* Витрина дизайн-системы нужна разработке, а не посетителям сайта */}
    {import.meta.env.DEV && <Route path="ui" element={<UiInventoryPage />} />}

    {/* Раньше здесь был молчаливый редирект на «/» */}
    <Route path="*" element={<NotFoundPage />} />
  </>
);

export function App() {
  // Один вызов на всё приложение: переходы в кабинете и панели тоже должны
  // доходить до Метрики, иначе визит обрывается на публичной странице.
  useMetrikaPageviews();
  useLocaleEffects();
  useKeyboardOpen();

  return (
    <>
      <ScrollToHash />
      <Routes>
        {/* Публичная часть — маркетинговая шапка и футер, без сайдбара.
            Та же ветка под /kz — казахская версия с отдельными адресами для поиска. */}
        <Route element={<PublicShell />}>{publicRoutes}</Route>
        <Route path="kz" element={<PublicShell />}>{publicRoutes}</Route>

        {/* Панель управления. Адрес не /admin-enigma: там до сих пор лежит
            статическая админка, и Vercel отдаёт файл раньше, чем маршрут SPA. */}
        <Route
          path="panel/*"
          element={
            <Suspense fallback={null}>
              <AdminRoutes />
            </Suspense>
          }
        />

        {/* Авторизация — центрированная карточка без хрома */}
        <Route element={<AuthShell />}>
          <Route path="login" element={<AuthPage mode="login" />} />
          <Route path="register" element={<AuthPage mode="register" />} />
          <Route path="forgot-password" element={<AuthPage mode="forgot" />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="bot-checkout" element={<BotCheckoutPage />} />
          <Route path="telegram-account" element={<TelegramAccountPage />} />
          <Route path="app-login" element={<AppLoginPage />} />
        </Route>

        {/* Кабинет — сайдбар, только для вошедших */}
        <Route
          path="cabinet/*"
          element={
            <Suspense fallback={null}>
              <CabinetRoutes />
            </Suspense>
          }
        />
      </Routes>
    </>
  );
}
