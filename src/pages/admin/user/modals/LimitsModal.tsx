import { useEffect, useMemo, useState } from 'react';
import { type AdminUserDetail, useAdminUserAction } from '../../../../api/admin';
import { useClearOverrides, useSetOverrides, useWalletAdjust } from '../../../../api/admin-controls';
import {
  type LimitsDraft,
  draftFromDetail,
  draftToRequest,
  formatDateMsk,
  hasOverrideSections,
  limitsDraftError,
  parseRubles,
  rub,
} from '../../../../lib/admin-controls';
import { Alert, Button, Field, Modal, Textarea, useToast } from '../../../../ui';
import { REASON_MAX, useConfirmAction, useIdempotencyKey } from '../../kit';
import { PLAN_LABEL, displayNameOf, realEmail, useRunner } from '../shared';
import { GEN_MAX, GenerationsSection, type GenerationsDraft, initialGenerations } from './limits/GenerationsSection';
import { PvzSection } from './limits/PvzSection';
import { WalletSection, type WalletDraft, initialWallet, walletError } from './limits/WalletSection';
import u from '../user.module.css';

export type LimitsTab = 'pvz' | 'gen' | 'wallet';

const TABS: ReadonlyArray<{ value: LimitsTab; label: string }> = [
  { value: 'pvz', label: 'Помощник ПВЗ' },
  { value: 'gen', label: 'Генерации' },
  { value: 'wallet', label: 'Кошелёк' },
];

/**
 * Окно «Лимиты и доступы» (макет Limits): три вкладки, общая причина для
 * журнала, «было → станет». Сохраняет текущую вкладку. Ключ повтора
 * создаётся при открытии окна: повтор после сбоя сети не задвоит деньги.
 */
