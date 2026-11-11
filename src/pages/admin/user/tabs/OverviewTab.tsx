import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { type AdminUserDetail, useAdminAudit, useAdminUserAction } from '../../../../api/admin';
import { useAccountAction } from '../../../../api/admin-controls';
import { formatDateMsk, int, plural, rub } from '../../../../lib/admin-controls';
import { payerLabel } from '../../../../lib/admin-users';
import { Badge, Button, Card, Field, Input, Select } from '../../../../ui';
import { AuditEntry, ConfirmDialog, DataState, EmptyBlock } from '../../kit';
import { LinkTelegramModal } from '../modals/LinkTelegramModal';
import { OAUTH_LABEL, daysLeft, useQuickRunner, useRunner } from '../shared';
import u from '../user.module.css';

type Unlink = { kind: 'telegram' } | { kind: 'oauth'; provider: 'yandex' | 'mailru' | 'vkid'; label: string };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={u.tile}>
      <span className={u.tileLabel}>{label}</span>
      <span className={u.tileValue}>{value}</span>
      {sub && <span className={u.tileSub}>{sub}</span>}
    </div>
  );
}

function ProfileCard({ detail }: { detail: AdminUserDetail }) {
  const profile = useAdminUserAction<{ userId: string; displayName?: string; phone?: string; payerStatus?: string }>('profile');
  const run = useQuickRunner();
  const [formKey, setFormKey] = useState(0);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(
      profile,
      {
        userId: detail.userId,
        displayName: String(form.get('displayName') || ''),
        phone: String(form.get('phone') || ''),
        payerStatus: String(form.get('payerStatus') || 'individual'),
      },
      'Профиль обновлён',
    );
  };

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>
          Профиль <span className={u.cardSub}>изменения сохраняются в журнал</span>
        </h3>
      </div>
      <form key={formKey} onSubmit={submit}>
        <div className={u.form}>
          <Field label="Имя">
            <Input name="displayName" defaultValue={detail.profile?.display_name ?? ''} maxLength={120} />
          </Field>
          <Field label="Телефон">
            <Input name="phone" type="tel" defaultValue={detail.profile?.phone ?? ''} maxLength={32} />
          </Field>
          <Field label="Статус плательщика" help="Влияет на чеки и выплаты партнёрам">
            <Select name="payerStatus" defaultValue={detail.profile?.payer_status ?? 'individual'}>
              <option value="individual">{payerLabel('individual')}</option>
              <option value="self_employed">{payerLabel('self_employed')}</option>
              <option value="entrepreneur">{payerLabel('entrepreneur')}</option>
            </Select>
          </Field>
        </div>
        <div className={u.formActions}>
          <Button type="button" variant="ghost" onClick={() => setFormKey(key => key + 1)}>
            Отменить
          </Button>
          <Button type="submit" variant="secondary" loading={profile.isPending}>
            Сохранить
          </Button>
        </div>
      </form>
    </Card>
  );
}

function LoginMethodsCard({ detail }: { detail: AdminUserDetail }) {
  const [unlink, setUnlink] = useState<Unlink | null>(null);
  const [linkMode, setLinkMode] = useState<'telegram' | 'site' | null>(null);
  const unlinkTelegram = useAccountAction('unlinkTelegram');
  const unlinkOAuth = useAccountAction('unlinkOAuth');
  const run = useRunner();
  const methods = detail.loginMethods;
  if (!methods) return null;

  const total = (methods.email.address ? 1 : 0) + (methods.telegram ? 1 : 0) + methods.oauth.length;
  // Связать с ботом — только поддержка: аккаунту сайта без Telegram — привязать, аккаунту бота — объединить с сайтом.
  const canLinkTelegram = !methods.telegram && !methods.email.technical;
  const canMergeIntoSite = Boolean(methods.telegram) && methods.email.technical;

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>
          Способы входа <span className={u.cardSub}>подключено: {total}</span>
        </h3>
        {canLinkTelegram && (
          <Button variant="secondary" size="sm" style={{ minHeight: 'var(--tap)' }} onClick={() => setLinkMode('telegram')}>
            Привязать Telegram
          </Button>
        )}
        {canMergeIntoSite && (
          <Button variant="secondary" size="sm" style={{ minHeight: 'var(--tap)' }} onClick={() => setLinkMode('site')}>
            Объединить с аккаунтом сайта
          </Button>
        )}
      </div>
      <div className={u.list}>
        <div className={u.listRow}>
          <div className={u.listMain}>
            <span>Почта{methods.email.address ? ` · ${methods.email.address}` : ''}</span>
            <small>{methods.email.technical ? 'техническая почта Telegram-аккаунта' : methods.email.address ? 'основной способ' : 'не указана'}</small>
          </div>
          {methods.email.address && (
            <Badge tone={methods.email.confirmed ? 'success' : 'warning'}>{methods.email.confirmed ? 'подтверждена' : 'не подтверждена'}</Badge>
          )}
        </div>
        {methods.telegram && (
          <div className={u.listRow}>
            <div className={u.listMain}>
              <span>Telegram{methods.telegram.username ? ` · @${methods.telegram.username}` : ''}</span>
              <small>
                ID {methods.telegram.telegramUserId} · привязан {formatDateMsk(methods.telegram.linkedAt)}
              </small>
            </div>
            <Badge tone={methods.telegram.bot.blockedAt ? 'error' : methods.telegram.bot.started ? 'success' : 'default'}>
              {methods.telegram.bot.blockedAt ? 'бот заблокирован' : methods.telegram.bot.started ? 'бот запущен' : 'бот не запущен'}
            </Badge>
            <Button variant="ghost" size="sm" style={{ minHeight: 'var(--tap)' }} onClick={() => setUnlink({ kind: 'telegram' })}>
              Отвязать
            </Button>
          </div>
        )}
        {methods.oauth.map(item => {
          const label = OAUTH_LABEL[item.provider] ?? item.provider;
          return (
            <div className={u.listRow} key={item.provider}>
              <div className={u.listMain}>
                <span>
                  {label}
                  {item.email ? ` · ${item.email}` : item.displayName ? ` · ${item.displayName}` : ''}
                </span>
                <small>привязан {formatDateMsk(item.linkedAt)}</small>
              </div>
              <Button
                variant="ghost"
                size="sm"
                style={{ minHeight: 'var(--tap)' }}
                onClick={() => setUnlink({ kind: 'oauth', provider: item.provider, label })}
              >
                Отвязать
              </Button>
            </div>
          );
        })}
      </div>

      {linkMode && (
        <LinkTelegramModal open={linkMode !== null} onOpenChange={open => !open && setLinkMode(null)} detail={detail} mode={linkMode} />
      )}

      <ConfirmDialog
        open={unlink !== null}
        onOpenChange={open => !open && setUnlink(null)}
        title={unlink?.kind === 'oauth' ? `Отвязать ${unlink.label}?` : 'Отвязать Telegram?'}
        description={
          unlink?.kind === 'oauth'
            ? 'Пользователь не сможет входить этим способом. Последний способ входа отвязать нельзя.'
            : 'Перестанут приходить уведомления бота и подтверждения кода клиента через бот.'
        }
        confirmLabel="Отвязать"
        tone="danger"
        requireReason
        onConfirm={({ reason }) =>
          unlink?.kind === 'oauth'
            ? run(unlinkOAuth, { userId: detail.userId, provider: unlink.provider, reason }, `${unlink.label} отвязан`)
            : run(unlinkTelegram, { userId: detail.userId, reason }, 'Telegram отвязан')
        }
      />
    </Card>
  );
}

