import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Alert, Button, Field, Input, Modal, Textarea } from '../../../ui';
import { REASON_MAX } from './ConfirmDialog';
import { useConfirmAction } from './useConfirmAction';
import k from './kit.module.css';

export interface NumberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: ReactNode;
  label: string;
  min: number;
  max: number;
  step?: number;
  initial?: number;
  suffix?: string;
  presets?: ReadonlyArray<{ value: number; label: string }>;
  /** «Новый срок: 30.01.2027» */
  preview?: (value: number) => ReactNode;
  confirmLabel: string;
  requireReason?: boolean;
  /** Вне [min, max] или не целое — кнопка выключена. */
  onConfirm: (value: number, input: { reason: string }) => Promise<unknown> | void;
}

/** Разбор ввода: целое в границах или null. Пустая строка, «1.5», «1e3» — не число для нас. */
export function parseBoundedInt(raw: string, min: number, max: number, step = 1): number | null {
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  if (step > 1 && (value - min) % step !== 0) return null;
  return value;
}

/** Замена window.prompt для чисел: «Продлить на N дней», «+ генерации». */
export function NumberDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  label,
  min,
  max,
  step = 1,
  initial,
  suffix,
  presets,
  preview,
  confirmLabel,
  requireReason = false,
  onConfirm,
}: NumberDialogProps) {
  const id = useId();
  const [raw, setRaw] = useState(initial !== undefined ? String(initial) : '');
  const [reason, setReason] = useState('');
  const { pending, error, run, guardedOpenChange } = useConfirmAction(open, onOpenChange);

  useEffect(() => {
    if (open) {
      setRaw(initial !== undefined ? String(initial) : '');
      setReason('');
    }
    // initial намеренно не в зависимостях: пересчёт снаружи не должен стирать ввод.
  }, [open]);

  const value = parseBoundedInt(raw, min, max, step);
  const reasonOk = !requireReason || reason.trim().length > 0;
  const canConfirm = value !== null && reasonOk && !pending;
  const invalid = raw.trim() !== '' && value === null;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (value === null || !reasonOk) return;
    void run(() => onConfirm(value, { reason: reason.trim() }));
  };

  return (
    <Modal
      open={open}
      onOpenChange={guardedOpenChange}
      title={title}
      description={subtitle ?? `${label}: от ${min} до ${max}`}
      sheet
      footer={
        <>
          <Button variant="secondary" className={k.tap} onClick={() => guardedOpenChange(false)} disabled={pending}>
            Отмена
          </Button>
          <Button className={k.tap} onClick={() => submit()} disabled={!canConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form className={k.body} onSubmit={submit} noValidate>
        <Field
          label={suffix ? `${label}, ${suffix}` : label}
          error={invalid ? `Целое число от ${min} до ${max}` : undefined}
        >
          <Input
            id={`${id}-value`}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={step}
            value={raw}
            onChange={event => setRaw(event.target.value)}
          />
        </Field>

        {presets && presets.length > 0 && (
          <div className={k.chips} role="group" aria-label="Быстрый выбор">
            {presets.map(preset => {
              const pressed = value === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  aria-pressed={pressed}
                  className={`${k.chip} ${pressed ? k.chipActive : ''}`}
                  onClick={() => setRaw(String(preset.value))}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        )}

        {preview && value !== null && <div className={k.preview}>{preview(value)}</div>}

        {requireReason && (
          <Field label="Причина для журнала *" help="Видно только в журнале админки">
            <Textarea rows={2} value={reason} maxLength={REASON_MAX} onChange={event => setReason(event.target.value)} />
          </Field>
        )}

        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}
