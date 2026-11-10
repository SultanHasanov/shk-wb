import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Monitor } from 'lucide-react';
import type { AdminAuditEntry } from '../../../api/admin';
import {
  AUDIT_CATEGORIES,
  FIELD_LABELS,
  adminLabel,
  auditTargetLabel,
  describeAction,
  formatAuditValue,
  formatMskStamp,
  formatMskTime,
} from '../../../lib/admin-audit';
import { Badge } from '../../../ui';
import k from './kit.module.css';

export interface AuditEntryProps {
  entry: AdminAuditEntry;
  showUser?: boolean;
  defaultOpen?: boolean;
  /** Короткая строка без раскрытия (обзор, «Последние события» в карточке). */
  compact?: boolean;
}

const RESULT_BADGE: Record<string, { label: string; tone: 'error' | 'warning' | 'default' }> = {
  error: { label: 'Ошибка', tone: 'error' },
  partial: { label: 'Частично', tone: 'warning' },
  pending: { label: 'Выполняется', tone: 'default' },
};

/** Ключи payload, которые уже видны в заголовке или служебные: в «Подробностях» их не дублируем. */
const HIDDEN_PAYLOAD = new Set(['idempotencyKey', '__status']);

function payloadRows(payload: Record<string, unknown> | null | undefined) {
  if (!payload || typeof payload !== 'object') return [];
  return Object.entries(payload)
    .filter(([key, value]) => !HIDDEN_PAYLOAD.has(key) && value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({ key, label: FIELD_LABELS[key] ?? key, value: formatAuditValue(key, value) }));
}

/** Запись журнала: время, точка категории, что сделано, с кем, причина, кто; «Подробнее» — было → стало. */
export function AuditEntry({ entry, showUser = true, defaultOpen = false, compact = false }: AuditEntryProps) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const described = describeAction(entry);
  const category = entry.category in AUDIT_CATEGORIES ? entry.category : 'other';
  const target = showUser ? auditTargetLabel(entry) : null;
  const targetId = entry.target?.userId ?? entry.targetUserId;
  const time = formatMskTime(entry.createdAt);
  const result = entry.result && entry.result !== 'ok' ? RESULT_BADGE[entry.result] : null;

  if (compact) {
    return (
      <div className={k.entryCompact} data-audit-id={entry.id}>
        <span className={k.entryDot} data-category={category} aria-hidden="true" />
        <span className={k.entryMain}>
          <span>
            <b>{described.title}</b>
            {target && targetId && (
              <>
                {' · '}
                <Link to={`/panel/users/${targetId}`}>{target.title}</Link>
              </>
            )}
            {result && (
              <>
                {' '}
                <Badge tone={result.tone}>{result.label}</Badge>
              </>
            )}
          </span>
          <span className={k.entryCompactSub}>
            {time}
            {entry.reason ? ` · «${entry.reason}»` : ''}
          </span>
        </span>
      </div>
    );
  }

  const details = payloadRows(entry.payload);
  const hasDiff = described.diff.length > 0;
  const expandable = hasDiff || details.length > 0;
  const tone = AUDIT_CATEGORIES[category].tone;

  return (
    <article className={k.entry} data-audit-id={entry.id}>
      <div className={k.entryHead}>
        <span className={k.entryTime}>{time}</span>
        <span className={k.entryDot} data-category={category} aria-hidden="true" />
        <div className={k.entryMain}>
          <div className={k.entryTitle}>
            <b>{described.title}</b>
            <Badge tone={tone}>{described.categoryLabel}</Badge>
            {described.danger && <Badge tone="error">Опасное</Badge>}
            {result && <Badge tone={result.tone}>{result.label}</Badge>}
          </div>
          <div className={k.entryMeta}>
            <span>
              {target && targetId ? (
                <>
                  <Link to={`/panel/users/${targetId}`}>{target.title}</Link>
                  {target.sub ? ` · ${target.sub}` : ''}
                </>
              ) : null}
              {target && entry.reason ? ' · ' : ''}
              {entry.reason ? `«${entry.reason}»` : ''}
            </span>
            <span className={k.entryAdmin}>
              <Monitor size={13} aria-hidden="true" />
              {adminLabel(entry)}
            </span>
          </div>
        </div>
        {expandable && (
          <button
            type="button"
            className={k.entryToggle}
            aria-expanded={open}
            aria-controls={`${id}-details`}
            onClick={() => setOpen(value => !value)}
          >
            {open ? 'Скрыть' : 'Подробнее'}
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      {expandable && open && (
        <div className={k.entryDetails} id={`${id}-details`}>
          {hasDiff ? (
            <div className={k.diff}>
              <div className={k.diffCol}>
                <div className={k.diffHead}>Было</div>
                {described.diff.map(row => (
                  <div className={k.diffRow} key={row.field}>
                    <span>{row.label}</span>
                    <span>{row.before}</span>
                  </div>
                ))}
              </div>
              <div className={k.diffCol}>
                <div className={k.diffHead}>Стало</div>
                {described.diff.map(row => (
                  <div className={k.diffRow} key={row.field}>
                    <span>{row.label}</span>
                    <span>{row.after}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className={k.payloadList}>
              <div className={k.diffHead}>Подробности</div>
              {details.map(row => (
                <div className={k.diffRow} key={row.key}>
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </div>
              ))}
            </div>
          )}
          <div className={k.entryFoot}>
            <span>
              Запись <span className={k.mono}>#{entry.id}</span>
            </span>
            <span>{formatMskStamp(entry.createdAt)}</span>
          </div>
        </div>
      )}
    </article>
  );
}
