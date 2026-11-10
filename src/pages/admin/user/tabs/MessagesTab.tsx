import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Send } from 'lucide-react';
import type { AdminDelivery, AdminSentMessage, AdminUserDetail } from '../../../../api/admin';
import { useAdminUserSection } from '../../../../api/admin-controls';
import type { UserSectionData } from '../../../../api/admin-controls';
import { formatMskDateTime } from '../../../../lib/admin-audit';
import { CHANNEL_TITLES, channelStatusLabel, channelStatusTone } from '../../../../lib/admin-controls';
import { Badge, Button, Card } from '../../../../ui';
import { ChipFilter, DataState, EmptyBlock, ResponsiveTable } from '../../kit';
import type { ResponsiveColumn } from '../../kit';
import u from '../user.module.css';

type View = 'sent' | 'deliveries' | 'pc' | 'notifications';
type PcMessage = UserSectionData['pcMessages']['items'][number];
type Notification = AdminUserDetail['notifications'][number];

const PC_STATUS: Record<PcMessage['status'], { label: string; tone: 'success' | 'warning' | 'default' | 'error' }> = {
  pending: { label: 'ждёт ПК', tone: 'warning' },
  delivered: { label: 'показано', tone: 'default' },
  read: { label: 'прочитано', tone: 'success' },
  answered: { label: 'есть ответ', tone: 'success' },
  expired: { label: 'истекло', tone: 'error' },
};

function channelLine(channel: AdminSentMessage['channels'][number]): string {
  const name = channel.channel === 'pc' && channel.deviceName ? `ПК «${channel.deviceName}»` : CHANNEL_TITLES[channel.channel];
  const at = channel.status === 'read' && channel.at ? ` ${formatMskDateTime(channel.at).slice(-5)}` : '';
  return `${name} · ${channelStatusLabel(channel.channel, channel.status)}${at}`;
}

