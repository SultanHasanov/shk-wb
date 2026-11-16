import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { conflictCurrent, fetchPointDocs, putStaffDoc, type StaffDocRow } from '../../../api/staff';
import { autoExtend, merge3, normalizeSchedule, same, type ScheduleData, type StaffDoc, type StaffEntry } from '../../../lib/staff-core';

/**
 * Документы пункта на сайте: загрузка, правки с отменой, автосохранение со сверкой версии и опрос сервера.
 *
 * Сохранение — та же схема, что у «Помощника ПВЗ»: PUT с версией, которую мы видели (base). Если на сервере уже
 * другая (правка с ПК или из другой вкладки), сервер отвечает 409 с текущей — сливаем трёхсторонне
 * (merge3: base — что видели, local — наши правки, remote — что там сейчас) и повторяем.
 * Поэтому одновременная работа на сайте и на компьютере пункта не теряет ничьих правок.
 */

export type DocKey = 'staff' | 'schedule';
export interface Snap {
  staff: StaffDoc;
  schedule: ScheduleData;
}
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'offline' | 'error';

const KEYS: DocKey[] = ['staff', 'schedule'];
const SAVE_DELAY_MS = 700;
const POLL_MS = 45_000;
const RETRY_MS = 15_000;
const UNDO_LIMIT = 60;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function normalizeStaff(raw: unknown): StaffDoc {
  const o = isObj(raw) ? raw : {};
  const list = Array.isArray(o.staff_list) ? o.staff_list : [];
  return {
    ...o,
    staff_list: list
      .filter((x): x is Record<string, unknown> => isObj(x) && typeof x.id === 'string' && Boolean(x.id))
      .map(x => ({ name: '', last4: '', sid: '', phone: '', ...x }) as StaffEntry),
    staff: isObj(o.staff) ? o.staff : {},
  };
}

const normalize = (key: DocKey, raw: unknown) => (key === 'staff' ? normalizeStaff(raw) : normalizeSchedule(raw));

interface ServerDoc {
  version: number;
  data: unknown;
}

export interface StaffDocs {
  status: 'loading' | 'ready' | 'error';
  error: unknown;
  snap: Snap | null;
  save: SaveStatus;
  savedAt: Date | null;
  /** правки в двух местах сразу слились — показать короткое уведомление */
  merged: number;
  /** сервер не дал стереть всех сотрудников или все смены без подтверждения */
  emptyGuard: DocKey | null;
  /** «Продлевать автоматически» добавило смены при открытии */
  extended: { count: number; until: string } | null;
  canUndo: boolean;
  canRedo: boolean;
  update: (fn: (s: Snap) => Snap, opts?: { undo?: boolean }) => void;
  /** начало мазка кистью: одна точка отмены на весь мазок */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  retry: () => void;
  reload: () => void;
  confirmEmpty: () => void;
  cancelEmpty: () => void;
  dismissExtended: () => void;
  /** что слилось с сервера после открытия: приходит при каждом изменении из другого места */
  applyRestored: (key: DocKey, version: number, data: unknown) => void;
}

