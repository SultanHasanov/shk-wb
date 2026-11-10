import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAdminAudit } from '../../../../api/admin';
import { Button, Card } from '../../../../ui';
import { AuditEntry, DataState, EmptyBlock } from '../../kit';
import u from '../user.module.css';

/** Вкладка «Журнал»: действия администраторов с этим аккаунтом, было → стало. */
export function LogTab({ userId }: { userId: string }) {
  const audit = useAdminAudit({ userId });
  const items = audit.data?.pages.flatMap(page => page.items);
  return (
    <div className={u.tabBody}>
      <Card>
        <div className={u.cardHead}>
          <h3 className={u.cardTitle}>Журнал по пользователю</h3>
          <Link to={`/panel/audit?tab=actions&userId=${encodeURIComponent(userId)}`} className={u.crumbs}>
            Открыть в общем журнале <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
        <DataState
          query={{ data: items, isPending: audit.isPending, isError: audit.isError, error: audit.error, refetch: audit.refetch }}
          isEmpty={list => list.length === 0}
          empty={<EmptyBlock title="Записей нет" text="Каждое изменение аккаунта из админки появится здесь с причиной и тем, что было и стало." />}
        >
          {list => (
            <div className={u.list}>
              {list.map((entry, index) => (
                <AuditEntry key={entry.id} entry={entry} showUser={false} defaultOpen={index === 0} />
              ))}
            </div>
          )}
        </DataState>
        {audit.hasNextPage && (
          <div className={u.formActions}>
            <Button variant="secondary" loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
              Показать ещё
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
