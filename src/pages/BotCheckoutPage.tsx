import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { TelegramLogin } from '../auth/TelegramLogin';
import { getPack, PACKAGE_PRICES } from '../lib/pricing';
import { rememberPendingOrder } from '../lib/pending-orders';
import { useStores } from '../stores/root-store';
import { Alert, Button, Card, Spinner } from '../ui';

export const BotCheckoutPage = observer(() => {
  const [params] = useSearchParams();
  const { auth } = useStores();
  const started = useRef(false);
  const [error, setError] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');
  const quantity = Number(params.get('quantity'));
  const valid = Number.isInteger(quantity) && PACKAGE_PRICES[quantity] !== undefined;
  const pack = valid ? getPack(quantity) : null;

  useEffect(() => {
    if (!valid || !auth.isAuthenticated || started.current) return;
    started.current = true;
    api<{ confirmationUrl: string; token: string }>('/api/payments/create', {
      method: 'POST',
      body: JSON.stringify({ productKind: 'stickers', quantity, accepted: true, returnTo: 'telegram' }),
    }).then(data => {
      rememberPendingOrder(localStorage, data.token);
      setPaymentUrl(data.confirmationUrl);
    }).catch(reason => {
      started.current = false;
      setError(reason instanceof Error ? reason.message : 'Не удалось открыть оплату');
    });
  }, [auth.isAuthenticated, quantity, valid]);

  return (
    <Card>
      <div className="stack" style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0 }}>Оплата пакета</h1>
        {pack && <p style={{ margin: 0 }}>{pack.quantity} шт. — <strong>{pack.total} ₽</strong></p>}
        {!valid && <Alert tone="error">Выбран неизвестный пакет. Вернитесь в бот и повторите выбор.</Alert>}
        {valid && auth.status === 'initializing' && <><Spinner /><p className="muted">Проверяем вход…</p></>}
        {valid && auth.status === 'anonymous' && (
          <>
            <p className="muted">Входим через Telegram для привязки покупки…</p>
            <TelegramLogin closeMiniApp={false} navigateAfterLogin={false} onError={setError} />
          </>
        )}
        {valid && auth.isAuthenticated && !error && !paymentUrl && <><Spinner /><p className="muted">Подготавливаем защищённую оплату ЮKassa…</p></>}
        {paymentUrl && (
          <>
            <p className="muted" style={{ margin: 0 }}>Платёж готов. Он откроется во внешнем браузере, чтобы приложение банка работало корректно.</p>
            <Button
              onClick={() => {
                const webApp = window.Telegram?.WebApp;
                if (webApp?.initData && typeof webApp.openLink === 'function') {
                  webApp.openLink(paymentUrl);
                  // Оплата уже открыта во внешнем браузере. Закрываем Mini App,
                  // чтобы после банка пользователь вернулся в сам чат, а не в это окно.
                  window.setTimeout(() => webApp.close(), 250);
                } else location.assign(paymentUrl);
              }}
            >
              Перейти к оплате
            </Button>
          </>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Card>
  );
});
