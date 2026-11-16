import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { colorOf, initials, type StaffEntry } from '../../../lib/staff-core';
import s from './staff.module.css';

/**
 * Выпадающий список со своим оформлением: системный <select> на Windows открывает голубой список,
 * который выбивается из кабинета. Клавиатура: стрелки, Home/End, Enter, Esc; закрывается кликом мимо.
 */
export function Dropdown<T extends string>({
  value,
  onChange,
  options,
  label,
  id,
  up = false,
  disabled = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  label: string;
  id?: string;
  /** открывать вверх — у нижнего края окна */
  up?: boolean;
  disabled?: boolean;
}) {
  const auto = useId();
  const listId = `${id ?? auto}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const show = () => {
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    setOpen(true);
  };
  const pick = (v: T) => {
    onChange(v);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      show();
      return;
    }
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (options[active]) pick(options[active].value); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className={s.dd} ref={root}>
      <button
        type="button"
        id={id}
        className={s.ddButton}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        <span className={s.ddValue}>{current?.label ?? '—'}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <ul className={`${s.ddList} ${up ? s.ddUp : ''}`} role="listbox" id={listId} aria-label={label}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`${s.ddOption} ${i === active ? s.ddActive : ''}`}
              onPointerDown={e => { e.preventDefault(); pick(o.value); }}
              onPointerEnter={() => setActive(i)}
            >
              <span>
                {o.label}
                {o.hint && <small>{o.hint}</small>}
              </span>
              {o.value === value && <Check size={16} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Avatar({ person, index, size = 32 }: { person: StaffEntry; index: number; size?: number }) {
  const c = colorOf(person, index);
  return (
    <span className={s.avatar} aria-hidden="true" style={{ width: size, height: size, background: c.bg, color: c.fg, fontSize: size < 30 ? 10 : 12 }}>
      {initials(person.name || '?')}
    </span>
  );
}

export function useIsPhone() {
  const query = '(max-width: 768px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Печать готового HTML в скрытом окне — как печать листков в программе. */
export function printHtml(title: string, body: string) {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    body{font:13px/1.45 Inter,Arial,sans-serif;color:#1d1d27;margin:24px}
    h1{font-size:18px;margin:0 0 4px} p{margin:0 0 12px;color:#5f5f6d}
    table{border-collapse:collapse;width:100%;margin:12px 0} th,td{border:1px solid #d3d3dc;padding:6px 8px;text-align:left}
    th{background:#ebebef} td.n{text-align:right;white-space:nowrap} .sign{height:28px}
    section{page-break-inside:avoid;margin-bottom:24px}
  </style></head><body>${body}</body></html>`);
  doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  }, 200);
}

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Сумма числом из поля: «2 500», «2500,50» → 2500.5; пусто — null. */
export function parseMoney(text: string): number | null {
  const clean = String(text).replace(/\s| |₽/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function moneyInput(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '' : String(n).replace('.', ',');
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={s.block}>
      <div className={s.blockHead}>
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Время «ЧЧ:ММ» из поля: принимает «9», «9:5», «0930». */
export function parseClock(text: string): string | null {
  const t = String(text).trim().replace(/[.,]/g, ':');
  let h: number, m: number;
  if (/^\d{1,2}$/.test(t)) { h = Number(t); m = 0; }
  else if (/^\d{3,4}$/.test(t)) { h = Number(t.slice(0, -2)); m = Number(t.slice(-2)); }
  else {
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(t);
    if (!match) return null;
    h = Number(match[1]); m = Number(match[2]);
  }
  if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
