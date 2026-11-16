// Трёхстороннее слияние документов «Сотрудники» — то же, что делает программа (src-tauri/src/docs.rs).
// base — то, что сайт в последний раз видел на сервере; local — правки сайта; remote — то, что сейчас на сервере.
// Изменил только один — берём его; оба — сливаем по полям. Массивы объектов с уникальным ключом сливаются
// по элементам, поэтому правки разных людей и разных дней не теряют друг друга.
//
// Ключ элемента: `id` (сотрудники, выплаты, премии, удержания — как в программе), а также два правила,
// которых в программе до 1.15 нет: смены одного дня — по `staffId`, ставки с даты — по `from`.
// Без них правка одного и того же дня на сайте и на ПК целиком доставалась одному из них.
// Формат файла от этого не меняется: на выходе обычные массивы.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const IDS = "__ids";
const ORDER = "__order";

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function keyOf(arr: Json[]): string | null {
  if (!arr.length || !arr.every(isObj)) return null;
  for (const field of ["id", "staffId", "from"]) {
    const keys = arr.map((x) => (x as Obj)[field]);
    if (keys.every((k) => typeof k === "string" && k) && new Set(keys).size === keys.length) return field;
  }
  return null;
}

/** Массивы объектов с ключом → {__ids: {key: obj}, __order: [key]}. */
export function canon(v: unknown): Json {
  if (Array.isArray(v)) {
    const field = keyOf(v as Json[]);
    if (field) {
      const ids: Obj = {};
      const order: Json[] = [];
      for (const x of v as Obj[]) {
        const k = x[field] as string;
        order.push(k);
        ids[k] = canon(x);
      }
      return { [IDS]: ids, [ORDER]: order };
    }
    return (v as unknown[]).map(canon);
  }
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) out[k] = canon(x);
    return out;
  }
  return (v ?? null) as Json;
}

export function uncanon(v: Json): Json {
  if (isObj(v) && IDS in v) {
    const ids = isObj(v[IDS]) ? (v[IDS] as Obj) : {};
    const out: Json[] = [];
    const seen = new Set<string>();
    for (const id of Array.isArray(v[ORDER]) ? (v[ORDER] as Json[]) : []) {
      if (typeof id === "string" && id in ids && !seen.has(id)) {
        seen.add(id);
        out.push(uncanon(ids[id]));
      }
    }
    // добавленные на другом месте, которых нет в нашем порядке, — в конец
    for (const [id, x] of Object.entries(ids)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(uncanon(x));
      }
    }
    return out;
  }
  if (Array.isArray(v)) return v.map(uncanon);
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) out[k] = uncanon(x);
    return out;
  }
  return v;
}

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && same(a[k], b[k]));
  }
  return false;
}

const isIdset = (v: Json | undefined) => isObj(v) && IDS in v;
const isEmptyArray = (v: Json | undefined) => Array.isArray(v) && v.length === 0;

/** Пустой массив рядом с набором по ключу — это пустой набор, а не «другое значение». */
function mergeOpt(base: Json | undefined, local: Json | undefined, remote: Json | undefined): Json | undefined {
  // День, у которого убрали последнюю смену, пропадает из `shifts` целиком. Это «пустой набор», а не «другое
  // значение»: иначе смена, добавленная в тот же день в другом месте, возвращала бы и удалённые.
  if (isIdset(base) && (local === undefined) !== (remote === undefined)) {
    const empty = { [IDS]: {}, [ORDER]: [] };
    return mergeOpt(base, local ?? empty, remote ?? empty);
  }
  if ((isIdset(base) || isIdset(local) || isIdset(remote)) && (isEmptyArray(base) || isEmptyArray(local) || isEmptyArray(remote))) {
    const fix = (v: Json | undefined) => (isEmptyArray(v) ? { [IDS]: {}, [ORDER]: [] } : v);
    return mergeInner(fix(base), fix(local), fix(remote));
  }
  return mergeInner(base, local, remote);
}

function mergeInner(base: Json | undefined, local: Json | undefined, remote: Json | undefined): Json | undefined {
  const eq = (a: Json | undefined, b: Json | undefined) => (a === undefined || b === undefined ? a === b : same(a, b));
  if (eq(local, remote)) return local;
  if (eq(local, base)) return remote; // менял только другой (или удалил)
  if (eq(remote, base)) return local; // менял только этот
  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : undefined;
    const out: Obj = {};
    const keys = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();
    for (const k of keys) {
      const v = mergeOpt(b?.[k], local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  // первая встреча (базы нет): пустой список уступает непустому
  if (Array.isArray(local) && Array.isArray(remote) && base === undefined && local.length === 0 && remote.length > 0) return remote;
  // оба поменяли одно и то же значение — оставляем вариант этого места
  if (local !== undefined) return local;
  return remote;
}

/** Пустой набор → [] (как его отдаёт canon). */
function tidy(v: Json): Json {
  if (isObj(v) && IDS in v) {
    const ids = v[IDS];
    if (!isObj(ids) || !Object.keys(ids).length) return [];
  }
  if (Array.isArray(v)) return v.map(tidy);
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) out[k] = tidy(x);
    return out;
  }
  return v;
}

function filled(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return false;
}

const VITAL: Record<string, string[]> = { staff: ["staff_list"], schedule: ["shifts"] };

/**
 * Слить три версии документа. Возвращает обычный JSON (массивы, без служебных ключей).
 * Предохранитель как в программе: слияние не обнуляет список сотрудников и смены, которые есть у local.
 */
export function merge3<T>(key: "staff" | "schedule", base: unknown, local: T, remote: unknown): T {
  const b = base === undefined || base === null ? undefined : canon(base);
  const l = canon(local);
  const r = canon(remote);
  const merged = tidy((mergeOpt(b, l, r) ?? null) as Json);
  if (isObj(merged) && isObj(l)) {
    for (const field of VITAL[key] ?? []) {
      if (filled(l[field]) && !filled(merged[field])) merged[field] = l[field];
    }
  }
  const out = uncanon(merged);
  // день без смен программа не хранит (setShifts удаляет ключ) — убираем такие же и после слияния
  if (key === "schedule" && isObj(out) && isObj(out.shifts)) {
    for (const [day, list] of Object.entries(out.shifts)) if (Array.isArray(list) && !list.length) delete out.shifts[day];
  }
  return out as T;
}
