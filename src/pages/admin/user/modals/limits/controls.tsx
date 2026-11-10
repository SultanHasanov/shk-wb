import { useId } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Input } from '../../../../../ui';
import u from '../../user.module.css';

/** Число со ступенькой «− N +»: на телефоне кнопки удобнее, чем стрелки поля. */
export function Stepper({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  label,
  id,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max: number;
  step?: number;
  /** Подпись для кнопок «Уменьшить: ПК» */
  label: string;
  id?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <span className={u.stepper}>
      <button type="button" className={u.stepBtn} aria-label={`Уменьшить: ${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
        <Minus size={16} aria-hidden="true" />
      </button>
      <Input
        id={inputId}
        className={u.stepInput}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? String(value) : ''}
        aria-label={label}
        onChange={event => {
          const n = Number.parseInt(event.target.value, 10);
          onChange(Number.isNaN(n) ? min : clamp(n));
        }}
      />
      <button type="button" className={u.stepBtn} aria-label={`Увеличить: ${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
        <Plus size={16} aria-hidden="true" />
      </button>
    </span>
  );
}

/** Блок «Было → станет». */
export function PreviewRows({
  title = 'Было → станет',
  note,
  rows,
}: {
  title?: string;
  note?: string;
  rows: ReadonlyArray<{ label: string; from: string; to: string; changed: boolean }>;
}) {
  return (
    <section className={u.prev} aria-label={title}>
      <h3>{title}</h3>
      {note && <span className={u.prevNote}>{note}</span>}
      {rows.map(row => (
        <div key={row.label} className={u.prevRow}>
          <span>{row.label}</span>
          <span className={u.prevFrom}>{row.from}</span>
          <span className={u.prevArrow} aria-hidden="true">
            →
          </span>
          <span className={`${u.prevTo} ${row.changed ? u.prevChanged : ''}`}>
            <span className="sr-only">станет </span>
            {row.to}
          </span>
        </div>
      ))}
    </section>
  );
}

/** Сегменты-кнопки с aria-pressed (режим подборов, операция кошелька). */
export function SegButtons<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  label: string;
}) {
  return (
    <div className={u.seg} role="group" aria-label={label}>
      {options.map(option => (
        <button key={option.value} type="button" className={u.segBtn} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
