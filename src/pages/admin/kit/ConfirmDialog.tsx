import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Alert, Button, Field, Input, Modal, Textarea } from '../../../ui';
import { useConfirmAction } from './useConfirmAction';
import k from './kit.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Например, список «что произойдёт». */
  children?: ReactNode;
  confirmLabel: string;
  /** По умолчанию «Отмена». */
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  requireReason?: boolean;
  /** «Причина для журнала *» */
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /** Кнопка включается при точном совпадении ввода (например, почта при удалении). */
  typeToConfirm?: string;
  typeToConfirmLabel?: ReactNode;
  /**
   * Пока промис идёт — кнопка в загрузке, повторный клик игнорируется;
   * ошибка — Alert внутри окна, окно не закрывается; успех — закрытие.
   */
  onConfirm: (input: { reason: string }) => Promise<unknown> | void;
}

export const REASON_MAX = 500;

/** Замена window.confirm: причина в журнал, ввод для подтверждения, защита от двойного клика. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Отмена',
  tone = 'default',
  requireReason = false,
  reasonLabel = 'Причина для журнала *',
  reasonPlaceholder = 'Например: запрос в поддержку от 10.11',
  typeToConfirm,
  typeToConfirmLabel,
  onConfirm,
}: ConfirmDialogProps) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const { pending, error, run, guardedOpenChange } = useConfirmAction(open, onOpenChange);

  useEffect(() => {
    if (open) {
      setReason('');
      setTyped('');
    }
  }, [open]);

  const reasonOk = !requireReason || reason.trim().length > 0;
  const typedOk = typeToConfirm === undefined || typed.trim() === typeToConfirm.trim();
  const canConfirm = reasonOk && typedOk && !pending;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!reasonOk || !typedOk) return;
    void run(() => onConfirm({ reason: reason.trim() }));
  };

  const formId = `${id}-form`;

  return (
    <Modal
      open={open}
      onOpenChange={guardedOpenChange}
      title={title}
      description={description}
      sheet
      footer={
        <>
          <Button variant="secondary" className={k.tap} onClick={() => guardedOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            onClick={() => submit()}
            variant={tone === 'danger' ? 'danger' : 'primary'}
            className={`${k.tap} ${tone === 'danger' ? k.dangerSolid : ''}`}
            disabled={!canConfirm}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className={k.body} onSubmit={submit} noValidate>
        {children}

        {requireReason && (
          <Field label={reasonLabel} help="Видно только в журнале админки">
            <Textarea
              rows={2}
              value={reason}
              maxLength={REASON_MAX}
              placeholder={reasonPlaceholder}
              onChange={event => setReason(event.target.value)}
            />
          </Field>
        )}

        {typeToConfirm !== undefined && (
          <div className={k.body} style={{ gap: 'var(--sp-2)' }}>
            <label className={k.confirmLabel} htmlFor={`${id}-type`}>
              {typeToConfirmLabel ?? (
                <>
                  Введите <span className={k.mono}>{typeToConfirm}</span>, чтобы подтвердить
                </>
              )}
            </label>
            <Input
              id={`${id}-type`}
              value={typed}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={typeToConfirm}
              onChange={event => setTyped(event.target.value)}
            />
            <p className={k.help}>Кнопка включится при точном совпадении</p>
          </div>
        )}

        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}
