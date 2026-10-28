import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { App } from './app/App';
import { ToastProvider } from './ui';
import { initMetrika } from './lib/metrika';
// Подключает все сабсеты Inter, включая кириллицу; браузер скачает только нужный
// благодаря unicode-range в @font-face.
import '@fontsource-variable/inter';
// Моноширинный для кодов, номеров ячеек и сумм (--font-mono). Имя семейства —
// «JetBrains Mono», совпадает с токеном; кириллица грузится по unicode-range.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/tokens.css';
import './styles/global.css';
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});
// До рендера: счётчик должен успеть замерить загрузку первого экрана.
initMetrika();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
