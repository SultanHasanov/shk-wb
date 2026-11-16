// Общее ядро раздела «Сотрудники» для сайта и «Помощника ПВЗ».
// schedule.ts и payroll.ts — копия файлов программы (_local-only/pvz-tauri/src/lib) без изменений:
// формат schedule.json и staff_list тот же, что у программ 1.9–1.14, — старые версии читают то, что пишет сайт.
// Тип сотрудника повторяет `StaffEntry` из src/lib/types.ts программы.

export interface StaffEntry {
  id: string;
  name: string;
  last4: string;
  sid: string;
  phone: string;
  /** имя, как оно записано в WB (при импорте); своё имя — в `name`, импорт его не меняет */
  wbName?: string;
  /** индекс цвета в PALETTE (lib/schedule.ts) */
  color?: number;
  /** false — не работает: скрыт из графика, остаётся в прошлых месяцах */
  active?: boolean;
  /** ставка за смену с даты */
  rates?: { from: string; rate: number }[];
  /** как платим: shift — фикс за смену (по умолчанию), shk — за принятые ШК */
  payMode?: "shift" | "shk";
  /** своя цена за принятый ШК с даты; нет — общая цена из настроек зарплаты */
  shkRates?: { from: string; rate: number }[];
}

/**
 * Документ `staff` в облаке: `staff_list` — список, `staff` — старый формат CustomTkinter-версии
 * (`{<sid>: {rate, shifts}}`). Старое поле и любые неизвестные ключи сохраняются как есть.
 */
export interface StaffDoc {
  staff_list: StaffEntry[];
  staff?: Record<string, unknown>;
  [key: string]: unknown;
}
