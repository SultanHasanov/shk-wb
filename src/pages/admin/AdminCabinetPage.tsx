import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type AdminWithdrawal,
  useAdminNews, useAdminTelegramAudience, useAdminTelegramBroadcast,
  useAdminWithdrawals, useAdminWithdrawalUpdate,
} from '../../api/admin';
import { dateTime, money } from '../../api/cabinet';
import { withdrawalStatusLabel } from '../../lib/admin-users';
import {
  Alert, Badge, Button, Card, Checkbox, Field, Input, Textarea, useToast,
} from '../../ui';
import { ConfirmDialog, DataState, EmptyBlock, ResponsiveTable, useIdempotencyKey } from './kit';
import type { ResponsiveColumn } from './kit';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  paid: 'success', approved: 'warning', pending: 'default', rejected: 'error', canceled: 'error',
};

type WithdrawalStatus = 'approved' | 'paid' | 'rejected';

/**
 * Переходы заявки — как в rpc process_referral_withdrawal: из «ждёт решения» только
 * «одобрить»/«отклонить», «выплачено» — только после одобрения. Раньше кнопка
 * «Выплачено» была и у новой заявки, и сервер отвечал ошибкой.
 */
const WITHDRAWAL_ACTIONS: Record<string, ReadonlyArray<WithdrawalStatus>> = {
  pending: ['approved', 'rejected'],
  approved: ['paid', 'rejected'],
};

const ACTION_TEXT: Record<WithdrawalStatus, { button: string; title: string; confirm: string; effect: string; danger?: boolean }> = {
  approved: {
    button: 'Одобрить',
    title: 'Одобрить заявку?',
    confirm: 'Одобрить',
    effect: 'Заявка перейдёт в «Одобрена». Деньги отправляете вы сами, затем отметьте «Выплачено».',
  },
  paid: {
    button: 'Выплачено',
    title: 'Отметить как выплаченную?',
    confirm: 'Отметить выплаченной',
    effect: 'Подтверждаете, что перевод по СБП уже отправлен. Статус увидит пользователь.',
  },
  rejected: {
    button: 'Отклонить',
    title: 'Отклонить заявку?',
    confirm: 'Отклонить',
    effect: 'Сумма вернётся на реферальный баланс пользователя.',
    danger: true,
  },
};

/**
 * Два раздела меню на одной странице: «Выплаты» (реферальные заявки) и «Рассылки»
 * (Telegram-бот и новость в кабинет). В старой админке оба блока лежали внутри
 * формы логина и грузились до входа, получая 401.
 */
export function AdminCabinetPage({ section = 'withdrawals' }: { section?: 'withdrawals' | 'broadcasts' }) {
  return (
    <div className="page stack-lg">
      {section === 'withdrawals' ? <Withdrawals /> : <Broadcasts />}
    </div>
  );
}

/* ============ Выплаты ============ */

