import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithRef,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  TableHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Inbox,
  Info,
  Loader2,
  TriangleAlert,
  X,
} from 'lucide-react';
import s from './ui.module.css';
import { useT } from '../i18n';

/* ============ Spinner ============ */

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className={s.spinner} aria-hidden="true" />;
}

/* ============ Button ============ */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  block?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  className = '',
  disabled,
  children,
  ...p
}: ButtonProps) {
  const classes = [s.button, s[variant], size !== 'md' && s[size], block && s.block, className]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} disabled={disabled || loading} aria-busy={loading} {...p}>
      {loading && <Spinner size={size === 'sm' ? 14 : 18} />}
      {children}
    </button>
  );
}

/* ============ Field ============
   Клонирует единственного потомка, чтобы связать подпись, ошибку и подсказку с
   самим полем. Раньше связи не было вовсе: класс .inputError существовал в CSS,
   но не применялся, и при ошибке краснел только текст под полем. */

export function Field({
  label,
  error,
  help,
  hint,
  children,
}: {
  label: string;
  error?: string;
  help?: string;
  /** Пояснение за иконкой «?» рядом с подписью — для того, что не влезает в help. */
  hint?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const describedBy = [error ? errorId : null, help && !error ? helpId : null]
    .filter(Boolean)
    .join(' ');

  const child = Children.only(children);
  // Собственный id поля имеет приоритет, и подпись должна указывать именно на него,
  // иначе связь label↔input рвётся.
  const controlId = (isValidElement(child) && (child.props as Record<string, unknown>).id) || id;
  const control = isValidElement(child)
    ? cloneElement(child as ReactElement<Record<string, unknown>>, {
        id: controlId,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy || undefined,
      })
    : child;

  return (
    <div className={s.field}>
      {hint ? (
        <span className={s.labelRow}>
          <label className={s.label} htmlFor={controlId as string}>
            {label}
          </label>
          <Hint label={label}>{hint}</Hint>
        </span>
      ) : (
        <label className={s.label} htmlFor={controlId as string}>
          {label}
        </label>
      )}
      {control}
      {error && (
        <span className={s.error} id={errorId} role="alert">
          {error}
        </span>
      )}
      {help && !error && (
        <span className={s.help} id={helpId}>
          {help}
        </span>
      )}
    </div>
  );
}

export function Input({ className = '', ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${s.input} ${className}`} {...p} />;
}

export function Select({ className = '', ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${s.select} ${className}`} {...p} />;
}

export function Textarea({ className = '', ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${s.textarea} ${className}`} {...p} />;
}

/* ============ Segmented ============
   Заменяет россыпь <Button> с переключением variant, которой раньше собирались
   переключатели «Товары/QR коробок» и «Массово/По номеру». */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  label: string;
}) {
  return (
    <div className={s.segmented} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`${s.segment} ${value === o.value ? s.segmentActive : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ============ Tabs ============
   Реализовано на нативных кнопках, а не на @radix-ui/react-tabs: визуально это
   тот же .segmented, что уже есть в ките, а всё недостающее — роли ARIA и
   стрелки влево/вправо. Ради двух десятков строк зависимость не окупается.

   Работает и управляемым (передан value), и неуправляемым. */

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<{ value: T; label: string; icon?: ReactNode; content?: ReactNode }>;
  value?: T;
  onChange?: (v: T) => void;
  label: string;
}) {
  const id = useId();
  const [inner, setInner] = useState<T>(items[0].value);
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const current = value ?? inner;

  function select(next: T) {
    if (value === undefined) setInner(next);
    onChange?.(next);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex(item => item.value === current);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next === -1) return;

    event.preventDefault();
    const target = items[next].value;
    select(target);
    refs.current[target]?.focus();
  }

  const active = items.find(item => item.value === current);

  return (
    <>
      <div className={s.tablist} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map(item => {
          const selected = item.value === current;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`${id}-${item.value}-tab`}
              aria-selected={selected}
              aria-controls={`${id}-${item.value}-panel`}
              // Roving tabindex: в таблист Tab-ом заходят один раз, дальше стрелки
              tabIndex={selected ? 0 : -1}
              ref={node => {
                refs.current[item.value] = node;
              }}
              className={`${s.tab} ${selected ? s.tabActive : ''}`}
              onClick={() => select(item.value)}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>

      {active?.content && (
        <div
          role="tabpanel"
          id={`${id}-${active.value}-panel`}
          aria-labelledby={`${id}-${active.value}-tab`}
          tabIndex={0}
          className={s.tabpanel}
        >
          {active.content}
        </div>
      )}
    </>
  );
}

/* ============ Accordion ============
   Нативные <details>/<summary>: без JS и без состояния, ответы лежат в DOM
   сразу. Разметка переехала сюда из Faq, чтобы её могли переиспользовать
   продуктовые страницы. */

export function Accordion({ items }: { items: ReadonlyArray<{ q: string; a: ReactNode }> }) {
  return (
    <div className={s.accordion}>
      {items.map(item => (
        // data-faq помечает именно FAQ: build-static.mjs собирает FAQPage только из
        // details[data-faq], чтобы в schema.org не попали меню-шторки и прочие <details>.
        <details key={item.q} className={s.accordionItem} data-faq>
          <summary className={s.accordionQ}>
            {item.q}
            <ChevronDown size={18} className={s.accordionChevron} aria-hidden="true" />
          </summary>
          <div className={s.accordionA}>{item.a}</div>
        </details>
      ))}
    </div>
  );
}

/* ============ Progress ============
   Тон считается от заполненности, но его можно задать вручную: «занято 2 из 3
   устройств» — это предупреждение, а «истрачено 2 из 3 генераций» — нет. */

export function Progress({
  value,
  max,
  label,
  tone,
}: {
  value: number;
  max: number;
  label?: ReactNode;
  tone?: 'accent' | 'warning' | 'danger';
}) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(Math.max(value / safeMax, 0), 1);
  const auto = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'accent';
  const cls = { accent: s.barAccent, warning: s.barWarning, danger: s.barDanger }[tone ?? auto];

  return (
    <div className={s.progress}>
      {label && <div className={s.progressLabel}>{label}</div>}
      <div
        className={s.track}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={safeMax}
      >
        <span className={`${s.bar} ${cls}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/* ============ Switch ============
   Для настроек-переключателей. Checkbox остаётся для согласий («принимаю
   оферту»), где нужна именно галочка в форме. */

export function Switch({
  children,
  id,
  description,
  ...p
}: InputHTMLAttributes<HTMLInputElement> & { description?: string }) {
  const generated = useId();
  const inputId = id ?? generated;
  const descId = `${inputId}-desc`;

  return (
    <div className={s.switchRow}>
      <div>
        <label className={s.switchLabel} htmlFor={inputId}>
          {children}
        </label>
        {description && (
          <p className={s.switchDesc} id={descId}>
            {description}
          </p>
        )}
      </div>
      <input
        type="checkbox"
        role="switch"
        id={inputId}
        className={s.switch}
        aria-describedby={description ? descId : undefined}
        {...p}
      />
    </div>
  );
}

/* ============ Menu ============
   Выпадающее меню с закрытием по клику вне и Escape. Логика была написана
   прямо в CabinetShell — вынесена, чтобы её могли переиспользовать строки
   таблиц. */

export function Menu({
  trigger,
  children,
  label,
  align = 'end',
}: {
  trigger: (props: { open: boolean }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  label: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={s.menuRoot} ref={root}>
      <button
        type="button"
        className={s.menuTrigger}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        onClick={() => setOpen(v => !v)}
      >
        {trigger({ open })}
      </button>

      {open && (
        <div className={`${s.menu} ${align === 'start' ? s.menuStart : ''}`} role="menu">
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  danger = false,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`${s.menuItem} ${danger ? s.menuDanger : ''}`}
      {...p}
    >
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className={s.menuLabel}>{children}</div>;
}

/* ============ Pagination ============ */

export function Pagination({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
}) {
  const t = useT();
  if (pages <= 1) return null;

  return (
    <nav className={s.pagination} aria-label={t('Постраничная навигация', 'Беттер бойынша навигация')}>
      <Button
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label={t('Предыдущая страница', 'Алдыңғы бет')}
      >
        <ChevronLeft size={16} />
        {t('Назад', 'Артқа')}
      </Button>

      <span className={s.paginationInfo} aria-live="polite">
        {t(`Страница ${page} из ${pages}`, `${pages} ішінен ${page}-бет`)}
      </span>

      <Button
        variant="ghost"
        size="sm"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
        aria-label={t('Следующая страница', 'Келесі бет')}
      >
        {t('Вперёд', 'Алға')}
        <ChevronRight size={16} />
      </Button>
    </nav>
  );
}

/* ============ Avatar ============ */

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      className={s.avatar}
      style={{ width: size, height: size, fontSize: Math.round(size / 2.4) }}
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/* ============ PriceTable ============
   Таблица «период × количество» с выбором ячейки. Сама по себе цена в такой
   сетке читается лучше, чем списком карточек: видно и строку, и столбец. */

export type PriceCell = {
  label: string;
  active?: boolean;
  onSelect?: () => void;
};

export function PriceTable({
  caption,
  head,
  rows,
}: {
  caption?: string;
  head: readonly string[];
  rows: ReadonlyArray<{ label: string; cells: readonly PriceCell[] }>;
}) {
  const t = useT();
  return (
    <Table className={s.priceTable}>
      {caption && <caption className={s.priceCaption}>{caption}</caption>}
      <thead>
        <tr>
          <th scope="col">{t('Период', 'Кезең')}</th>
          {head.map(h => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.label}>
            <th scope="row" className={s.priceRowHead}>
              {row.label}
            </th>
            {row.cells.map((cell, i) => (
              <td key={i} className={s.priceCellWrap}>
                {cell.onSelect ? (
                  <button
                    type="button"
                    className={`${s.priceCell} ${cell.active ? s.priceCellActive : ''}`}
                    aria-pressed={cell.active}
                    onClick={cell.onSelect}
                  >
                    {cell.label}
                  </button>
                ) : (
                  <span className={s.priceCell}>{cell.label}</span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ============ Card ============ */

export function Card({
  children,
  accent = false,
  interactive = false,
  flush = false,
  className = '',
}: {
  children: ReactNode;
  accent?: boolean;
  interactive?: boolean;
  flush?: boolean;
  className?: string;
}) {
  const classes = [
    s.card,
    accent && s.cardAccent,
    interactive && s.cardInteractive,
    flush && s.cardFlush,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <section className={classes}>{children}</section>;
}

/* ============ Badge ============ */

const badgeTone = {
  default: '',
  success: s.success,
  warning: s.warning,
  accent: s.accentBadge,
  error: s.errorBadge,
} as const;

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: keyof typeof badgeTone;
}) {
  return <span className={`${s.badge} ${badgeTone[tone]}`}>{children}</span>;
}

/* ============ Alert ============
   Раньше ошибки выводились инлайновыми стилями в двух местах:
   <p style={{color:'var(--danger)'}}>. */

const alertTone = {
  error: { cls: s.alertError, Icon: CircleAlert },
  warning: { cls: s.alertWarning, Icon: TriangleAlert },
  success: { cls: s.alertSuccess, Icon: CircleCheck },
  info: { cls: s.alertInfo, Icon: Info },
} as const;

export function Alert({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: keyof typeof alertTone;
}) {
  const { cls, Icon } = alertTone[tone];
  return (
    <div className={`${s.alert} ${cls}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={17} />
      <div>{children}</div>
    </div>
  );
}

/* ============ Stat ============ */

export function Stat({
  value,
  label,
  icon,
  hint,
  tone,
}: {
  value: ReactNode;
  label: string;
  icon?: ReactNode;
  hint?: ReactNode;
  tone?: 'success' | 'danger';
}) {
  const valueCls = [s.statValue, tone === 'success' && s.statSuccess, tone === 'danger' && s.statDanger]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={s.stat}>
      {icon && <div className={s.statIcon}>{icon}</div>}
      <div className={valueCls}>{value}</div>
      <div className={s.statLabel}>
        {label}
        {hint && <Hint label={label}>{hint}</Hint>}
      </div>
    </div>
  );
}

/* ============ Hint ============
   Иконка «?» с пояснением. Открывается наведением, фокусом и тапом (на телефоне
   наведения нет), закрывается по Esc, клику мимо и прокрутке. Поповер рисуется
   в портал с position: fixed — иначе его обрезают таблицы с overflow: auto. */

export function Hint({ children, label }: { children: ReactNode; label?: string }) {
  const t = useT();
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(300, window.innerWidth - 32);
      const left = Math.min(Math.max(16, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 16);
      setPos({ top: rect.bottom + 8, left });
    }
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    setOpen(false);
    setPinned(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) hide();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={s.hintButton}
        aria-label={label ? t(`Подсказка: ${label}`, `Кеңес: ${label}`) : t('Подсказка', 'Кеңес')}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={() => !pinned && hide()}
        onFocus={show}
        onBlur={() => !pinned && hide()}
        onClick={() => {
          if (pinned) hide();
          else {
            show();
            setPinned(true);
          }
        }}
      >
        <CircleHelp size={15} aria-hidden="true" />
      </button>
      {open &&
        pos &&
        createPortal(
          <span role="tooltip" id={id} className={s.hintPopover} style={{ top: pos.top, left: pos.left }}>
            {children}
          </span>,
          document.body,
        )}
    </>
  );
}

