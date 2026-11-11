import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AdminUserDetail } from '../../../../api/admin';
import {
  type LinkTelegramAccount,
  type LinkTelegramOutcome,
  type LinkTelegramPreview,
  fetchLinkTelegramPreview,
  useLinkTelegram,
} from '../../../../api/admin-controls';
import { formatDateMsk, rub } from '../../../../lib/admin-controls';
import { Alert, Badge, Button, Checkbox, Field, Input, Modal, Textarea, useToast } from '../../../../ui';
import { REASON_MAX, errorText, useConfirmAction, useIdempotencyKey } from '../../kit';
import { modalSubtitle } from '../shared';
import u from '../user.module.css';

/**
 * «Связать с Telegram» (план A1): поддержка связывает аккаунт сайта с Telegram-ботом.
 * mode='telegram' — карточка аккаунта сайта, ищем Telegram по ID или @нику;
 * mode='site' — карточка аккаунта бота, ищем аккаунт сайта по почте.
 * Ввод → две колонки предпросмотра → предупреждения → причина. Исход пересчитывает сервер.
 */

export const OUTCOME_TEXT: Record<LinkTelegramPreview['outcome'], string> = {
  new_identity: 'Привяжем Telegram к аккаунту сайта. У Telegram своего аккаунта нет — переносить нечего.',
  relink: 'Аккаунт бота пустой: Telegram перейдёт к аккаунту сайта, пустой аккаунт удалим.',
  merge: 'Объединим: баланс, покупки, подписки и ПК аккаунта бота перейдут к аккаунту сайта, аккаунт бота удалим.',
  move_identity: 'Telegram привязан к другому аккаунту с почтой: перейдёт только привязка Telegram, данные того аккаунта останутся при нём.',
  already_linked: 'Этот Telegram уже привязан к этому аккаунту — делать ничего не нужно.',
};

const SUBMIT_LABEL: Record<LinkTelegramOutcome, string> = {
  new_identity: 'Привязать Telegram',
  relink: 'Привязать Telegram',
  merge: 'Объединить аккаунты',
  move_identity: 'Перенести привязку',
};