function RecentEvents({ userId, onOpenLog }: { userId: string; onOpenLog: () => void }) {
  const audit = useAdminAudit({ userId, limit: 3 });
  const items = audit.data?.pages.flatMap(page => page.items);
  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>Последние события</h3>
        <Button variant="ghost" size="sm" style={{ minHeight: 'var(--tap)' }} onClick={onOpenLog}>
          Весь журнал пользователя <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </div>
      <DataState
        query={{ data: items, isPending: audit.isPending, isError: audit.isError, error: audit.error, refetch: audit.refetch }}
        isEmpty={list => list.length === 0}
        empty={<EmptyBlock title="Событий пока нет" text="Здесь появятся действия администраторов с этим аккаунтом." />}
      >
        {list => (
          <div className={u.list}>
            {list.slice(0, 3).map(entry => (
              <AuditEntry key={entry.id} entry={entry} showUser={false} compact />
            ))}
          </div>
        )}
      </DataState>
    </Card>
  );
}

export function OverviewTab({ detail, onOpenLog }: { detail: AdminUserDetail; onOpenLog: () => void }) {
  const paid = (detail.orders ?? []).filter(order => order.status === 'succeeded');
  const paidKopecks = paid.reduce((sum, order) => sum + Math.round(Number(order.amount) * 100), 0);
  const days = daysLeft(new Date().toISOString(), Date.parse(detail.createdAt));
  const limits = detail.app?.limits;
  const codes = detail.unlimited?.active
    ? 'без лимита'
    : limits
      ? `${int(limits.codesUsed)} из ${int(limits.codesLimit)}`
      : detail.app?.entitlements?.codes_limit != null
        ? `${int(detail.app.entitlements.codes_used ?? 0)} из ${int(detail.app.entitlements.codes_limit)}`
        : '—';

  return (
    <div className={u.tabBody}>
      <div className={u.tiles}>
        <Tile
          label="Зарегистрирован"
          value={formatDateMsk(detail.createdAt)}
          sub={days !== null ? `${days} ${plural(days, ['день', 'дня', 'дней'])} с нами` : undefined}
        />
        <Tile label="Оплачено" value={`${paid.length} ${plural(paid.length, ['заказ', 'заказа', 'заказов'])}`} sub={`на ${rub(paidKopecks)}`} />
        <Tile
          label="Кошелёк"
          value={rub(detail.wallet?.balanceKopecks ?? 0)}
          sub={detail.wallet?.updatedAt ? `последнее движение ${formatDateMsk(detail.wallet.updatedAt)}` : undefined}
        />
        <Tile
          label="Рефералы"
          value={`${detail.referral?.invited ?? 0} · ${rub(detail.referral?.earnedKopecks ?? 0)}`}
          sub="приглашено · заработано"
        />
        <Tile label="Подборов в этом месяце" value={codes} />
      </div>

      <ProfileCard detail={detail} />
      <LoginMethodsCard detail={detail} />
      <RecentEvents userId={detail.userId} onOpenLog={onOpenLog} />
    </div>
  );
}
