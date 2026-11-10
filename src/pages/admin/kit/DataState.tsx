import type { ReactNode } from 'react';
import { CircleAlert, RotateCw } from 'lucide-react';
import { AdminApiError } from '../../../api/admin';
import { Button, Skeleton } from '../../../ui';
import k from './kit.module.css';

export interface DataStateProps<T> {
  query: { data: T | undefined; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  isEmpty?: (data: T) => boolean;
  empty: ReactNode;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}

/** «HTTP 502 · /api/admin/data?resource=audit»: адрес без лишних параметров, но с ресурсом. */
export function errorMeta(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  const [path, query = ''] = error.path.split('?');
  const first = query.split('&').find(Boolean);
  return `HTTP ${error.status} · ${first ? `${path}?${first}` : path}`;
}

function messageOf(error: unknown): string {
  if (error instanceof AdminApiError && error.status >= 500) return 'Сервер не ответил. Ничего не потеряно — попробуйте ещё раз.';
  if (error instanceof Error && error.message) return error.message;
  return 'Ничего не потеряно — попробуйте ещё раз.';
}

export function DefaultSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className={k.loading}>
      {Array.from({ length: rows }, (_, index) => (
        <div className={k.skeletonRow} key={index}>
          <Skeleton width="36px" height={36} />
          <Skeleton width={`${70 - index * 8}%`} height={14} />
          <Skeleton width="80px" height={14} />
        </div>
      ))}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => unknown }) {
  const meta = errorMeta(error);
  return (
    <div className={k.errorBox} role="alert">
      <div className={k.errorTitle}>
        <CircleAlert size={18} aria-hidden="true" />
        Не удалось загрузить данные
      </div>
      <div>{messageOf(error)}</div>
      {meta && <div className={k.errorMeta}>{meta}</div>}
      {onRetry && (
        <Button variant="secondary" className={k.tap} onClick={() => void onRetry()}>
          <RotateCw size={16} aria-hidden="true" />
          Повторить
        </Button>
      )}
    </div>
  );
}

/**
 * Три разных состояния асинхронного блока: загрузка (скелет), пусто, ошибка.
 * Подменять их друг другом нельзя (CLAUDE.md): «пусто» при сбое — ложь,
 * вечный скелет при ошибке — тоже.
 */
export function DataState<T>({ query, isEmpty, empty, skeleton, children }: DataStateProps<T>) {
  const { data, isPending, isError, error, refetch } = query;

  if (data === undefined) {
    if (isError) return <ErrorBlock error={error} onRetry={refetch} />;
    if (isPending) {
      return (
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">Загрузка…</span>
          {skeleton ?? <DefaultSkeleton />}
        </div>
      );
    }
    return <ErrorBlock error={error} onRetry={refetch} />;
  }

  // Данные есть, но обновление упало: показываем прежние и честно говорим, что они не свежие.
  const stale = isError ? (
    <div className={k.staleNote} role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      Не удалось обновить — показаны прежние данные.
      <Button variant="ghost" size="sm" className={k.tap} onClick={() => void refetch()}>
        Повторить
      </Button>
    </div>
  ) : null;

  if (isEmpty?.(data)) {
    return (
      <>
        {stale}
        {empty}
      </>
    );
  }

  return (
    <>
      {stale}
      {children(data)}
    </>
  );
}

/** Пустое состояние в стиле макета States: заголовок, пояснение, действие. */
export function EmptyBlock({ title, text, action, icon }: { title: string; text?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={k.emptyBox}>
      {icon}
      <strong>{title}</strong>
      {text && <div>{text}</div>}
      {action}
    </div>
  );
}
