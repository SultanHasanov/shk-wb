import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validateTelegram, validateTelegramWebApp } = require('../../server/_telegram-auth.cjs') as {
  validateTelegram: (payload: Record<string, unknown>, token: string, now?: number) => boolean;
  validateTelegramWebApp: (payload: string, token: string, now?: number) => Record<string, unknown> | null;
};

function sign(payload: Record<string, unknown>, token: string) {
  const data = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHash('sha256').update(token).digest();
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

describe('Telegram signature validation', () => {
  const token = '123:test';
  const now = 1_800_000_000;

  it('accepts a valid fresh payload', () => {
    const payload = { id: 42, first_name: 'Test', auth_date: now };
    expect(validateTelegram({ ...payload, hash: sign(payload, token) }, token, now)).toBe(true);
  });

  it('rejects tampering and expired payloads', () => {
    const payload = { id: 42, first_name: 'Test', auth_date: now };
    const signed = { ...payload, hash: sign(payload, token) };
    expect(validateTelegram({ ...signed, first_name: 'Changed' }, token, now)).toBe(false);
    expect(validateTelegram({ ...signed, auth_date: now - 601 }, token, now)).toBe(false);
  });

  it('проверяет подписанные данные Telegram Mini App', () => {
    const user = JSON.stringify({ id: 42, first_name: 'Mini', username: 'mini_user' });
    const values = { auth_date: String(now), query_id: 'query-1', user };
    const data = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = crypto.createHmac('sha256', secret).update(data).digest('hex');
    const initData = new URLSearchParams({ ...values, hash }).toString();
    expect(validateTelegramWebApp(initData, token, now)).toMatchObject({ id: 42, first_name: 'Mini' });
    expect(validateTelegramWebApp(initData.replace('mini_user', 'hacker'), token, now)).toBeNull();
  });
});
