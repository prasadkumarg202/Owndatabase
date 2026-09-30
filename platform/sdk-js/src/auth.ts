/**
 * End-user auth (the project's auth service).
 *
 * Sessions are kept in memory and, in browsers, in localStorage (storageKey),
 * and refreshed automatically shortly before they expire. Every other client
 * (database, storage, functions, realtime) uses the current access token.
 */
import { request, type ClientContext, type OdbError } from './types.js';

export interface User {
  id: string; email: string | null; phone: string | null; role: string;
  email_verified: boolean; phone_verified?: boolean;
  user_metadata: Record<string, unknown>; app_metadata: Record<string, unknown>;
  created_at: string; last_sign_in_at: string | null;
}

export interface Session {
  access_token: string; refresh_token: string; token_type: 'bearer';
  expires_in: number; expires_at: number; user: User;
}

export type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED' | 'INITIAL_SESSION';
type Listener = (event: AuthEvent, session: Session | null) => void;
type AuthResult<T> = { data: T; error: OdbError | null };

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function defaultStorage(): StorageLike | null {
  try { const s = (globalThis as any).localStorage as StorageLike | undefined; return s ?? null; } catch { return null; }
}

export class AuthClient {
  private session: Session | null = null;
  private listeners = new Set<Listener>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private storage: StorageLike | null;

  constructor(private ctx: ClientContext, private opts: { storageKey: string; persistSession: boolean; autoRefreshToken: boolean; storage?: StorageLike }) {
    this.storage = opts.persistSession ? opts.storage ?? defaultStorage() : null;
    const saved = this.storage?.getItem(opts.storageKey);
    if (saved) { try { this.setSession(JSON.parse(saved) as Session, null); } catch { /* ignore */ } }
  }

  /** Current access token (refreshing it first if it expires within 30 s), or null. */
  async accessToken(): Promise<string | null> {
    if (!this.session) return null;
    if (this.session.expires_at * 1000 - Date.now() < 30_000) await this.refreshSession();
    return this.session?.access_token ?? null;
  }

  onAuthStateChange(cb: Listener) {
    this.listeners.add(cb);
    queueMicrotask(() => cb('INITIAL_SESSION', this.session));
    return { data: { subscription: { unsubscribe: () => this.listeners.delete(cb) } } };
  }

  private emit(event: AuthEvent) { for (const l of this.listeners) { try { l(event, this.session); } catch { /* listener error */ } } }

  private setSession(s: Session | null, event: AuthEvent | null) {
    this.session = s;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (s) {
      this.storage?.setItem(this.opts.storageKey, JSON.stringify(s));
      if (this.opts.autoRefreshToken) {
        const ms = Math.max(5_000, s.expires_at * 1000 - Date.now() - 60_000);
        this.refreshTimer = setTimeout(() => void this.refreshSession(), ms);
        (this.refreshTimer as any)?.unref?.();
      }
    } else {
      this.storage?.removeItem(this.opts.storageKey);
    }
    if (event) this.emit(event);
  }