function SentMessages({ userId }: { userId: string }) {
  const query = useAdminUserSection(userId, 'messages');
  return (
    <DataState
      query={query}
      isEmpty={data => data.items.length === 0}
      empty={<EmptyBlock title="Сообщений ещё не было" text="Отправленные из админки сообщения и их статусы по каналам появятся здесь." />}
    >
      {data => (
        <div className={u.list}>
          {data.items.map(message => (
            <article key={message.actionId} className={u.msg}>
              <div className={u.msgHead}>
                <strong>{message.subject}</strong>
                <span>{formatMskDateTime(message.sentAt)}</span>
              </div>
              <div className={u.chans}>
                {message.channels.map((channel, index) => (
                  <Badge key={`${channel.channel}-${index}`} tone={channelStatusTone(channel.status)}>
                    {channelLine(channel)}
                  </Badge>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </DataState>
  );
}

const DELIVERY_STATUS: Record<AdminDelivery['status'], string> = {
  pending: 'ожидает',
  sent: 'отправлено',
  failed: 'ошибка',
  skipped: 'пропущено',
  not_configured: 'почта не настроена',
  blocked: 'бот заблокирован',
  expired: 'истекло',
};

function Deliveries({ userId }: { userId: string }) {
  const query = useAdminUserSection(userId, 'deliveries');
  const columns: ResponsiveColumn<AdminDelivery>[] = [
    { key: 'at', header: 'Когда', primary: true, cell: d => formatMskDateTime(d.createdAt) },
    { key: 'channel', header: 'Канал', cell: d => CHANNEL_TITLES[d.channel] },
    { key: 'to', header: 'Кому', cell: d => <span className={u.mono}>{d.recipient}</span> },
    { key: 'subject', header: 'Тема', cell: d => d.subject ?? '—' },
    {
      key: 'status',
      header: 'Статус',
      cell: d => (
        <span title={d.lastError ?? undefined}>
          <Badge tone={channelStatusTone(d.status)}>{DELIVERY_STATUS[d.status] ?? d.status}</Badge>
        </span>
      ),
    },
  ];
  return (
    <DataState query={query} isEmpty={data => data.items.length === 0} empty={<EmptyBlock title="Доставок нет" text="Письма, сообщения в Telegram и на ПК появятся здесь." />}>
      {data => (
        <>
          <ResponsiveTable rows={data.items} columns={columns} rowKey={d => d.id} />
          <p className={u.muted} style={{ marginTop: 'var(--sp-3)' }}>
            <Link to={`/panel/audit?tab=deliveries&userId=${encodeURIComponent(userId)}`}>Все доставки пользователя в журнале →</Link>
          </p>
        </>
      )}
    </DataState>
  );
}

function PcMessages({ userId }: { userId: string }) {
  const query = useAdminUserSection(userId, 'pcMessages');
  const columns: ResponsiveColumn<PcMessage>[] = [
    { key: 'at', header: 'Когда', primary: true, cell: m => formatMskDateTime(m.createdAt) },
    { key: 'pc', header: 'ПК', cell: m => m.deviceName ?? '—' },
    { key: 'from', header: 'От кого', cell: m => (m.createdBy === 'admin' ? 'администрация' : 'владелец') },
    { key: 'text', header: 'Текст', cell: m => <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</span> },
    { key: 'status', header: 'Статус', cell: m => <Badge tone={PC_STATUS[m.status]?.tone ?? 'default'}>{PC_STATUS[m.status]?.label ?? m.status}</Badge> },
    { key: 'answer', header: 'Ответ', cell: m => m.answerLabel || m.reply || m.answer || '—' },
  ];
  return (
    <DataState query={query} isEmpty={data => data.items.length === 0} empty={<EmptyBlock title="Сообщений на ПК не было" />}>
      {data => <ResponsiveTable rows={data.items} columns={columns} rowKey={m => m.id} />}
    </DataState>
  );
}

function Notifications({ items }: { items: readonly Notification[] }) {
  const columns: ResponsiveColumn<Notification>[] = [
    { key: 'title', header: 'Уведомление', primary: true, cell: n => n.title },
    { key: 'at', header: 'Дата', cell: n => formatMskDateTime(n.created_at) },
    { key: 'read', header: 'Прочитано', cell: n => (n.read_at ? 'да' : 'нет') },
  ];
  return (
    <ResponsiveTable
      rows={items}
      columns={columns}
      rowKey={n => n.id}
      empty={<EmptyBlock title="Уведомлений нет" text="Уведомления в кабинете пользователя появятся здесь." />}
    />
  );
}

/** Вкладка «Сообщения»: что отправляли из админки и куда это дошло. */
export function MessagesTab({
  userId,
  onCompose,
  notifications = [],
}: {
  userId: string;
  onCompose: () => void;
  notifications?: readonly Notification[];
}) {
  const [view, setView] = useState<View>('sent');
  return (
    <div className={u.tabBody}>
      <Card>
        <div className={u.cardHead}>
          <h3 className={u.cardTitle}>Сообщения пользователю</h3>
          <Button size="sm" style={{ minHeight: 'var(--tap)' }} onClick={onCompose}>
            <Send size={16} aria-hidden="true" />
            Новое сообщение
          </Button>
        </div>
        <div style={{ marginBottom: 'var(--sp-3)' }}>
          <ChipFilter<View>
            label="Что показать"
            value={view}
            onChange={setView}
            options={[
              { value: 'sent', label: 'Отправленные' },
              { value: 'deliveries', label: 'Доставки' },
              { value: 'pc', label: 'На ПК' },
              { value: 'notifications', label: 'В кабинете' },
            ]}
          />
        </div>
        {view === 'sent' && <SentMessages userId={userId} />}
        {view === 'deliveries' && <Deliveries userId={userId} />}
        {view === 'pc' && <PcMessages userId={userId} />}
        {view === 'notifications' && <Notifications items={notifications} />}
        {view === 'sent' && (
          <p className={u.muted} style={{ marginTop: 'var(--sp-3)' }}>
            <Link to={`/panel/audit?category=messages&userId=${encodeURIComponent(userId)}`}>
              Сообщения в журнале <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </p>
        )}
      </Card>
    </div>
  );
}
