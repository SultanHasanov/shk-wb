import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CircleAlert, CircleCheck, Info, RefreshCw } from 'lucide-react';
import { Button, Card, EmptyState } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { type Notification, type NotificationKind, useCabinetMutation, useNotifications } from '../../api/cabinet';
import { useDocumentMeta } from '../../lib/seo';
import { type T, useT } from '../../i18n';
import c from './cabinet.module.css';

// Иконка и тон — по виду события. В прототипе предупреждения жёлтые, оплаты
// зелёные, новости/рефералы — акцентные.
const look: Record<NotificationKind, { tone: string; Icon: typeof Info }> = {
  key_expiry: { tone: c.toneWarn, Icon: CircleAlert },
  low_balance: { tone: c.toneWarn, Icon: CircleAlert },
  order: { tone: c.toneOk, Icon: CircleCheck },
  product_news: { tone: c.toneInfo, Icon: RefreshCw },
  system: { tone: c.toneInfo, Icon: Info },
};

// День события для группировки: Сегодня / Вчера / дата. Тексты самих уведомлений
// сервер пишет по-русски в момент события — переводится только обвязка.
function dayLabel(iso: string, t: T): string {
  const d = new Date(iso);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff <= 0) return t('Сегодня', 'Бүгін');
  if (diff === 1) return t('Вчера', 'Кеше');
  if (diff < 7) return t('На этой неделе', 'Осы аптада');
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function NotificationsPage() {
  const t = useT();
  useDocumentMeta(t('Уведомления — кабинет', 'Хабарламалар — кабинет'));
  const query = useNotifications();
  const read = useCabinetMutation<{ id?: string; readAll?: boolean }>('/api/cabinet/notifications', 'PATCH');

  if (query.isPending) return <div className="page"><CabinetLoading /></div>;
  if (query.isError) return <div className="page"><CabinetError error={query.error} retry={() => query.refetch()} /></div>;

  const items = query.data.items;
  const hasUnread = items.some(n => !n.readAt);

  // Группируем по дню, сохраняя серверный порядок (свежие сверху).
  const groups: Array<{ day: string; notes: Notification[] }> = [];
  for (const note of items) {
    const day = dayLabel(note.createdAt, t);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.notes.push(note);
    else groups.push({ day, notes: [note] });
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('Уведомления', 'Хабарламалар')}</h1>
        <p>{t('Оплаты, сроки лицензий и важные события.', 'Төлемдер, лицензия мерзімдері және маңызды оқиғалар.')}</p>
      </header>

      {hasUnread && (
        <div className="row">
          <Button variant="ghost" size="sm" onClick={() => read.mutate({ readAll: true })}>
            {t('Отметить все прочитанными', 'Барлығын оқылды деп белгілеу')}
          </Button>
        </div>
      )}

      {items.length ? (
        <div className={c.notifList}>
          {groups.map(group => (
            <div key={group.day}>
              <div className={c.notifDay}>{group.day}</div>
              {group.notes.map(note => {
                const { tone, Icon } = look[note.kind] ?? look.system;
                const unread = !note.readAt;
                return (
                  <div key={note.id} className={`${c.notifItem} ${unread ? c.notifUnread : ''}`}>
                    {unread && <span className={c.notifDot} aria-hidden="true" />}
                    <span className={`${c.notifIcon} ${tone}`} aria-hidden="true"><Icon size={20} /></span>
                    <div>
                      <div className={c.notifTitle}>{note.title}</div>
                      <p className={c.notifBody}>{note.body}</p>
                      <div className={c.notifTime}>{dayLabel(note.createdAt, t)}, {time(note.createdAt)}</div>
                      {(note.link || unread) && (
                        <div className={`${c.notifCta} row`}>
                          {note.link && <Link className="accent" to={note.link}>{t('Открыть →', 'Ашу →')}</Link>}
                          {unread && <Button variant="ghost" size="sm" onClick={() => read.mutate({ id: note.id })}>{t('Прочитано', 'Оқылды')}</Button>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={<Bell />} title={t('Уведомлений нет', 'Хабарламалар жоқ')} text={t('Здесь появятся события по вашему аккаунту.', 'Аккаунтыңыз бойынша оқиғалар осында пайда болады.')} />
        </Card>
      )}
    </div>
  );
}
