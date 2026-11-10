import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Skeleton, Table } from '../../../ui';
import k from './kit.module.css';

export type ResponsiveColumn<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Подпись в карточке на телефоне (data-label); по умолчанию header, если это строка. */
  label?: string;
  align?: 'start' | 'end';
  /** Заголовок карточки на телефоне; в нём же ссылка строки. */
  primary?: boolean;
  hideOnMobile?: boolean;
  width?: string;
};

export interface ResponsiveTableProps<T> {
  rows: readonly T[];
  columns: readonly ResponsiveColumn<T>[];
  rowKey: (row: T) => string | number;
  /** Строка/карточка — настоящая <Link> (клавиатура, средняя кнопка). */
  rowHref?: (row: T) => string;
  rowActions?: (row: T) => ReactNode;
  selectedKey?: string | number;
  caption?: string;
  loading?: boolean;
  skeletonRows?: number;
  empty?: ReactNode;
}

function labelOf<T>(column: ResponsiveColumn<T>): string {
  if (column.label !== undefined) return column.label;
  return typeof column.header === 'string' ? column.header : column.key;
}

/**
 * Таблица, которая на телефоне (≤ 768 px) становится стопкой карточек: те же
 * <tr>/<td>, а подписи колонок приходят из data-label. Одна разметка — нет
 * расхождения между «десктопной» и «мобильной» версиями и не нужен JS на размер окна.
 */
export function ResponsiveTable<T>({
  rows,
  columns,
  rowKey,
  rowHref,
  rowActions,
  selectedKey,
  caption,
  loading = false,
  skeletonRows = 5,
  empty,
}: ResponsiveTableProps<T>) {
  const primaryIndex = Math.max(0, columns.findIndex(column => column.primary));

  if (!loading && rows.length === 0) {
    return <>{empty ?? <EmptyState title="Пока ничего нет" text="Здесь появятся записи." />}</>;
  }

  return (
    <div className={k.rtRoot}>
      <Table className={k.rt} aria-busy={loading || undefined}>
        {caption && <caption className={k.rtCaption}>{caption}</caption>}
        <thead>
          <tr>
            {columns.map(column => (
              <th
                key={column.key}
                scope="col"
                className={column.align === 'end' ? k.alignEnd : undefined}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
            {rowActions && (
              <th scope="col" className={k.alignEnd}>
                <span className="sr-only">Действия</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }, (_, index) => (
                <tr key={`skeleton-${index}`} aria-hidden="true">
                  {columns.map((column, columnIndex) => (
                    <td
                      key={column.key}
                      className={[
                        columnIndex === primaryIndex ? k.primaryCell : '',
                        column.hideOnMobile ? k.hideOnMobile : '',
                      ].join(' ')}
                    >
                      <Skeleton width={columnIndex === primaryIndex ? '70%' : '50%'} height={14} />
                    </td>
                  ))}
                  {rowActions && <td className={k.actionsCell} />}
                </tr>
              ))
            : rows.map(row => {
                const key = rowKey(row);
                const href = rowHref?.(row);
                const selected = selectedKey !== undefined && selectedKey === key;
                return (
                  <tr key={key} className={selected ? k.rowSelected : undefined} data-selected={selected || undefined}>
                    {columns.map((column, columnIndex) => {
                      const isPrimary = columnIndex === primaryIndex;
                      const content = column.cell(row);
                      const classes = [
                        isPrimary ? k.primaryCell : '',
                        column.align === 'end' ? k.alignEnd : '',
                        column.hideOnMobile ? k.hideOnMobile : '',
                      ]
                        .filter(Boolean)
                        .join(' ');
                      return (
                        <td key={column.key} data-label={labelOf(column)} className={classes || undefined}>
                          {isPrimary && href ? (
                            <Link to={href} className={k.rowLink}>
                              {content}
                            </Link>
                          ) : (
                            content
                          )}
                        </td>
                      );
                    })}
                    {rowActions && (
                      <td className={k.actionsCell} data-label="Действия">
                        <div className={k.actions}>{rowActions(row)}</div>
                      </td>
                    )}
                  </tr>
                );
              })}
        </tbody>
      </Table>
    </div>
  );
}