export function LimitsModal({
  open,
  onOpenChange,
  detail,
  initialTab = 'pvz',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AdminUserDetail;
  initialTab?: LimitsTab;
}) {
  const userId = detail.userId;
  const [tab, setTab] = useState<LimitsTab>(initialTab);
  const initialDraft = useMemo(() => draftFromDetail(detail), [detail]);
  const [draft, setDraft] = useState<LimitsDraft>(initialDraft);
  const [gen, setGen] = useState<GenerationsDraft>(() => initialGenerations(detail));
  const [wallet, setWallet] = useState<WalletDraft>(initialWallet);
  const [reason, setReason] = useState('');
  const [base, setBase] = useState<LimitsDraft>(initialDraft);
  const key = useIdempotencyKey(open);
  const { pending, error, run, guardedOpenChange } = useConfirmAction(open, onOpenChange);

  const setOverrides = useSetOverrides();
  const clearOverrides = useClearOverrides();
  const walletAdjust = useWalletAdjust();
  const topup = useAdminUserAction<{ userId: string; codeId: number; add: number; reason?: string }>('topupSticker');
  const grantSticker = useAdminUserAction<{ userId: string; name: string; limit: number; reason?: string }>('grantSticker');
  const runner = useRunner();
  const toast = useToast();

  // Каждое открытие — с чистого листа и с текущими значениями карточки.
  useEffect(() => {
    if (!open) return;
    const fresh = draftFromDetail(detail);
    setTab(initialTab);
    setDraft(fresh);
    setBase(fresh);
    setGen(initialGenerations(detail));
    setWallet(initialWallet());
    setReason('');
    // detail намеренно не в зависимостях: обновление карточки в фоне не должно стирать ввод.
  }, [open, initialTab]);

  const balance = Number(detail.wallet?.balanceKopecks ?? 0);
  const reasonText = reason.trim();
  const overridesBody = draftToRequest(draft, userId, reasonText, key, base);
  const hasOverrides = Boolean(detail.overrides) || Number(detail.legacyDeviceBonus) > 0;

  let tabError: string | null = null;
  if (tab === 'pvz') tabError = limitsDraftError(draft) ?? (hasOverrideSections(overridesBody) ? null : 'Ничего не изменено');
  if (tab === 'gen') tabError = gen.add > 0 && gen.add <= GEN_MAX ? null : 'Укажите, сколько генераций выдать';
  if (tab === 'wallet') tabError = walletError(balance, wallet);

  const hint = !reasonText
    ? 'Чтобы сохранить, укажите причину для журнала'
    : tabError ?? 'Изменения применятся сразу и попадут в журнал';
  const canSave = Boolean(reasonText) && !tabError && !pending;

  const save = () => {
    if (!canSave) return;
    void run(async () => {
      if (tab === 'pvz') {
        await runner(setOverrides, overridesBody, 'Лимиты сохранены. Запись добавлена в журнал');
      } else if (tab === 'gen') {
        if (gen.target === 'new') {
          await runner(grantSticker, { userId, name: 'Выдан администратором', limit: gen.add, reason: reasonText }, 'Новый код выдан');
        } else {
          await runner(topup, { userId, codeId: gen.target, add: gen.add, reason: reasonText }, 'Генерации добавлены');
        }
      } else {
        const amountKopecks = parseRubles(wallet.amount) ?? 0;
        const result = await walletAdjust.mutateAsync({
          userId,
          direction: wallet.direction,
          amountKopecks,
          comment: wallet.comment.trim(),
          reason: reasonText,
          notify: wallet.notify,
          idempotencyKey: key,
        });
        // тост — с итоговым балансом из ответа сервера; повтор с тем же ключом денег не двигает
        const repeated = result.duplicate || Boolean(result.replayed);
        toast(
          repeated ? `Операция уже была проведена. Баланс: ${rub(result.balanceKopecks)}` : `Готово. Баланс: ${rub(result.balanceKopecks)}`,
          'success',
        );
      }
    });
  };

  const clearAll = () => {
    if (!reasonText || pending) return;
    void run(() => runner(clearOverrides, { userId, reason: reasonText, idempotencyKey: key }, 'Ручные лимиты сняты'));
  };

  const plan = detail.app?.entitlements?.plan;
  const sub = [
    displayNameOf(detail),
    realEmail(detail) !== displayNameOf(detail) ? realEmail(detail) : null,
    plan ? `${PLAN_LABEL[plan] ?? plan}${detail.app?.entitlements?.ends_at ? ` до ${formatDateMsk(detail.app.entitlements.ends_at).slice(0, 5)}` : ''}` : 'без тарифа',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Modal
      open={open}
      onOpenChange={guardedOpenChange}
      title="Лимиты и доступы"
      description={sub}
      size="lg"
      sheet
      footer={
        <div className={u.foot}>
          <span className={u.footHint} aria-live="polite">
            {hint}
          </span>
          <Button variant="secondary" onClick={() => guardedOpenChange(false)} disabled={pending}>
            Отмена
          </Button>
          <Button onClick={save} disabled={!canSave} loading={pending}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className={u.modalBody}>
        <div className={u.modalTabs} role="tablist" aria-label="Что настроить">
          {TABS.map(item => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              className={u.modalTab}
              onClick={() => setTab(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" aria-label={TABS.find(item => item.value === tab)?.label}>
          {tab === 'pvz' && (
            <>
              <PvzSection detail={detail} draft={draft} onChange={patch => setDraft(prev => ({ ...prev, ...patch }))} />
              {hasOverrides && (
                <div className={u.formActions} style={{ justifyContent: 'flex-start' }}>
                  <Button variant="ghost" onClick={clearAll} disabled={!reasonText || pending}>
                    Снять все ручные лимиты
                  </Button>
                  {!reasonText && <span className={u.footHint}>нужна причина ниже</span>}
                </div>
              )}
            </>
          )}
          {tab === 'gen' && <GenerationsSection detail={detail} value={gen} onChange={setGen} />}
          {tab === 'wallet' && <WalletSection detail={detail} value={wallet} onChange={setWallet} showCommentError={false} />}
        </div>

        <Field label="Причина для журнала *" help="Обязательно. Видно только администраторам">
          <Textarea
            rows={2}
            value={reason}
            maxLength={REASON_MAX}
            placeholder="Например: второй пункт, на месяц"
            onChange={event => setReason(event.target.value)}
          />
        </Field>

        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
