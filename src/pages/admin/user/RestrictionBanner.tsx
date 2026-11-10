import { ShieldAlert } from 'lucide-react';
import type { AdminRestriction } from '../../../api/admin';
import { formatMskDateTime } from '../../../lib/admin-audit';
import { formatUntilLong, scopesLabel } from '../../../lib/admin-controls';
import { Button } from '../../../ui';
import u from './user.module.css';

function byLabel(createdBy: string | null): string {
  if (createdBy === 'migration') return 'перенесено из старой блокировки';
  if (createdBy === 'auto' || createdBy === 'system') return 'наложено системой';
  return 'наложил админ';
}

/** Плашка действующего (или просроченного, но ещё не снятого) ограничения под шапкой. */
export function RestrictionBanner({
  restriction,
  onEdit,
  onLift,
}: {
  restriction: AdminRestriction;
  onEdit: () => void;
  onLift: () => void;
}) {
  const title = restriction.full ? 'Ограничено полностью' : `Ограничено: ${scopesLabel(restriction.scopes)}`;
  const term = restriction.until ? `до ${formatUntilLong(restriction.until)}` : 'бессрочно';
  const legacy = restriction.disabledItems?.legacy;
  return (
    <section
      className={`${u.banner} ${restriction.expired ? u.bannerExpired : ''}`}
      aria-label="Ограничение доступа"
      role="status"
    >
      <ShieldAlert size={22} className={u.bannerIcon} aria-hidden="true" />
      <div className={u.bannerText}>
        <strong>{title}</strong>
        <span>
          {term} · причина: «{restriction.reason}» · {byLabel(restriction.createdBy)} {formatMskDateTime(restriction.createdAt)}
        </span>
        {restriction.expired && <span>Срок вышел — ограничение снимется автоматически в ближайшие минуты, можно снять и сейчас.</span>}
        {legacy && <span>Старая блокировка: при снятии включатся все выключенные коды, ключи и лицензии аккаунта.</span>}
      </div>
      <div className={u.bannerActions}>
        <Button variant="secondary" size="sm" onClick={onEdit} style={{ minHeight: 'var(--tap)' }}>
          Изменить
        </Button>
        <Button variant="secondary" size="sm" onClick={onLift} style={{ minHeight: 'var(--tap)' }}>
          Снять
        </Button>
      </div>
    </section>
  );
}