/* ============ Table ============ */

export function Table({ children, className, ...p }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className={s.tableWrap}>
      {/* Свой className дополняет базовый, а не заменяет: иначе таблица цен
          теряла шапку, отступы и разделители. */}
      <table className={className ? `${s.table} ${className}` : s.table} {...p}>
        {children}
      </table>
    </div>
  );
}

/* ============ Skeleton ============ */

export function Skeleton({ width = '100%', height = 18 }: { width?: string; height?: number }) {
  return <div className={s.skeleton} style={{ width, height }} />;
}

/* ============ EmptyState ============ */

export function EmptyState({
  title,
  text,
  icon,
  action,
}: {
  title?: string;
  text?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  const t = useT();
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon}>{icon ?? <Inbox size={26} />}</div>
      <strong>{title ?? t('Данных пока нет', 'Әзірге деректер жоқ')}</strong>
      <p>{text ?? t('Здесь появятся данные после первого действия.', 'Деректер алғашқы әрекеттен кейін осында пайда болады.')}</p>
      {action}
    </div>
  );
}

/* ============ Checkbox ============ */

/**
 * Отдельные <input id> и <label for> вместо обёртки: если подпись содержит
 * ссылку (оферта, политика), внутри общего <label> клик по ней переключал бы
 * галочку вместо перехода.
 *
 * Props с ref, а не InputHTMLAttributes: без него react-hook-form не достаёт до
 * поля и согласие с офертой всегда приходило в форму пустым.
 */
