import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Trash2, Unlink } from 'lucide-react';
import { type AdminUserDetail, useAdminUserAction } from '../../../../api/admin';
import { useAccountAction } from '../../../../api/admin-controls';
import { rub } from '../../../../lib/admin-controls';
import { Alert, Button } from '../../../../ui';
import { ConfirmDialog } from '../../kit';
import { useRunner } from '../shared';
import u from '../user.module.css';

type Dialog = 'logout' | 'telegram' | 'delete' | null;

/** Вкладка «Опасная зона»: каждое действие — через подтверждение с причиной и попадает в журнал. */
export function DangerTab({ detail }: { detail: AdminUserDetail }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const logoutAll = useAccountAction('logoutAll');
  const unlinkTelegram = useAccountAction('unlinkTelegram');
  const remove = useAdminUserAction<{ userId: string; confirm: string; reason?: string }>('account', 'DELETE');
  const run = useRunner();
  const userId = detail.userId;
  const tg = detail.loginMethods?.telegram ?? (detail.telegram ? { username: detail.telegram.username } : null);
  const close = (open: boolean) => !open && setDialog(null);

  const losses = [
    (detail.app?.subscriptions ?? []).some(s => !s.canceled && Date.parse(s.endsAt) > Date.now()) ? 'подписка' : null,
    (detail.cellLicenses ?? []).length ? 'лицензии' : null,
    (detail.codes ?? []).length ? 'коды' : null,
    detail.wallet?.balanceKopecks ? `кошелёк ${rub(detail.wallet.balanceKopecks)}` : null,
    (detail.app?.devices ?? []).some(d => !d.revokedAt) ? 'все ПК' : null,
  ].filter(Boolean);

  return (
    <div className={u.tabBody}>
      <section className={u.dangerCard} aria-labelledby="danger-title">
        <h3 id="danger-title" className={u.cardTitle}>
          Опасная зона <span className={u.cardSub}>· каждое действие требует причины и попадает в журнал</span>
        </h3>

        <div className={u.dangerRow}>
          <div>
            <strong>Завершить все сеансы</strong>
            <p>Выход на сайте и во всех программах. Ключи ПК останутся, войти можно заново.</p>
          </div>
          <Button variant="secondary" onClick={() => setDialog('logout')}>
            <LogOut size={16} aria-hidden="true" />
            Завершить все сеансы
          </Button>
        </div>

        {tg && (
          <div className={u.dangerRow}>
            <div>
              <strong>Отвязать Telegram</strong>
              <p>
                {tg.username ? `@${tg.username}` : 'Аккаунт'} перестанет получать уведомления и подтверждать коды клиента через бот.
              </p>
            </div>
            <Button variant="secondary" onClick={() => setDialog('telegram')}>
              <Unlink size={16} aria-hidden="true" />
              Отвязать Telegram
            </Button>
          </div>
        )}

        <div className={u.dangerRow}>
          <div>
            <strong>Удалить аккаунт навсегда</strong>
            <p>
              {losses.length ? `Удалятся ${losses.join(', ')}. ` : ''}
              Профиль, настройки и импортированная история исчезнут, заказы и выданные коды останутся в базе без владельца. Отменить нельзя.
            </p>
          </div>
          <Button variant="danger" onClick={() => setDialog('delete')}>
            <Trash2 size={16} aria-hidden="true" />
            Удалить аккаунт
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={dialog === 'logout'}
        onOpenChange={close}
        title="Завершить все сеансы?"
        description="Пользователь выйдет на сайте и во всех программах. Ключи ПК останутся, войти можно заново. У пользователя обновится «Последний вход» — так сервер открывает сеанс, чтобы закрыть все."
        confirmLabel="Завершить все сеансы"
        tone="danger"
        requireReason
        onConfirm={({ reason }) => run(logoutAll, { userId, reason }, 'Все сеансы завершены')}
      />
      <ConfirmDialog
        open={dialog === 'telegram'}
        onOpenChange={close}
        title="Отвязать Telegram?"
        description="Перестанут приходить уведомления бота и подтверждения кода клиента через бот. Если Telegram — единственный способ входа, сервер отвязку не разрешит."
        confirmLabel="Отвязать Telegram"
        tone="danger"
        requireReason
        onConfirm={({ reason }) => run(unlinkTelegram, { userId, reason }, 'Telegram отвязан')}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={close}
        title="Удалить аккаунт навсегда?"
        description="Действие необратимо."
        confirmLabel="Удалить навсегда"
        tone="danger"
        requireReason
        typeToConfirm={detail.confirmValue}
        typeToConfirmLabel={
          <>
            Введите почту <b>{detail.confirmValue}</b> для подтверждения
          </>
        }
        onConfirm={async ({ reason }) => {
          await run(remove, { userId, confirm: detail.confirmValue, reason }, 'Аккаунт удалён');
          navigate('/panel/users');
        }}
      >
        <Alert tone="warning">
          Каскадом удалятся профиль, настройки и импортированная история генераций. Заказы и выданные коды останутся в базе, но потеряют
          владельца.
        </Alert>
      </ConfirmDialog>
    </div>
  );
}
