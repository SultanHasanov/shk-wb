import { useEffect, useId, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStores } from '../stores/root-store';
import { api } from '../api/client';
import { BOT_USERNAME } from '../lib/telegram';

type TelegramPayload = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

declare global {
  interface Window {
    [key: `telegramAuth_${string}`]: ((payload: TelegramPayload) => void) | undefined;
    Telegram?: { WebApp?: { initData: string; ready: () => void; expand: () => void; close: () => void; openLink: (url: string) => void; openTelegramLink?: (url: string) => void } };
  }
}

export function TelegramLogin({ mode = 'login', onError, onSuccess, closeMiniApp = true, navigateAfterLogin = true }: { mode?: 'login' | 'link'; onError?: (message: string) => void; onSuccess?: () => void; closeMiniApp?: boolean; navigateAfterLogin?: boolean }) {
  const bot = BOT_USERNAME;
  const id = useId().replace(/[^a-z0-9]/gi, '');
  const host = useRef<HTMLDivElement>(null);
  const { auth } = useStores();
  const navigate = useNavigate();

  useEffect(() => {
    if (!bot || !host.current) return;
    let cancelled = false;
    const callback = `telegramAuth_${id}` as const;
    window[callback] = async payload => {
      try {
        const response = await api<{ token_hash?: string }>('/api/auth/telegram', {
          method: 'POST',
          headers: auth.session?.access_token ? { Authorization: `Bearer ${auth.session.access_token}` } : undefined,
          body: JSON.stringify({ ...payload, mode }),
        });
        if (mode === 'login' && response.token_hash) {
          await auth.acceptTelegramToken(response.token_hash);
          navigate('/cabinet', { replace: true });
        }
        onSuccess?.();
      } catch (error) {
        onError?.(error instanceof Error ? error.message : 'Не удалось войти через Telegram');
      }
    };

    async function initialize() {
      let webApp = window.Telegram?.WebApp;
      if (!webApp) {
        await new Promise<void>(resolve => {
          const script = document.createElement('script');
          script.src = 'https://telegram.org/js/telegram-web-app.js?59';
          script.onload = () => resolve();
          script.onerror = () => resolve();
          document.head.appendChild(script);
        });
        webApp = window.Telegram?.WebApp;
      }
      if (cancelled || !host.current) return;
      if (webApp?.initData) {
        webApp.ready();
        webApp.expand();
        host.current.textContent = 'Входим через Telegram…';
        try {
          const response = await api<{ token_hash?: string }>('/api/auth/telegram', {
            method: 'POST',
            headers: auth.session?.access_token ? { Authorization: `Bearer ${auth.session.access_token}` } : undefined,
            body: JSON.stringify({ webAppData: webApp.initData, mode }),
          });
          if (mode === 'login' && response.token_hash) {
            await auth.acceptTelegramToken(response.token_hash);
            if (navigateAfterLogin) navigate('/cabinet', { replace: true });
          }
          onSuccess?.();
          if (closeMiniApp) webApp.close();
        } catch (error) {
          host.current.textContent = '';
          onError?.(error instanceof Error ? error.message : 'Не удалось войти через Telegram');
        }
        return;
      }
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://telegram.org/js/telegram-widget.js?22';
      script.dataset.telegramLogin = bot;
      script.dataset.size = 'large';
      script.dataset.radius = '8';
      script.dataset.userpic = 'false';
      script.dataset.onauth = `${callback}(user)`;
      script.dataset.requestAccess = 'write';
      host.current.replaceChildren(script);
    }
    initialize();
    return () => {
      cancelled = true;
      delete window[callback];
      host.current?.replaceChildren();
    };
  }, [auth, bot, closeMiniApp, id, mode, navigate, navigateAfterLogin, onError, onSuccess]);

  if (!bot) return null;
  return <div ref={host} style={{ display: 'flex', justifyContent: 'center' }} />;
}
