import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from './auth-store';

const authMocks = vi.hoisted(() => ({
  setDeviceRemembered: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock('./supabase', () => ({
  setDeviceRemembered: authMocks.setDeviceRemembered,
  getSupabase: () => ({ auth: { verifyOtp: authMocks.verifyOtp } }),
}));

describe('AuthStore Telegram login', () => {
  beforeEach(() => {
    authMocks.setDeviceRemembered.mockReset();
    authMocks.verifyOtp.mockReset();
  });

  it('persists the session before exchanging the Telegram token', async () => {
    const session = { user: { id: 'telegram-user' } };
    authMocks.verifyOtp.mockResolvedValue({ data: { session }, error: null });
    const store = new AuthStore(false);

    await store.acceptTelegramToken('telegram-token-hash');

    expect(authMocks.setDeviceRemembered).toHaveBeenCalledWith(true);
    expect(authMocks.setDeviceRemembered.mock.invocationCallOrder[0]).toBeLessThan(
      authMocks.verifyOtp.mock.invocationCallOrder[0],
    );
    expect(store.session).toMatchObject(session);
    expect(store.isAuthenticated).toBe(true);
  });
});
