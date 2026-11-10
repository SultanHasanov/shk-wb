/**
 * Общие компоненты админки. Страницы и карточка пользователя импортируют
 * отсюда, а не из отдельных файлов: состав кита — контракт (раздел 5.3).
 */
export { ConfirmDialog, REASON_MAX } from './ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog';
export { NumberDialog, parseBoundedInt } from './NumberDialog';
export type { NumberDialogProps } from './NumberDialog';
export { ResponsiveTable } from './ResponsiveTable';
export type { ResponsiveColumn, ResponsiveTableProps } from './ResponsiveTable';
export { AuditEntry } from './AuditEntry';
export type { AuditEntryProps } from './AuditEntry';
export { StatusDot } from './StatusDot';
export type { StatusDotProps } from './StatusDot';
export { ChipFilter } from './ChipFilter';
export type { ChipFilterProps } from './ChipFilter';
export { DataState, DefaultSkeleton, EmptyBlock, ErrorBlock, errorMeta } from './DataState';
export type { DataStateProps } from './DataState';
export { TermPicker, DATE_PRESETS, mskToday } from './TermPicker';
export type { TermPickerProps } from './TermPicker';
export { errorText, newIdempotencyKey, useConfirmAction, useIdempotencyKey } from './useConfirmAction';
