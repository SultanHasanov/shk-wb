import { useEffect } from 'react';
import { SUPPORT_URL } from '../lib/telegram';
import { Alert, Button, Card } from '../ui';

/**
 * Старая кнопка «Подключить основной кабинет» / «У меня уже есть кабинет» из сообщений бота.
 * Связать аккаунт сайта с ботом теперь может только поддержка (админка, server/_admin-link.js):
 * api/auth.js на прежние режимы merge / relink / prepare_merge отвечает TELEGRAM_LINK_VIA_SUPPORT.
 * Страница остаётся, чтобы кнопки в старых сообщениях вели не в ошибку, а к поддержке.
 */
export function TelegramAccountPage() {
  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    webApp?.ready();
    webApp?.expand();
  }, []);

  const openSupport = () => {
    const webApp = window.Telegram?.WebApp;
    if (webApp?.openTelegramLink) webApp.openTelegramLink(SUPPORT_URL);
    else window.open(SUPPORT_URL, '_blank', 'noopener,noreferrer');
  };
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);

  return (
    <Card>
      <div className="stack">
        <h1 style={{ fontSize: 'var(--fs-24)', margin: 0 }}>Аккаунт сайта и бот</h1>
        <Alert tone="info">
          Связать аккаунт сайта с ботом может поддержка — напишите нам. Баланс и покупки сохранятся и станут общими.
        </Alert>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
          Назовите поддержке почту аккаунта на сайте и ваш Telegram ID — он есть в боте, в разделе «Профиль».
        </p>
        <Button type="button" size="lg" block onClick={openSupport}>
          Написать в поддержку
        </Button>
        {inTelegram && (
          <Button type="button" variant="secondary" block onClick={() => window.Telegram?.WebApp?.close()}>
            Вернуться в бот
          </Button>
        )}
      </div>
    </Card>
  );
}
