import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { AdminUserDetail } from '../../../api/admin';
import { Badge } from '../../../ui';
import { formatMskDateTime } from '../../../lib/admin-audit';
import { formatDateMsk, scopesLabel } from '../../../lib/admin-controls';
import { OAUTH_LABEL, PLAN_LABEL, displayNameOf, realEmail } from './shared';
import u from './user.module.css';

function initials(name: string): string {
  const parts = name.replace(/^@/, '').split(/[\s._@-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  return (letters || name.slice(0, 2)).toUpperCase();
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** «сегодня 14:02» / «08.11.2026 14:02» по Москве. */
function lastSeen(iso: string | null): string {
  if (!iso) return 'не входил';
  return formatMskDateTime(iso);
}

/** Шапка карточки: кто это, как связаться, что у него есть и как он входит. */
export function UserHeader({ detail }: { detail: AdminUserDetail }) {
  const [copied, setCopied] = useState(false);
  const name = displayNameOf(detail);
  const email = realEmail(detail);
  const tg = detail.loginMethods?.telegram?.username ?? detail.telegram?.username ?? null;
  const ent = detail.app?.entitlements;
  const plan = ent?.plan ? PLAN_LABEL[ent.plan] ?? ent.plan : null;
  const paying = (detail.orders ?? []).some(order => order.status === 'succeeded');
  const restriction = detail.restriction;

  const methods: string[] = [];
  if (detail.loginMethods) {
    if (detail.loginMethods.email.address) methods.push('почта');
    if (detail.loginMethods.telegram) methods.push('Telegram');
    for (const item of detail.loginMethods.oauth ?? []) methods.push(OAUTH_LABEL[item.provider] ?? item.provider);
  }

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(detail.userId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* буфер обмена недоступен (http, старый браузер) — ID виден в подсказке */
    }
  };

  return (
    <section className={u.head} aria-label="Пользователь">
      <span className={u.avatar} aria-hidden="true">
        {initials(name)}
      </span>
      <div className={u.headMain}>
        <div className={u.nameRow}>
          <h2 className={u.name}>{name}</h2>
          <button type="button" className={u.idChip} onClick={copy} title={detail.userId} aria-label={`Скопировать ID ${detail.userId}`}>
            ID {shortId(detail.userId)}
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            <span role="status" className={copied ? undefined : 'sr-only'}>
              {copied ? 'Скопировано' : ''}
            </span>
          </button>
        </div>

        <div className={u.contacts}>
          {email ? (
            <span>
              <b>{email}</b>{' '}
              {detail.emailConfirmed ? <span className={u.ok}>почта подтверждена</span> : <span>почта не подтверждена</span>}
            </span>
          ) : detail.telegramOnly ? (
            <span>Только Telegram</span>
          ) : null}
          {detail.profile?.phone && <span className={u.dot}>{detail.profile.phone}</span>}
          {tg && <span className={u.dot}>Telegram @{tg}</span>}
        </div>

        <div className={u.badges}>
          {paying && <Badge tone="success">Платит</Badge>}
          {plan && <Badge tone="accent">Помощник · {plan}{ent?.ends_at ? ` до ${formatDateMsk(ent.ends_at).slice(0, 5)}` : ''}</Badge>}
          {detail.partner && <Badge>Партнёр: {detail.partner.name}{detail.partner.active ? '' : ' (выключен)'}</Badge>}
          {restriction && !restriction.expired && <Badge tone="error">Ограничена: {scopesLabel(restriction.scopes)}</Badge>}
          {restriction?.expired && <Badge tone="warning">Ограничение истекло</Badge>}
          {!restriction && detail.banned && <Badge tone="error">Заблокирован</Badge>}
          {detail.unlimited?.active && (
            <Badge tone="warning">Безлимит{detail.unlimited.source === 'env' ? ' (владелец)' : detail.unlimited.until ? ` до ${formatDateMsk(detail.unlimited.until)}` : ''}</Badge>
          )}
        </div>

        <div className={u.meta}>
          <span>Регистрация {formatDateMsk(detail.createdAt)}</span>
          <span className={u.dot}>Последний вход {lastSeen(detail.lastSignInAt)}</span>
          {methods.length > 0 && <span className={u.dot}>Вход через: {methods.join(', ')}</span>}
        </div>
      </div>
    </section>
  );
}