export function Checkbox({ children, id, ...p }: ComponentPropsWithRef<'input'>) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className={s.check}>
      <input type="checkbox" id={inputId} {...p} />
      <label htmlFor={inputId}>{children}</label>
    </div>
  );
}

/* ============ Modal ============ */

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.dialog}>
          <Dialog.Title asChild>
            <h2>{title}</h2>
          </Dialog.Title>
          {/* Без Description Radix пишет предупреждение о доступности в консоль */}
          <Dialog.Description className={s.dialogDesc}>
            {description ?? t(`Диалог «${title}».`, `«${title}» диалогы.`)}
          </Dialog.Description>
          <Dialog.Close className={s.dialogClose} aria-label={t('Закрыть', 'Жабу')}>
            <X size={20} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ============ Toast ============
   Очередь с автоскрытием и порталом. Раньше в KeysPage и UiInventoryPage был
   продублирован ручной setTimeout со своим useState. */

type ToastTone = 'default' | 'success' | 'error';
type ToastItem = { id: number; text: string; tone: ToastTone };

const ToastContext = createContext<(text: string, tone?: ToastTone) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((text: string, tone: ToastTone = 'default') => {
    const id = ++seq.current;
    setItems(prev => [...prev, { id, text, tone }]);
    setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  const viewport = useMemo(
    () =>
      items.length > 0 && typeof document !== 'undefined'
        ? createPortal(
            <div className={s.toastViewport}>
              {items.map(t => (
                <div
                  key={t.id}
                  role="status"
                  className={`${s.toast} ${t.tone === 'error' ? s.toastError : t.tone === 'success' ? s.toastSuccess : ''}`}
                >
                  {t.tone === 'success' && <CircleCheck size={16} />}
                  {t.tone === 'error' && <CircleAlert size={16} />}
                  {t.text}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null,
    [items],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      {viewport}
    </ToastContext.Provider>
  );
}

/* ============ TileGroup ============
   Крупные плитки-переключатели с картинкой/иконкой и описанием (выбор вида
   генерации «Стикеры / QR коробок»). Радиогруппа с ролями и стрелками, как
   Segmented, но с местом под медиа. */

export function TileGroup<T extends string>({
  value,
  onChange,
  options,
  label,
  columns = 2,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; description?: string; media?: ReactNode }>;
  label: string;
  columns?: number;
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = options.findIndex(o => o.value === value);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next === -1) return;
    event.preventDefault();
    const target = options[next].value;
    onChange(target);
    refs.current[target]?.focus();
  }

  return (
    <div
      className={s.tileGroup}
      role="radiogroup"
      aria-label={label}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      onKeyDown={onKeyDown}
    >
      {options.map(o => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            ref={node => {
              refs.current[o.value] = node;
            }}
            className={`${s.tile} ${selected ? s.tileActive : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.media && <span className={s.tileMedia}>{o.media}</span>}
            <span className={s.tileLabel}>{o.label}</span>
            {o.description && <span className={s.tileDesc}>{o.description}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ============ ScreenshotSlot ============
   Рамка под скриншот программы с фиксированными размерами (без сдвига макета,
   CLS=0). Пока картинки нет — показывает заглушку с подписью, чтобы владелец
   видел, куда вставлять. src принимает webp/png; aspect-ratio держит высоту. */

export function ScreenshotSlot({
  src,
  alt,
  caption,
  ratio = '16 / 10',
  priority = false,
}: {
  src?: string;
  alt: string;
  caption?: string;
  /** CSS aspect-ratio строкой, напр. "16 / 10". Держит высоту до загрузки. */
  ratio?: string;
  /** true только для LCP-изображения (одного на страницу). */
  priority?: boolean;
}) {
  // Превью обрезается рамкой (object-fit: cover), поэтому по клику открываем
  // снимок целиком в оверлее — закрытие по фону, крестику или Escape.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <figure className={s.shot} style={{ aspectRatio: ratio }}>
      {src ? (
        <button
          type="button"
          className={s.shotZoom}
          onClick={() => setOpen(true)}
          aria-label={`${alt} — открыть в полном размере`}
        >
          <img
            className={s.shotImg}
            src={src}
            alt={alt}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            // @ts-expect-error fetchpriority — валидный HTML-атрибут, типы React отстают
            fetchpriority={priority ? 'high' : undefined}
          />
        </button>
      ) : (
        <div className={s.shotPlaceholder} aria-hidden="true">
          <span className={s.shotCap}>{caption ?? alt}</span>
          <span className={s.shotHint}>скриншот появится здесь</span>
        </div>
      )}
      {src && caption && <figcaption className={s.shotCaption}>{caption}</figcaption>}

      {open && src && createPortal(
        <div className={s.lightbox} role="dialog" aria-modal="true" aria-label={alt} onClick={() => setOpen(false)}>
          <button type="button" className={s.lightboxClose} aria-label="Закрыть" onClick={() => setOpen(false)}>×</button>
          <img className={s.lightboxImg} src={src} alt={alt} onClick={e => e.stopPropagation()} />
        </div>,
        document.body,
      )}
    </figure>
  );
}

/* ============ AnswerBlock ============
   AEO: заголовок-вопрос (H2) + короткий прямой ответ, который ИИ-поисковики и
   быстрые ответы берут целиком. Подробности — в children под ответом. */

export function AnswerBlock({
  question,
  answer,
  children,
  id,
}: {
  question: string;
  answer: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <div className={s.answer} id={id}>
      <h2 className={s.answerQ}>{question}</h2>
      <p className={s.answerA}>{answer}</p>
      {children}
    </div>
  );
}

/* ============ BalanceChip ============
   Чип баланса для топбара кабинета. Презентационный: ссылку «Пополнить» рисует
   вызывающий (кабинет ходит через react-router Link + lp()). */

export function BalanceChip({
  label,
  value,
  action,
}: {
  label: string;
  value: ReactNode;
  action?: ReactNode;
}) {
  return (
    <span className={s.balanceChip}>
      <span className={s.balanceLabel}>{label}</span>
      <span className={s.balanceValue}>{value}</span>
      {action}
    </span>
  );
}
