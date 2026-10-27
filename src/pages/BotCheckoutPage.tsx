import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { TelegramLogin } from '../auth/TelegramLogin';
import { MAX_TOPUP, MIN_TOPUP, topupBonus } from '../lib/pricing';
import { rememberPendingOrder } from '../lib/pending-orders';
import { useStores } from '../stores/root-store';
import { Alert, Button, Card, Spinner } from '../ui';

export const BotCheckoutPage = observer(() => {
  const [params] = useSearchParams();
  const { auth } = useStores();
  const started = useRef(false);
  const [error, setError] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');
  // ?kind=topup&amount=N — пополнение баланса из бота, иначе пакет генераций стикеров (?quantity=N).
  const topup = params.get('kind') === 'topup';
  const amount = Number(params.get('amount'));
  // «Пополнить и купить»: что бот купит сам после оплаты и какой экран обновит (проверяет сервер).
  const then = params.get('then') || '';
  const screen = Number(params.get('m') || 0);
  const kopecks = Math.round(amount * 100);
  const valid = topup && Number.isFinite(amount) && Math.abs(kopecks - amount * 100) < 1e-6 && amount >= MIN_TOPUP && amount <= MAX_TOPUP;
  const bonus = topup && valid ? topupBonus(amount) : 0;

  useEffect(() => {
    if (!valid || !auth.isAuthenticated || started.current) return;
    started.current = true;
    api<{ confirmationUrl: string; token: string }>('/api/payments/create', {
      method: 'POST',
      body: JSON.stringify(
        topup
          ? { productKind: 'wallet_topup', walletAmount: amount, walletThen: then || undefined, walletMessage: screen || undefined, accepted: true, returnTo: 'telegram' }
          : {},
      ),
    }).then(data => {
      rememberPendingOrder(localStorage, data.token);
      setPaymentUrl(data.confirmationUrl);
    }).catch(reason => {
      started.current = false;
      setError(reason instanceof Error ? reason.message : 'Не удалось открыть оплату');
    });
  }, [amount, auth.isAuthenticated, screen, then, topup, valid]);

  return (
    <Card>
      <div className="stack" style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0 }}>{topup ? 'Пополнение баланса' : 'Оплата пакета'}</h1>
        {topup && valid && (
          <p style={{ margin: 0 }}>
            Оплата <strong>{amount} ₽</strong> — на баланс зачислим <strong>{amount + bonus} ₽</strong>
            {bonus > 0 && <> (бонус {bonus} ₽)</>}
          </p>
        )}
        {topup && valid && then && <p className="muted" style={{ margin: 0 }}>После оплаты бот сам завершит покупку.</p>}
        {!valid && <Alert tone="error">{topup ? `Сумма должна быть от ${MIN_TOPUP} до 50 000 ₽.` : 'Выбран неизвестный пакет.'} Вернитесь в бот и повторите выбор.</Alert>}
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
