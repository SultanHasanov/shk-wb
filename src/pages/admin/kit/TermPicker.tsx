import { useId } from 'react';
import type { ReactNode } from 'react';
import { Input } from '../../../ui';
import k from './kit.module.css';

export interface TermPickerProps {
  value: { preset: string; date: string /* YYYY-MM-DD */ };
  onChange: (v: { preset: string; date: string }) => void;
  /** Пресеты приходят снаружи (RESTRICT_TERMS / LIMIT_TERMS из src/lib/admin-controls.ts). */
  presets: ReadonlyArray<{ value: string; label: string }>;
  dateLabel?: string;
  hint?: ReactNode;
  /** Подпись группы; по умолчанию «Срок». */
  legend?: string;
}

/** Пресеты, после которых нужна дата: «Своя дата» у ограничений, «До даты» у лимитов. */
export const DATE_PRESETS: ReadonlySet<string> = new Set(['custom', 'date']);

/** Сегодня по Москве в формате YYYY-MM-DD — нижняя граница поля даты. */
export function mskToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** «Бессрочно / До даты» и пресеты сроков — общий для лимитов и ограничений. */
export function TermPicker({ value, onChange, presets, dateLabel = 'Дата', hint, legend = 'Срок' }: TermPickerProps) {
  const id = useId();
  const needsDate = DATE_PRESETS.has(value.preset);

  return (
    <fieldset className={k.term}>
      <legend>{legend}</legend>
      <div className={k.chips} role="radiogroup" aria-label={legend}>
        {presets.map(preset => {
          const selected = preset.value === value.preset;
          return (
            <button
              key={preset.value}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`${k.chip} ${selected ? k.chipActive : ''}`}
              onClick={() => onChange({ preset: preset.value, date: value.date })}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      {needsDate && (
        <div className={k.body} style={{ gap: 'var(--sp-2)' }}>
          <label className={k.confirmLabel} htmlFor={`${id}-date`}>
            {dateLabel}
          </label>
          <Input
            id={`${id}-date`}
            type="date"
            className={k.dateInput}
            min={mskToday()}
            value={value.date}
            onChange={event => onChange({ preset: value.preset, date: event.target.value })}
          />
        </div>
      )}
      {hint && <div className={k.help}>{hint}</div>}
    </fieldset>
  );
}
