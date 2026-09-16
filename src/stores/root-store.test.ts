import { describe, expect, it } from 'vitest';
import { RootStore } from './root-store';
describe('RootStore', () => {
  it('переключает режим генератора', () => {
    const store = new RootStore(false);
    store.generator.setKind('box');
    store.generator.setMode('custom');
    expect(store.generator.kind).toBe('box');
    expect(store.generator.mode).toBe('custom');
  });
  it('хранит состояние сессии', () => {
    const store = new RootStore(false);
    store.auth.setTestUser({ email: 'test@example.com' } as never);
    expect(store.auth.user?.email).toBe('test@example.com');
    store.auth.setTestUser(null);
    expect(store.auth.user).toBeNull();
  });
});
