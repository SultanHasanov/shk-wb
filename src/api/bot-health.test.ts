import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

let health: {
  evaluateUpdates: (items: Array<{ ms: number; failed?: boolean; incident?: string }>, options?: { slowMs?: number }) => { total: number; failed: number; slow: number; worst: number; degraded: boolean; incidents: string[] };
  report: (key: string, problem: string | null, okText: string, options: { now: number; send: (text: string) => Promise<boolean> }) => Promise<void>;
};
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bot-health-'));
  process.env.BOT_HEALTH_STATE = join(dir, 'state.json');
  health = require('../../server/_bot-health.js');
});
afterAll(() => {
  delete process.env.BOT_HEALTH_STATE;
  rmSync(dir, { recursive: true, force: true });
});

describe('здоровье бота: оценка окна апдейтов', () => {
  it('три ошибки или треть медленных — перебои, иначе норма', () => {
    const ok = health.evaluateUpdates([{ ms: 200 }, { ms: 400 }, { ms: 3500 }, { ms: 300 }]);
    expect(ok.degraded).toBe(false);
    expect(ok.slow).toBe(1);
    expect(ok.worst).toBe(3500);

    const slow = health.evaluateUpdates([{ ms: 4000 }, { ms: 5000 }, { ms: 6000 }, { ms: 200 }, { ms: 300 }]);
    expect(slow.degraded).toBe(true);

    const manyButRare = health.evaluateUpdates([{ ms: 4000 }, { ms: 5000 }, { ms: 6000 }, ...Array.from({ length: 20 }, () => ({ ms: 100 }))]);
    expect(manyButRare.degraded).toBe(false);

    const failed = health.evaluateUpdates([{ ms: 10, failed: true, incident: 'a1' }, { ms: 10, failed: true, incident: 'b2' }, { ms: 10, failed: true, incident: 'c3' }]);
    expect(failed.degraded).toBe(true);
    expect(failed.incidents).toEqual(['a1', 'b2', 'c3']);
  });
});

describe('здоровье бота: доставка и повторы', () => {
  it('шлёт проблему один раз, повторяет через 30 минут, «в порядке» — после двух хороших проверок', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const t0 = Date.parse('2026-11-03T12:00:00Z');
    await health.report('t', 'плохо', 'хорошо', { now: t0, send });
    await health.report('t', 'плохо', 'хорошо', { now: t0 + 60_000, send });
    expect(send).toHaveBeenCalledTimes(1);
    await health.report('t', 'плохо', 'хорошо', { now: t0 + 31 * 60_000, send });
    expect(send).toHaveBeenCalledTimes(2);
    await health.report('t', null, 'хорошо', { now: t0 + 32 * 60_000, send });
    expect(send).toHaveBeenCalledTimes(2);
    await health.report('t', null, 'хорошо', { now: t0 + 33 * 60_000, send });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0]).toBe('хорошо');
    // После «в порядке» новая проблема шлётся сразу.
    await health.report('t', 'плохо', 'хорошо', { now: t0 + 34 * 60_000, send });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('если доставка не удалась, попытка повторится на следующей проверке', async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const t0 = Date.parse('2026-11-03T13:00:00Z');
    await health.report('u', 'плохо', 'хорошо', { now: t0, send });
    await health.report('u', 'плохо', 'хорошо', { now: t0 + 60_000, send });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('здоровье бота: снимок для экрана «Система»', () => {
  it('сайт при узле бота не обрабатывает апдейты — окна нет, это не ошибка', () => {
    const summary = (health as unknown as { summary: (now?: number) => { processesUpdates: boolean; window: unknown; lastUpdateAgoSec: number | null; state: Record<string, unknown> } }).summary;
    process.env.BOT_NODE_URL = 'https://tg.example:88/webhook';
    delete process.env.BOT_ROLE;
    try {
      const site = summary();
      expect(site.processesUpdates).toBe(false);
      expect(site.window).toBeNull();
      expect(site.lastUpdateAgoSec).toBeNull();
      expect(site.state).toMatchObject({ t: expect.any(Object) });
    } finally {
      delete process.env.BOT_NODE_URL;
    }
    const own = summary();
    expect(own.processesUpdates).toBe(true);
    expect(own.window).toMatchObject({ total: expect.any(Number), slow: expect.any(Number), failed: expect.any(Number) });
  });
});