export function useStaffDocs(pointId: string): StaffDocs {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [save, setSave] = useState<SaveStatus>('saved');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [merged, setMerged] = useState(0);
  const [emptyGuard, setEmptyGuard] = useState<DocKey | null>(null);
  const [extended, setExtended] = useState<{ count: number; until: string } | null>(null);
  const [history, setHistory] = useState<{ undo: Snap[]; redo: Snap[] }>({ undo: [], redo: [] });

  const local = useRef<Snap | null>(null);
  const server = useRef<Record<DocKey, ServerDoc>>({ staff: { version: 0, data: null }, schedule: { version: 0, data: null } });
  const dirty = useRef<Record<DocKey, boolean>>({ staff: false, schedule: false });
  const saving = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const confirmed = useRef<Record<DocKey, boolean>>({ staff: false, schedule: false });

  const setLocal = useCallback((next: Snap) => {
    local.current = next;
    if (alive.current) setSnap(next);
  }, []);

  const anyDirty = () => KEYS.some(k => dirty.current[k]);

  const mergeIn = useCallback((key: DocKey, remote: NonNullable<StaffDocRow>) => {
    const cur = local.current;
    if (!cur) return;
    const out = merge3(key, server.current[key].data, cur[key], remote.data);
    server.current[key] = { version: remote.version, data: remote.data };
    dirty.current[key] = !same(out, remote.data);
    setLocal({ ...cur, [key]: normalize(key, out) } as Snap);
  }, [setLocal]);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (saving.current) {
      again.current = true;
      return;
    }
    if (!anyDirty() || !local.current) {
      if (alive.current) setSave('saved');
      return;
    }
    saving.current = true;
    if (alive.current) setSave('saving');
    let failed: SaveStatus | null = null;
    try {
      for (const key of KEYS) {
        for (let attempt = 0; attempt < 4 && dirty.current[key]; attempt++) {
          const data = local.current![key];
          dirty.current[key] = false;
          try {
            const { version } = await putStaffDoc({ key, point: pointId, base: server.current[key].version, data, confirmEmpty: confirmed.current[key] || undefined });
            server.current[key] = { version, data };
            confirmed.current[key] = false;
            // пока шёл запрос, могли поправить ещё — тогда сохраним снова
            if (local.current![key] !== data) dirty.current[key] = true;
          } catch (err) {
            dirty.current[key] = true;
            const current = conflictCurrent(err);
            if (err instanceof ApiError && err.code === 'EMPTY_GUARD') {
              if (alive.current) setEmptyGuard(key);
              failed = 'error';
              break;
            }
            if (current && err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
              mergeIn(key, current);
              if (alive.current) setMerged(n => n + 1);
              continue;
            }
            failed = err instanceof ApiError && err.status > 0 && err.status < 500 ? 'error' : 'offline';
            break;
          }
        }
        if (failed) break;
      }
    } finally {
      saving.current = false;
    }
    if (!alive.current) return;
    if (failed) {
      setSave(failed);
      if (failed === 'offline') timer.current = setTimeout(() => void flush(), RETRY_MS);
      return;
    }
    if (again.current || anyDirty()) {
      again.current = false;
      timer.current = setTimeout(() => void flush(), 50);
      setSave('pending');
      return;
    }
    setSave('saved');
    setSavedAt(new Date());
  }, [pointId, mergeIn]);

  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (alive.current) setSave(s => (s === 'saving' ? s : 'pending'));
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [flush]);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const docs = await fetchPointDocs(pointId);
      if (!alive.current) return;
      for (const key of KEYS) {
        const row = docs[key];
        server.current[key] = { version: row?.version ?? 0, data: row?.data ?? null };
        dirty.current[key] = false;
      }
      let next: Snap = { staff: normalizeStaff(docs.staff?.data), schedule: normalizeSchedule(docs.schedule?.data) };
      // как программа при открытии раздела: «Продлевать автоматически» дозаполняет график до конца следующего месяца
      const ext = autoExtend(next.schedule, next.staff.staff_list);
      if (ext && ext.added.length) {
        next = { ...next, schedule: ext.data };
        dirty.current.schedule = true;
        setExtended({ count: ext.added.length, until: ext.until });
      }
      setLocal(next);
      setHistory({ undo: [], redo: [] });
      setStatus('ready');
      setSavedAt(null);
      if (dirty.current.schedule) scheduleSave();
      else setSave('saved');
    } catch (err) {
      if (!alive.current) return;
      setError(err);
      setStatus('error');
    }
  }, [pointId, setLocal, scheduleSave]);

  // опрос: правки с компьютера пункта появляются без перезагрузки страницы
  const poll = useCallback(async () => {
    if (saving.current || !local.current || document.visibilityState === 'hidden') return;
    let docs;
    try {
      docs = await fetchPointDocs(pointId);
    } catch {
      return;
    }
    if (!alive.current || saving.current || !local.current) return;
    let changed = false;
    for (const key of KEYS) {
      const row = docs[key];
      if (!row || row.version === server.current[key].version) continue;
      if (!dirty.current[key]) {
        server.current[key] = { version: row.version, data: row.data };
        setLocal({ ...local.current!, [key]: normalize(key, row.data) } as Snap);
      } else {
        mergeIn(key, row);
        changed = true;
      }
    }
    if (changed) scheduleSave();
  }, [pointId, setLocal, mergeIn, scheduleSave]);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = setInterval(() => void poll(), POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void poll();
    const onLeave = (e: BeforeUnloadEvent) => {
      if (anyDirty() || saving.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('beforeunload', onLeave);
      alive.current = false;
      // ушли на другой пункт или раздел — несохранённое отправляем сразу
      if (anyDirty()) void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointId]);

  const update = useCallback((fn: (s: Snap) => Snap, opts: { undo?: boolean } = {}) => {
    const cur = local.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    let changed = false;
    for (const key of KEYS) {
      if (next[key] !== cur[key]) {
        dirty.current[key] = true;
        changed = true;
      }
    }
    if (!changed) return;
    if (opts.undo !== false) setHistory(h => ({ undo: [...h.undo, cur].slice(-UNDO_LIMIT), redo: [] }));
    setLocal(next);
    scheduleSave();
  }, [setLocal, scheduleSave]);

  const checkpoint = useCallback(() => {
    const cur = local.current;
    if (cur) setHistory(h => ({ undo: [...h.undo, cur].slice(-UNDO_LIMIT), redo: [] }));
  }, []);

  const jump = useCallback((to: Snap, push: 'undo' | 'redo') => {
    const cur = local.current;
    if (!cur) return;
    for (const key of KEYS) if (to[key] !== cur[key]) dirty.current[key] = true;
    setHistory(h => (push === 'redo'
      ? { undo: h.undo.slice(0, -1), redo: [...h.redo, cur] }
      : { undo: [...h.undo, cur], redo: h.redo.slice(0, -1) }));
    setLocal(to);
    scheduleSave();
  }, [setLocal, scheduleSave]);

  const undo = useCallback(() => {
    const prev = history.undo[history.undo.length - 1];
    if (prev) jump(prev, 'redo');
  }, [history.undo, jump]);

  const redo = useCallback(() => {
    const next = history.redo[history.redo.length - 1];
    if (next) jump(next, 'undo');
  }, [history.redo, jump]);

  return {
    status,
    error,
    snap,
    save,
    savedAt,
    merged,
    emptyGuard,
    extended,
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
    update,
    checkpoint,
    undo,
    redo,
    retry: () => void flush(),
    reload: () => void load(),
    confirmEmpty: () => {
      if (!emptyGuard) return;
      confirmed.current[emptyGuard] = true;
      setEmptyGuard(null);
      void flush();
    },
    cancelEmpty: () => {
      if (emptyGuard) {
        // вернуть то, что на сервере
        const key = emptyGuard;
        dirty.current[key] = false;
        if (local.current) setLocal({ ...local.current, [key]: normalize(key, server.current[key].data) } as Snap);
      }
      setEmptyGuard(null);
      setSave('saved');
    },
    dismissExtended: () => setExtended(null),
    applyRestored: (key, version, data) => {
      server.current[key] = { version, data };
      dirty.current[key] = false;
      if (local.current) setLocal({ ...local.current, [key]: normalize(key, data) } as Snap);
      setHistory({ undo: [], redo: [] });
    },
  };
}