function Withdrawals() {
  const toast = useToast();
  const withdrawals = useAdminWithdrawals();
  const update = useAdminWithdrawalUpdate();
  const [pending, setPending] = useState<{ item: AdminWithdrawal; status: WithdrawalStatus } | null>(null);

  const columns: ResponsiveColumn<AdminWithdrawal>[] = [
    { key: 'amount', header: 'Сумма', primary: true, cell: item => <span className={p.num}>{money(item.amount_kopecks)}</span> },
    { key: 'date', header: 'Дата', cell: item => dateTime(item.created_at) },
    {
      key: 'where',
      header: 'Куда',
      cell: item => (
        <span>
          {item.bank_name}
          <div className={s.mutedNote}>{item.sbp_phone}</div>
        </span>
      ),
    },
    {
      key: 'user',
      header: 'Пользователь',
      cell: item =>
        item.user_id ? (
          <Link to={`/panel/users/${item.user_id}`} className={p.mono}>
            {item.user_id.slice(0, 8)}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'status',
      header: 'Статус',
      cell: item => (
        <span>
          <Badge tone={STATUS_TONE[item.status] ?? 'default'}>{withdrawalStatusLabel(item.status)}</Badge>
          {item.admin_note && <div className={s.mutedNote}>{item.admin_note}</div>}
        </span>
      ),
    },
  ];

  const text = pending ? ACTION_TEXT[pending.status] : null;

  return (
    <section className="stack">
      <h3 className={p.sectionTitle}>Заявки на выплату</h3>
      <DataState
        query={withdrawals}
        isEmpty={rows => rows.length === 0}
        empty={<EmptyBlock title="Заявок нет" text="Здесь появятся запросы на вывод реферального баланса." />}
      >
        {rows => (
          <ResponsiveTable
            rows={rows}
            columns={columns}
            rowKey={item => item.id}
            rowActions={item => {
              const actions = WITHDRAWAL_ACTIONS[item.status];
              if (!actions) return null;
              return actions.map(status => (
                <Button
                  key={status}
                  variant={status === 'rejected' ? 'ghost' : 'secondary'}
                  size="sm"
                  className={p.tap}
                  onClick={() => setPending({ item, status })}
                >
                  {ACTION_TEXT[status].button}
                </Button>
              ));
            }}
          />
        )}
      </DataState>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={open => !open && setPending(null)}
        title={text?.title ?? ''}
        confirmLabel={text?.confirm ?? ''}
        tone={text?.danger ? 'danger' : 'default'}
        requireReason
        reasonPlaceholder="Например: перевод отправлен 10.11 в 14:20"
        onConfirm={async ({ reason }) => {
          if (!pending) return;
          // reason уходит в журнал админки; клиенту она не видна.
          const body = { id: pending.item.id, status: pending.status, reason };
          await update.mutateAsync(body);
          toast('Статус заявки обновлён', 'success');
        }}
      >
        {pending && text && (
          <>
            <dl className={p.dialogFacts}>
              <dt>Сумма</dt>
              <dd>{money(pending.item.amount_kopecks)}</dd>
              <dt>Куда</dt>
              <dd>
                {pending.item.bank_name} · {pending.item.sbp_phone}
              </dd>
              <dt>Сейчас</dt>
              <dd>{withdrawalStatusLabel(pending.item.status)}</dd>
            </dl>
            <p className={s.mutedNote}>{text.effect}</p>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}

/* ============ Рассылки ============ */

type TelegramDraft = { text: string; button: string; url: string; removeKeyboard: boolean; onlyLegacy: boolean };
type NewsDraft = { title: string; body: string; link: string };

function Broadcasts() {
  const toast = useToast();
  const news = useAdminNews();
  const telegramAudience = useAdminTelegramAudience();
  const telegramBroadcast = useAdminTelegramBroadcast();
  // Снятие старой нижней клавиатуры уходит отдельным служебным сообщением (сервер), кнопка остаётся под основным.
  const [removeKeyboard, setRemoveKeyboard] = useState(false);
  const [onlyLegacy, setOnlyLegacy] = useState(false);
  const [telegramDraft, setTelegramDraft] = useState<(TelegramDraft & { form: HTMLFormElement }) | null>(null);
  const [newsDraft, setNewsDraft] = useState<(NewsDraft & { form: HTMLFormElement }) | null>(null);
  // Ключ повтора создаётся при открытии окна: повторное нажатие после сбоя сети не разошлёт второй раз.
  const telegramKey = useIdempotencyKey(telegramDraft !== null);
  const newsKey = useIdempotencyKey(newsDraft !== null);
  const audience = telegramAudience.data;
  const legacyDate = audience?.legacyBefore ? new Date(audience.legacyBefore).toLocaleDateString('ru-RU') : '';
  const recipients = (telegramDraft?.onlyLegacy ? audience?.legacy : audience?.available) ?? 0;

  return (
    <>
      <Card>
        <h3>Рассылка в Telegram-боте</h3>
        <p className={s.mutedNote}>
          Активировали бота: <b>{audience?.activated ?? '—'}</b>. Доступно для рассылки:{' '}
          <b>{audience?.available ?? '—'}</b>
          {audience?.blocked ? ` · заблокировали бота: ${audience.blocked}` : ''}.
          Каждому человеку уйдёт отдельное сообщение.
        </p>
        <form
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const formElement = event.currentTarget;
            const form = new FormData(formElement);
            setTelegramDraft({
              text: String(form.get('text') || ''),
              button: String(form.get('button') || ''),
              url: String(form.get('url') || ''),
              removeKeyboard,
              onlyLegacy,
              form: formElement,
            });
          }}
        >
          <Field label="Текст" help="Переменные: {name}, {first_name}, {last_name}, {username}">
            <Textarea name="text" rows={5} maxLength={3500} placeholder="Здравствуйте, {name}!" required />
          </Field>
          <Field label="Подпись кнопки (необязательно)" help="Под рассылкой всегда есть «☰ Меню», ваша кнопка-ссылка — над ней"><Input name="button" maxLength={64} /></Field>
          <Field label="HTTPS-ссылка кнопки (необязательно)"><Input name="url" type="url" /></Field>
          <Checkbox checked={removeKeyboard} onChange={event => setRemoveKeyboard(event.currentTarget.checked)}>
            Убрать у получателей старую нижнюю клавиатуру
          </Checkbox>
          <Checkbox checked={onlyLegacy} onChange={event => setOnlyLegacy(event.currentTarget.checked)}>
            Только активировавшим бота до {legacyDate || '…'} — у них ещё старая клавиатура
            {audience ? ` (${audience.legacy} чел.)` : ''}
          </Checkbox>
          <Button type="submit" className={p.tap} disabled={!audience?.available}>
            Отправить в Telegram
          </Button>
        </form>
        {telegramAudience.isError && <Alert tone="error">Не удалось загрузить аудиторию бота.</Alert>}
      </Card>

      <Card>
        <h3>Новость пользователям кабинета</h3>
        <p className={s.mutedNote}>
          Уйдёт всем, кто не отключил новости о продукте: уведомлением в кабинете и письмом.
        </p>
        <form
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const formElement = event.currentTarget;
            const form = new FormData(formElement);
            setNewsDraft({
              title: String(form.get('title') || ''),
              body: String(form.get('body') || ''),
              link: String(form.get('link') || ''),
              form: formElement,
            });
          }}
        >
          <Field label="Заголовок"><Input name="title" maxLength={160} required /></Field>
          <Field label="Текст"><Textarea name="body" rows={4} maxLength={2000} required /></Field>
          <Field label="Ссылка"><Input name="link" /></Field>
          <Button type="submit" className={p.tap}>Отправить всем</Button>
        </form>
      </Card>

      <ConfirmDialog
        open={telegramDraft !== null}
        onOpenChange={open => !open && setTelegramDraft(null)}
        title="Отправить рассылку в Telegram?"
        description="Отменить отправленное нельзя."
        confirmLabel={`Отправить ${recipients} получателям`}
        tone="danger"
        requireReason
        reasonPlaceholder="Например: анонс новой версии Помощника"
        onConfirm={async ({ reason }) => {
          if (!telegramDraft) return;
          const { form, ...draft } = telegramDraft;
          const result = await telegramBroadcast.mutateAsync({ ...draft, idempotencyKey: telegramKey, reason });
          toast(
            `Отправлено: ${result.sent}. Ошибок: ${result.failed}. Недоступны: ${result.blocked}.`,
            result.failed ? 'default' : 'success',
          );
          if (!result.failed) {
            form.reset();
            setRemoveKeyboard(false);
            setOnlyLegacy(false);
          }
        }}
      >
        {telegramDraft && (
          <ul className={p.effects}>
            <li>
              Получателей: <b>{recipients}</b>
              {telegramDraft.onlyLegacy ? ` — только активировавшие бота до ${legacyDate || '…'}` : ''}
            </li>
            <li>Текст: «{telegramDraft.text.slice(0, 160)}{telegramDraft.text.length > 160 ? '…' : ''}»</li>
            {telegramDraft.button && telegramDraft.url && <li>Кнопка «{telegramDraft.button}» → {telegramDraft.url}</li>}
            {telegramDraft.removeKeyboard && <li>Старая нижняя клавиатура у получателей будет убрана</li>}
          </ul>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={newsDraft !== null}
        onOpenChange={open => !open && setNewsDraft(null)}
        title="Отправить новость всем?"
        description="Уведомление в кабинете и письмо всем, кто не отключил новости. Отменить отправленное нельзя."
        confirmLabel="Отправить всем"
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!newsDraft) return;
          const { form, ...draft } = newsDraft;
          const result = await news.mutateAsync({ ...draft, idempotencyKey: newsKey, reason });
          toast(`Отправлено: ${result.sent}`, 'success');
          form.reset();
        }}
      >
        {newsDraft && (
          <dl className={p.dialogFacts}>
            <dt>Заголовок</dt>
            <dd>{newsDraft.title}</dd>
            {newsDraft.link && (
              <>
                <dt>Ссылка</dt>
                <dd>{newsDraft.link}</dd>
              </>
            )}
          </dl>
        )}
      </ConfirmDialog>
    </>
  );
}
