import type { AdminUserDetail } from '../../../../../api/admin';
import { WALLET_MAX_KOPECKS, parseRubles, rub, walletPreview } from '../../../../../lib/admin-controls';
import { Checkbox, Field, Input, Textarea } from '../../../../../ui';
import { PreviewRows, SegButtons } from './controls';
import u from '../../user.module.css';

export type WalletDraft = { direction: 'credit' | 'debit'; amount: string; comment: string; notify: boolean };

export const COMMENT_MAX = 200;

export function initialWallet(): WalletDraft {
  return { direction: 'credit', amount: '', comment: '', notify: true };
}

/** Ошибка формы кошелька для подсказки в подвале; null — можно сохранять. */
export function walletError(balanceKopecks: number, draft: WalletDraft): string | null {
  const kopecks = parseRubles(draft.amount);
  if (!draft.comment.trim()) return 'Добавьте комментарий для выписки';
  if (kopecks === null || kopecks <= 0) return 'Укажите сумму больше нуля';
  if (kopecks > WALLET_MAX_KOPECKS) return `Не больше ${rub(WALLET_MAX_KOPECKS)} за раз`;
  if (walletPreview(balanceKopecks, draft.direction, kopecks).overdraft) return 'Сумма списания больше баланса';
  return null;
}

/** Вкладка «Кошелёк»: пополнить или списать с комментарием для выписки. */
export function WalletSection({
  detail,
  value,
  onChange,
  showCommentError,
}: {
  detail: AdminUserDetail;
  value: WalletDraft;
  onChange: (next: WalletDraft) => void;
  showCommentError: boolean;
}) {
  const balance = Number(detail.wallet?.balanceKopecks ?? 0);
  const kopecks = parseRubles(value.amount) ?? 0;
  const { toKopecks, overdraft } = walletPreview(balance, value.direction, kopecks);
  const amountInvalid = value.amount.trim() !== '' && parseRubles(value.amount) === null;

  return (
    <div className={u.modalBody}>
      <SegButtons
        label="Операция"
        value={value.direction}
        onChange={direction => onChange({ ...value, direction })}
        options={[
          { value: 'credit', label: 'Пополнить' },
          { value: 'debit', label: 'Списать' },
        ]}
      />
      <Field
        label="Сумма, ₽"
        error={overdraft ? `Сумма больше баланса: списать можно не больше ${rub(balance)}.` : amountInvalid ? 'Например: 500 или 199,50' : undefined}
      >
        <Input
          inputMode="decimal"
          value={value.amount}
          placeholder="500"
          autoComplete="off"
          onChange={event => onChange({ ...value, amount: event.target.value })}
        />
      </Field>
      <Field
        label="Комментарий (увидит пользователь в выписке) *"
        error={showCommentError && !value.comment.trim() ? 'Напишите, за что начисление или списание — без этого не сохранится' : undefined}
        help="Например: «Компенсация за сбой 08.11»"
      >
        <Textarea rows={2} value={value.comment} maxLength={COMMENT_MAX} onChange={event => onChange({ ...value, comment: event.target.value })} />
      </Field>
      <Checkbox id="wallet-notify" checked={value.notify} onChange={event => onChange({ ...value, notify: event.target.checked })}>
        Уведомить пользователя — сообщение в Telegram-боте, на почту и в кабинет со суммой и комментарием
      </Checkbox>
      <PreviewRows rows={[{ label: 'Баланс', from: rub(balance), to: rub(toKopecks), changed: kopecks > 0 }]} />
    </div>
  );
}
