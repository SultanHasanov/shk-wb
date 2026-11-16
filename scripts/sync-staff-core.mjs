// «Сотрудники» живут в двух местах: на сайте и в программе «Помощник ПВЗ». Чтобы они не расходились,
// расчёты и экраны пишутся на сайте, а в программу попадают копией. Этот скрипт копирует и сверяет.
//
//   node scripts/sync-staff-core.mjs --check   сверить (код выхода 1, если копии разошлись)
//   node scripts/sync-staff-core.mjs --write   скопировать с сайта в программу
//
// Программа лежит в _local-only/pvz-tauri (не в git). Если её рядом нет — скрипт молча выходит с нулём.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prog = join(root, '_local-only', 'pvz-tauri');

/** Папка расчётов целиком, кроме типов (в программе свои, от её StaffEntry) и тестов. */
const CORE_FROM = join(root, 'src', 'lib', 'staff-core');
const CORE_TO = join(prog, 'src', 'lib', 'staff-core');
const CORE_SKIP = new Set(['types.ts']);

/** Экраны: глубина папок совпадает, поэтому импорты `../../../ui` и `../../../lib/staff-core` те же. */
const UI_FROM = join(root, 'src', 'pages', 'cabinet', 'staff');
const UI_TO = join(prog, 'src', 'screens', 'staff', 'web');
const UI_FILES = ['ScheduleTab.tsx', 'DayPanel.tsx', 'DayQuickPick.tsx', 'MonthCalendar.tsx', 'TemplateWizard.tsx', 'ReplaceDialog.tsx', 'PayrollTab.tsx', 'parts.tsx', 'staff.module.css'];

export function mirrorPairs() {
  const core = readdirSync(CORE_FROM)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !CORE_SKIP.has(f))
    .map(f => [join(CORE_FROM, f), join(CORE_TO, f)]);
  return [...core, ...UI_FILES.map(f => [join(UI_FROM, f), join(UI_TO, f)])];
}

/** Сравниваем без учёта переводов строк: на сайте файлы в CRLF, в программе в LF. */
const text = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

export function diffMirror() {
  if (!existsSync(prog)) return null;
  return mirrorPairs().filter(([from, to]) => !existsSync(to) || text(from) !== text(to)).map(([, to]) => to);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv[2];
  if (!existsSync(prog)) {
    console.log('Программы рядом нет (_local-only/pvz-tauri) — сверять нечего.');
    process.exit(0);
  }
  if (mode === '--write') {
    let n = 0;
    for (const [from, to] of mirrorPairs()) {
      if (existsSync(to) && text(from) === text(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, text(from));
      n++;
    }
    console.log(n ? `Скопировано в программу файлов: ${n}` : 'Копии в программе уже совпадают с сайтом.');
  } else if (mode === '--check') {
    const bad = diffMirror();
    if (bad.length) {
      console.error(`Копии в программе отличаются от сайта (${bad.length}):\n${bad.map(f => `  ${f}`).join('\n')}\nВыполните: node scripts/sync-staff-core.mjs --write`);
      process.exit(1);
    }
    console.log('Копии в программе совпадают с сайтом.');
  } else {
    console.error('Укажите --check или --write');
    process.exit(2);
  }
}