function AccountBox({ title, account, extra }: { title: string; account: LinkTelegramAccount | null; extra?: string }) {
  const s = account?.summary;
  return (
    <section className={u.box} aria-label={title}>
      <div className={u.boxHead}>
        <h3>{title}</h3>
        {account && <Badge tone={account.technical ? 'default' : 'accent'}>{account.technical ? 'аккаунт бота' : 'аккаунт сайта'}</Badge>}
      </div>
      {extra && <p className={u.muted}>{extra}</p>}
      {account ? (
        <dl className={u.dl}>
          <dt>Почта</dt>
          <dd>{account.email ?? (account.technical ? 'нет (создан ботом)' : '—')}</dd>
          {account.createdAt && (
            <>
              <dt>Создан</dt>
              <dd>{formatDateMsk(account.createdAt)}</dd>
            </>
          )}
          {s && (
            <>
              <dt>Баланс</dt>
              <dd>{rub(Number(s.walletKopecks ?? 0))}</dd>
              <dt>Покупки</dt>
              <dd>
                оплачено заказов: {Number(s.paidOrders ?? 0)}
                {Number(s.activeSubscriptions ?? 0) > 0 ? ' · есть подписка' : ''}
              </dd>
              <dt>ПК и пункты</dt>
              <dd>
                ПК: {Number(s.devices ?? 0) + Number(s.cellPrintDevices ?? 0)} · пунктов: {Number(s.points ?? 0)}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className={u.muted}>Аккаунта нет — Telegram просто привяжется.</p>
      )}
    </section>
  );
}

export function LinkTelegramModal({
  open,
  onOpenChange,
  detail,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AdminUserDetail;
  mode: 'telegram' | 'site';
}) {
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<LinkTelegramPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmMove, setConfirmMove] = useState(false);
  const key = useIdempotencyKey(open);
  const { pending, error, run, guardedOpenChange } = useConfirmAction(open, onOpenChange);
  const link = useLinkTelegram();
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setQuery('');
      setPreview(null);
      setLookupError(null);
      setReason('');
      setConfirmMove(false);
    }
  }, [open]);

  const lookup = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = query.trim();
    if (!value || loading) return;
    setLoading(true);
    setLookupError(null);
    setPreview(null);
    setConfirmMove(false);
    try {
      setPreview(await fetchLinkTelegramPreview(detail.userId, value));
    } catch (err) {
      setLookupError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  const outcome = preview && preview.outcome !== 'already_linked' ? preview.outcome : null;
  const blocked = !preview || !outcome || preview.blockers.length > 0;
  const reasonOk = reason.trim().length > 0;
  const moveOk = !preview?.needsMoveConfirm || confirmMove;
  const canSubmit = !blocked && reasonOk && moveOk && !pending;

  const submit = () => {
    if (!canSubmit || !preview || !outcome) return;
    void run(async () => {
      const result = await link.mutateAsync({
        userId: preview.request.userId,
        telegramUserId: preview.request.telegramUserId,
        expected: outcome,
        ...(preview.needsMoveConfirm ? { confirmMove: true } : {}),
        reason: reason.trim(),
        idempotencyKey: key,
      });
      toast(
        result.delivered ? 'Связано — человеку пришло сообщение в боте' : 'Связано, но сообщение в бот не доставлено',
        result.delivered && !result.sourceKept ? 'success' : 'default',
      );
      if (result.warning && result.sourceKept) toast(result.warning, 'error');
      // Аккаунт бота после объединения удалён — открываем карточку аккаунта сайта.
      if (mode === 'site' && preview.request.userId !== detail.userId) navigate(`/panel/users/${preview.request.userId}`);
    });
  };

  const telegram = preview?.telegram;
  const telegramName = telegram
    ? [telegram.username ? `@${telegram.username}` : null, [telegram.firstName, telegram.lastName].filter(Boolean).join(' ') || null, `ID ${telegram.telegramUserId}`]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <Modal
      open={open}
      onOpenChange={guardedOpenChange}
      title={mode === 'site' ? 'Объединить с аккаунтом сайта' : 'Привязать Telegram'}
      description={modalSubtitle(detail)}
      size="lg"
      sheet
      footer={
        <div className={u.foot}>
          <span className={u.footHint} aria-live="polite">
            {!preview
              ? mode === 'site' ? 'Найдите аккаунт сайта по почте' : 'Найдите Telegram по ID или @нику'
              : blocked
                ? 'Связать нельзя — см. выше'
                : !moveOk
                  ? 'Подтвердите перенос привязки'
                  : reasonOk ? 'Запишем в журнал, человеку придёт сообщение в боте' : 'Укажите причину'}
          </span>
          <Button variant="secondary" onClick={() => guardedOpenChange(false)} disabled={pending}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!canSubmit} loading={pending}>
            {outcome ? SUBMIT_LABEL[outcome] : 'Связать'}
          </Button>
        </div>
      }
    >
      <div className={u.modalBody}>
        <form className={u.form} onSubmit={event => void lookup(event)}>
          <Field
            label={mode === 'site' ? 'Почта аккаунта сайта' : 'Telegram ID или @ник'}
            help={mode === 'site' ? 'С этим аккаунтом объединим аккаунт бота' : 'ID человек видит в боте, в «Профиле»'}
          >
            <Input
              value={query}
              type={mode === 'site' ? 'email' : 'text'}
              inputMode={mode === 'site' ? 'email' : 'text'}
              maxLength={120}
              onChange={event => setQuery(event.target.value)}
              disabled={pending}
            />
          </Field>
          <div className={u.formActions}>
            <Button type="submit" variant="secondary" loading={loading} disabled={!query.trim() || pending}>
              Проверить
            </Button>
          </div>
        </form>

        {lookupError && <Alert tone="error">{lookupError}</Alert>}

        {preview && (
          <>
            <Alert tone={preview.blockers.length ? 'warning' : 'info'}>{OUTCOME_TEXT[preview.outcome]}</Alert>
            <div className={u.form}>
              <AccountBox title="Аккаунт сайта" account={preview.target} />
              <AccountBox
                title="Telegram и его аккаунт"
                account={preview.source}
                extra={`${telegramName}${telegram && !telegram.botStarted ? ' · бота не запускал' : telegram?.botBlocked ? ' · бот заблокирован' : ''}`}
              />
            </div>

            {preview.blockers.length > 0 && (
              <Alert tone="error">
                <ul className={u.effects}>
                  {preview.blockers.map(item => (
                    <li key={item.code}>{item.message}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {preview.warnings.length > 0 && (
              <Alert tone="warning">
                <ul className={u.effects}>
                  {preview.warnings.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </Alert>
            )}

            {!blocked && preview.needsMoveConfirm && (
              <Checkbox id="link-move-confirm" checked={confirmMove} onChange={event => setConfirmMove(event.target.checked)}>
                Понимаю: прежний аккаунт с почтой останется без Telegram, его баланс и покупки к этому аккаунту не перейдут
              </Checkbox>
            )}

            {!blocked && (
              <Field label="Причина для журнала *" help="Например: запрос в поддержку от 11.11, подтвердил по Telegram ID">
                <Textarea rows={2} value={reason} maxLength={REASON_MAX} onChange={event => setReason(event.target.value)} />
              </Field>
            )}
          </>
        )}

        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
