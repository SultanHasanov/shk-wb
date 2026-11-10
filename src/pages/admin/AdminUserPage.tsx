import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { type AdminUserDetail, type MessageChannel, useAdminUser, useAdminUserAction } from '../../api/admin';
import { Alert, Button, Skeleton, Tabs } from '../../ui';
import { ConfirmDialog, ErrorBlock } from './kit';
import { UserHeader } from './user/UserHeader';
import { RestrictionBanner } from './user/RestrictionBanner';
import { UserActionBar } from './user/UserActionBar';
import { OverviewTab } from './user/tabs/OverviewTab';
import { AccessTab } from './user/tabs/AccessTab';
import { DevicesTab } from './user/tabs/DevicesTab';
import { MoneyTab } from './user/tabs/MoneyTab';
import { MessagesTab } from './user/tabs/MessagesTab';
import { LogTab } from './user/tabs/LogTab';
import { DangerTab } from './user/tabs/DangerTab';
import { LimitsModal, type LimitsTab } from './user/modals/LimitsModal';
import { RestrictModal } from './user/modals/RestrictModal';
import { LiftRestrictionModal } from './user/modals/LiftRestrictionModal';
import { MessageComposer } from './user/modals/MessageComposer';
import { USER_TABS, type UserTab, parseUserTab, useRunner } from './user/shared';
import u from './user/user.module.css';

type MessageState = { open: boolean; channels?: MessageChannel[]; deviceIds?: string[] };

/**
 * Карточка пользователя: контейнер. Данные — useAdminUser, вкладка — в адресе
 * (?tab=, replace), шапка, плашка ограничения, панель действий, вкладки, окна.
 * Сами разделы — в src/pages/admin/user/.
 */
export function AdminUserPage() {
  const { userId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = parseUserTab(params.get('tab'));
  const query = useAdminUser(userId);

  const [limits, setLimits] = useState<{ open: boolean; tab: LimitsTab }>({ open: false, tab: 'pvz' });
  const [restrictMode, setRestrictMode] = useState<'create' | 'edit' | null>(null);
  const [liftOpen, setLiftOpen] = useState(false);
  const [message, setMessage] = useState<MessageState>({ open: false });
  const [unblockOpen, setUnblockOpen] = useState(false);
  const unblock = useAdminUserAction<{ userId: string; reason?: string }>('unblock');
  const run = useRunner();

  // Список подсвечивает последнего открытого (FE-3 читает этот ключ).
  useEffect(() => {
    if (!userId) return;
    try {
      sessionStorage.setItem('admin.lastUserId', userId);
    } catch {
      /* приватный режим или запрет хранилища — подсветки просто не будет */
    }
  }, [userId]);

  const selectTab = (next: UserTab) =>
    setParams(
      prev => {
        const copy = new URLSearchParams(prev);
        copy.set('tab', next);
        return copy;
      },
      { replace: true },
    );

  if (query.isPending) {
    return (
      <div className="page" role="status" aria-busy="true">
        <span className="sr-only">Загрузка карточки…</span>
        <div className={u.page}>
          <Skeleton height={120} />
          <Skeleton height={48} />
          <Skeleton height={320} />
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="page">
        <div className={u.page}>
          <div className={u.crumbs}>
            <Link to="/panel/users">
              <ArrowLeft size={16} aria-hidden="true" />
              Пользователи
            </Link>
          </div>
          <ErrorBlock error={query.error} onRetry={query.refetch} />
        </div>
      </div>
    );
  }

  const detail: AdminUserDetail = query.data;
  const restriction = detail.restriction ?? null;
  const openLimits = (limitsTab: LimitsTab = 'pvz') => setLimits({ open: true, tab: limitsTab });
  const onRestrict = () => (restriction ? setRestrictMode('edit') : setRestrictMode('create'));
  const openMessage = (channels?: MessageChannel[], deviceIds?: string[]) => setMessage({ open: true, channels, deviceIds });

  const content: Record<UserTab, ReactElement> = {
    overview: <OverviewTab detail={detail} onOpenLog={() => selectTab('audit')} />,
    access: <AccessTab detail={detail} onLimits={() => openLimits('pvz')} />,
    devices: <DevicesTab detail={detail} onMessageDevice={deviceId => openMessage(['pc'], [deviceId])} />,
    money: <MoneyTab detail={detail} onWallet={() => openLimits('wallet')} />,
    messages: <MessagesTab userId={userId} onCompose={() => openMessage()} notifications={detail.notifications ?? []} />,
    audit: <LogTab userId={userId} />,
    danger: <DangerTab detail={detail} />,
  };

  return (
    <div className="page">
      <div className={u.page}>
        <nav className={u.crumbs} aria-label="Навигация">
          <Link to="/panel/users">
            <ArrowLeft size={16} aria-hidden="true" />
            Пользователи
          </Link>
        </nav>

        <UserHeader detail={detail} />

        {restriction && <RestrictionBanner restriction={restriction} onEdit={() => setRestrictMode('edit')} onLift={() => setLiftOpen(true)} />}
        {!restriction && detail.banned && (
          <Alert tone="error">
            <div className={u.nameRow}>
              <span>Вход закрыт старой блокировкой (без записи об ограничении).</span>
              <Button variant="secondary" size="sm" style={{ minHeight: 'var(--tap)' }} onClick={() => setUnblockOpen(true)}>
                Разблокировать
              </Button>
            </div>
          </Alert>
        )}

        <UserActionBar
          onMessage={() => openMessage()}
          onLimits={() => openLimits('pvz')}
          onRestrict={onRestrict}
          previewHref={`/panel/users/${userId}/preview`}
          restricted={Boolean(restriction)}
        />

        <div className={u.tabs}>
          <Tabs<UserTab>
            label="Разделы карточки"
            value={tab}
            onChange={selectTab}
            items={USER_TABS.map(item => ({ ...item, content: content[item.value] }))}
          />
        </div>
      </div>

      <LimitsModal open={limits.open} onOpenChange={open => setLimits(prev => ({ ...prev, open }))} detail={detail} initialTab={limits.tab} />
      <RestrictModal
        open={restrictMode !== null}
        onOpenChange={open => !open && setRestrictMode(null)}
        detail={detail}
        mode={restrictMode === 'edit' && restriction ? 'edit' : 'create'}
      />
      <LiftRestrictionModal open={liftOpen} onOpenChange={setLiftOpen} detail={detail} />
      <MessageComposer
        open={message.open}
        onOpenChange={open => setMessage(prev => ({ ...prev, open }))}
        detail={detail}
        initialChannels={message.channels}
        initialDeviceIds={message.deviceIds}
      />
      <ConfirmDialog
        open={unblockOpen}
        onOpenChange={setUnblockOpen}
        title="Разблокировать аккаунт?"
        description="Вход откроется, выключенные старой блокировкой коды, ключи и лицензии включатся."
        confirmLabel="Разблокировать"
        requireReason
        onConfirm={({ reason }) => run(unblock, { userId, reason }, 'Пользователь разблокирован')}
      />
    </div>
  );
}
