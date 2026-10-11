import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const wb = require('../../server/_wb-pvz.js') as {
  encryptSession: (value: Record<string, unknown>) => string;
  decryptSession: (value: string) => Record<string, unknown>;
  extractChallenge: (value: string) => string | null;
  normalizeGoodsInPickPoint: (value: unknown) => {goods: Array<Record<string, unknown>>; cursor: number | null};
  tokenValue: (value: unknown) => string | null;
  normalizePoints: (value: unknown) => Array<Record<string, unknown>>;
  switchDesktopPoint: (session: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

describe('WB PVZ reviews client', () => {
  afterEach(() => {
    delete process.env.WB_SESSION_SECRET;
    vi.restoreAllMocks();
  });

  it('шифрует WB-сессию перед сохранением', () => {
    process.env.WB_SESSION_SECRET = 'test-secret-that-is-longer-than-32-bytes';
    const encrypted = wb.encryptSession({ token: 'private-token', pointId: 123 });
    expect(encrypted).not.toContain('private-token');
    expect(wb.decryptSession(encrypted)).toEqual({ token: 'private-token', pointId: 123 });
  });

  it('извлекает X-Pow challenge', () => {
    expect(wb.extractChallenge('status=required; challenge=20,x,y,z,1,2,3,4,5; foo=bar')).toBe('20,x,y,z,1,2,3,4,5');
    expect(wb.extractChallenge('')).toBeNull();
  });

  it('нормализует ответ синхронизации WB Desktop', () => {
    expect(wb.normalizeGoodsInPickPoint({ data: { goods: [{ item_uid: 'a' }], max_last_id: 17 } })).toEqual({
      goods: [{ item_uid: 'a' }],
      cursor: 17,
    });
    expect(wb.normalizeGoodsInPickPoint({ data: [{ item_uid: 'b' }], response_last_id: 18 })).toEqual({
      goods: [{ item_uid: 'b' }],
      cursor: 18,
    });
  });

  it('извлекает Desktop access token из ответа выбора ПВЗ', () => {
    expect(wb.tokenValue({ token: 'desktop-token' })).toBe('desktop-token');
    expect(wb.tokenValue({ access_token: 'desktop-token-2' })).toBe('desktop-token-2');
    expect(wb.tokenValue(null)).toBeNull();
  });

  it('нормализует список доступных Desktop-ПВЗ', () => {
    expect(wb.normalizePoints({ data: [{ id: 123, external_id: 456, shard: 42 }] })).toEqual([
      { id: 456, external_id: 456, officeId: 123, externalId: 456, shard: 42 },
    ]);
  });

  it('получает scoped token партнёрского ПВЗ через sharded switch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access: { token: 'point-token' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const session = {
      deviceId: 'device-uuid', token: 'login-token', pointId: 50160457,
      desktopOfficeId: 146183, desktopShard: 42, authKind: 'desktop',
    };

    await wb.switchDesktopPoint(session);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://s-point.wb.ru/s42/api/v2/pickpoint/146183/switch');
    expect(session).toMatchObject({ desktopToken: 'point-token', desktopPointId: 50160457 });
  });
});