  private async tokenCall(path: string, body: unknown, event: AuthEvent): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
    const r = await request<any>({ ...this.ctx, bearer: async () => this.ctx.apiKey }, `${this.ctx.urls.auth}/${path}`, { method: 'POST', json: body });
    if (r.error) return { data: { user: null, session: null }, error: r.error };
    const d = r.data ?? {};
    if (d.access_token) {
      const session: Session = { access_token: d.access_token, refresh_token: d.refresh_token, token_type: 'bearer', expires_in: d.expires_in, expires_at: d.expires_at, user: d.user };
      this.setSession(session, event);
      return { data: { user: d.user, session }, error: null };
    }
    return { data: { user: d.user ?? null, session: null }, error: null };
  }

  signUp(creds: { email?: string; phone?: string; password: string; options?: { data?: Record<string, unknown> } }) {
    return this.tokenCall('signup', creds, 'SIGNED_IN');
  }

  signInWithPassword(creds: { email?: string; phone?: string; password: string }) {
    return this.tokenCall('token?grant_type=password', creds, 'SIGNED_IN');
  }

  /** Email magic link / code, or an SMS code. */
  async signInWithOtp(creds: { email?: string; phone?: string; options?: { shouldCreateUser?: boolean; data?: Record<string, unknown>; emailRedirectTo?: string } }) {
    const body = { email: creds.email, phone: creds.phone, create_user: creds.options?.shouldCreateUser ?? true, data: creds.options?.data, redirect_to: creds.options?.emailRedirectTo };
    const r = await this.tokenCall('otp', body, 'SIGNED_IN');
    return { data: { user: null, session: null }, error: r.error };
  }

  verifyOtp(params: { email?: string; phone?: string; token: string; type: 'signup' | 'magiclink' | 'recovery' | 'email' | 'sms' | 'phone_change' }) {
    return this.tokenCall('verify', params, 'SIGNED_IN');
  }

  async resetPasswordForEmail(email: string, opts: { redirectTo?: string } = {}) {
    const r = await request<any>({ ...this.ctx, bearer: async () => this.ctx.apiKey }, `${this.ctx.urls.auth}/recover`, { method: 'POST', json: { email, redirect_to: opts.redirectTo } });
    return { data: {}, error: r.error };
  }

  async refreshSession(): Promise<AuthResult<{ session: Session | null }>> {
    const rt = this.session?.refresh_token;
    if (!rt) return { data: { session: null }, error: { status: 401, message: 'No session' } };
    const r = await this.tokenCall('token?grant_type=refresh_token', { refresh_token: rt }, 'TOKEN_REFRESHED');
    if (r.error && r.error.status >= 400 && r.error.status < 500) this.setSession(null, 'SIGNED_OUT');
    return { data: { session: r.data.session }, error: r.error };
  }

  async getSession(): Promise<AuthResult<{ session: Session | null }>> {
    if (this.session && this.session.expires_at * 1000 - Date.now() < 30_000) await this.refreshSession();
    return { data: { session: this.session }, error: null };
  }

  /** The signed-in user, fetched from the server (validates the token). */
  async getUser(): Promise<AuthResult<{ user: User | null }>> {
    const token = await this.accessToken();
    if (!token) return { data: { user: null }, error: { status: 401, message: 'Not signed in' } };
    const r = await request<any>({ ...this.ctx, bearer: async () => token }, `${this.ctx.urls.auth}/user`);
    return { data: { user: r.data ?? null }, error: r.error };
  }

  async updateUser(attrs: { email?: string; phone?: string; password?: string; data?: Record<string, unknown> }): Promise<AuthResult<{ user: User | null }>> {
    const token = await this.accessToken();
    if (!token) return { data: { user: null }, error: { status: 401, message: 'Not signed in' } };
    const r = await request<any>({ ...this.ctx, bearer: async () => token }, `${this.ctx.urls.auth}/user`, { method: 'PUT', json: attrs });
    if (!r.error && this.session) { this.session = { ...this.session, user: r.data?.user ?? r.data }; this.setSession(this.session, 'USER_UPDATED'); }
    return { data: { user: r.data?.user ?? r.data ?? null }, error: r.error };
  }

  async signOut(opts: { scope?: 'local' | 'global' } = {}) {
    const token = this.session?.access_token;
    let error: OdbError | null = null;
    if (token && opts.scope !== 'local') {
      const r = await request<any>({ ...this.ctx, bearer: async () => token }, `${this.ctx.urls.auth}/logout${opts.scope === 'global' ? '?scope=global' : ''}`, { method: 'POST' });
      if (r.error && r.status !== 401) error = r.error;
    }
    this.setSession(null, 'SIGNED_OUT');
    return { error };
  }

  /** Use an existing session (e.g. from a server-side sign-in). */
  setSessionFrom(s: Session) { this.setSession(s, 'SIGNED_IN'); }

  /** Stops the refresh timer (for scripts that should exit). */
  stopAutoRefresh() { if (this.refreshTimer) clearTimeout(this.refreshTimer); this.refreshTimer = null; }
}
