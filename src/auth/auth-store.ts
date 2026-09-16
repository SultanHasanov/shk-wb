import { makeAutoObservable, runInAction } from 'mobx';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase, setDeviceRemembered } from './supabase';

export type AuthStatus = 'initializing' | 'authenticated' | 'anonymous';

function publicAuthError(error: unknown): Error {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('invalid login credentials')) return new Error('Неверная почта или пароль');
  if (message.includes('already registered') || message.includes('already exists')) {
    return new Error('Аккаунт с этой электронной почтой уже существует. Войдите или восстановите пароль.');
  }
  if (message.includes('password')) return new Error('Пароль должен содержать не менее 8 символов');
  return new Error('Не удалось выполнить запрос. Попробуйте ещё раз');
}

export class AuthStore {
  status: AuthStatus = 'initializing';
  user: User | null = null;
  session: Session | null = null;
  recoveryMode = false;

  constructor(private readonly autoInitialize = true) {
    makeAutoObservable(this, {}, { autoBind: true });
    if (autoInitialize) void this.initialize();
  }

  get isAuthenticated() {
    return this.status === 'authenticated';
  }

  get displayName() {
    const metadata = this.user?.user_metadata;
    return metadata?.full_name || metadata?.username || this.user?.email || '';
  }

  async initialize() {
    try {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getSession();
      this.applySession(data.session);
      supabase.auth.onAuthStateChange((event, session) => {
        runInAction(() => {
          this.recoveryMode = event === 'PASSWORD_RECOVERY';
          this.applySession(session);
        });
      });
    } catch {
      runInAction(() => this.applySession(null));
    }
  }

  private applySession(session: Session | null) {
    this.session = session;
    this.user = session?.user ?? null;
    this.status = session ? 'authenticated' : 'anonymous';
  }

  /** remember=false — сессия живёт только до закрытия вкладки (чужой компьютер). */
  async signIn(email: string, password: string, remember = true) {
    // Порядок важен: клиент запишет токены сразу после ответа, и к этому моменту
    // хранилище должно быть уже выбрано.
    setDeviceRemembered(remember);
    const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) throw publicAuthError(error);
    runInAction(() => this.applySession(data.session));
  }

  async signUp(email: string, password: string) {
    // Свой аккаунт заводят на своём устройстве, а прошлый выбор «не запоминать»
    // иначе тихо переехал бы на новую регистрацию.
    setDeviceRemembered(true);
    const emailRedirectTo = `${window.location.origin}/cabinet`;
    const { data, error } = await getSupabase().auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });
    if (error) throw publicAuthError(error);
    if (!data.session) return { confirmationRequired: true as const };
    runInAction(() => this.applySession(data.session));
    return { confirmationRequired: false as const };
  }

  async resendSignUpConfirmation(email: string) {
    const emailRedirectTo = `${window.location.origin}/cabinet`;
    const { error } = await getSupabase().auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo },
    });
    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes('rate limit') || message.includes('security purposes')) {
        throw new Error('Повторное письмо можно запросить не чаще одного раза в минуту');
      }
      throw publicAuthError(error);
    }
  }

  async signOut() {
    const { error } = await getSupabase().auth.signOut();
    if (error) throw publicAuthError(error);
    runInAction(() => this.applySession(null));
  }

  async requestPasswordReset(email: string) {
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error } = await getSupabase().auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes('rate limit') || message.includes('security purposes')) {
        throw new Error('Новое письмо можно запросить не чаще одного раза в минуту');
      }
      throw publicAuthError(error);
    }
  }

  async updatePassword(password: string) {
    const { error } = await getSupabase().auth.updateUser({ password });
    if (error) throw publicAuthError(error);
    runInAction(() => {
      this.recoveryMode = false;
    });
  }

  async addEmailPassword(email: string, password: string) {
    const { data, error } = await getSupabase().auth.updateUser({ email, password });
    if (error) throw publicAuthError(error);
    runInAction(() => {
      this.user = data.user;
      if (this.session) this.session = { ...this.session, user: data.user };
    });
  }

  async acceptTelegramToken(tokenHash: string) {
    // Telegram login has no "remember device" checkbox. Always persist that
    // session so an earlier password login with remember=false cannot make the
    // Telegram refresh token disappear when the browser is closed.
    setDeviceRemembered(true);
    const { data, error } = await getSupabase().auth.verifyOtp({
      token_hash: tokenHash,
      type: 'magiclink',
    });
    if (error || !data.session) throw publicAuthError(error);
    runInAction(() => this.applySession(data.session));
  }

  /** Test-only state setter; production state always comes from Supabase. */
  setTestUser(user: User | null) {
    this.user = user;
    this.status = user ? 'authenticated' : 'anonymous';
  }
}
