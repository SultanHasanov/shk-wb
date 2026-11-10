import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Select } from '../../../ui';
import k from './kit.module.css';

export interface ChipFilterProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  label: string;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  /** По умолчанию 'scroll' — лента вбок на телефоне (M-Users); 'select' — <Select> ниже 480 px. */
  mobile?: 'scroll' | 'select';
}

const counts = new Intl.NumberFormat('ru-RU');

/** Фильтр-чипы вместо Segmented, когда вариантов больше трёх. */
export function ChipFilter<T extends string>({ value, onChange, label, options, mobile = 'scroll' }: ChipFilterProps<T>) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = options.findIndex(option => option.value === value);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next === -1) return;
    event.preventDefault();
    const target = options[next].value;
    onChange(target);
    refs.current[target]?.focus();
  }

  return (
    <>
      <div
        role="radiogroup"
        aria-label={label}
        className={[k.chips, k.chipsScroll, mobile === 'select' ? k.chipsCollapsible : ''].join(' ')}
        onKeyDown={onKeyDown}
      >
        {options.map(option => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              ref={node => {
                refs.current[option.value] = node;
              }}
              className={`${k.chip} ${selected ? k.chipActive : ''}`}
              onClick={() => onChange(option.value)}
            >
              {option.label}
              {typeof option.count === 'number' && <span className={k.chipCount}>{counts.format(option.count)}</span>}
            </button>
          );
        })}
      </div>
      {mobile === 'select' && (
        <div className={k.chipSelect}>
          <Select aria-label={label} value={value} onChange={event => onChange(event.target.value as T)}>
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {typeof option.count === 'number' ? `${option.label} · ${counts.format(option.count)}` : option.label}
              </option>
            ))}
          </Select>
        </div>
      )}
    </>
  );
}
