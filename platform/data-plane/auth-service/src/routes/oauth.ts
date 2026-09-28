/**
 * OAuth 2.0 sign-in (authorization code + PKCE) for Google and GitHub.
 *
 *   GET /v1/:projectId/authorize?provider=google|github&redirect_to=...&apikey=<anon key>
 *   GET /v1/:projectId/callback?code=...&state=...
 *
 * Credentials come from the project's Auth settings (dashboard), falling back
 * to the platform-wide GOOGLE_* / GITHUB_* environment variables. Provider
 * endpoints can be overridden with OAUTH_<PROVIDER>_{AUTHORIZE,TOKEN,USERINFO,EMAILS}_URL
 * (useful for testing against a mock provider or for GitHub Enterprise).
 */
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../lib/db.js';
import { authPublicUrl, config } from '../config.js';
import { projectContext } from '../middleware/auth.js';
import { audit, authSettings, getUserByEmail, isAllowedRedirect, issueSession, platform, type UserRow } from '../lib/session.js';

interface ProviderDef {
  authorize: string; token: string; userinfo: string; emails?: string; scope: string;
}

const env = (k: string, d: string) => process.env[k] || d;
const PROVIDERS: Record<string, ProviderDef> = {
  google: {
    authorize: env('OAUTH_GOOGLE_AUTHORIZE_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    token: env('OAUTH_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    userinfo: env('OAUTH_GOOGLE_USERINFO_URL', 'https://openidconnect.googleapis.com/v1/userinfo'),
    scope: 'openid email profile',
  },
  github: {
    authorize: env('OAUTH_GITHUB_AUTHORIZE_URL', 'https://github.com/login/oauth/authorize'),
    token: env('OAUTH_GITHUB_TOKEN_URL', 'https://github.com/login/oauth/access_token'),
    userinfo: env('OAUTH_GITHUB_USERINFO_URL', 'https://api.github.com/user'),
    emails: env('OAUTH_GITHUB_EMAILS_URL', 'https://api.github.com/user/emails'),
    scope: 'read:user user:email',
  },
};

function credentials(settings: ReturnType<typeof authSettings>, provider: string): { id: string; secret: string } | null {
  const p = settings.providers?.[provider];
  if (p?.enabled && p.client_id && p.client_secret) return { id: p.client_id, secret: p.client_secret };
  const envId = provider === 'google' ? config.GOOGLE_CLIENT_ID : config.GITHUB_CLIENT_ID;
  const envSecret = provider === 'google' ? config.GOOGLE_CLIENT_SECRET : config.GITHUB_CLIENT_SECRET;
  if (p?.enabled !== false && envId && envSecret) return { id: envId, secret: envSecret };
  return null;
}

interface Profile { id: string; email: string | null; email_verified: boolean; name?: string; avatar_url?: string; raw: any }

async function fetchProfile(provider: string, def: ProviderDef, accessToken: string): Promise<Profile> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'OwnDatabase-Auth' };
  const info = (await (await fetch(def.userinfo, { headers })).json()) as any;
  if (provider === 'google') {
    return { id: String(info.sub), email: info.email ?? null, email_verified: !!info.email_verified, name: info.name, avatar_url: info.picture, raw: info };
  }
  let email: string | null = info.email ?? null;
  let verified = false;
  if (def.emails) {
    try {
      const emails = (await (await fetch(def.emails, { headers })).json()) as any[];
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      if (primary) { email = primary.email; verified = true; }
    } catch { /* scope not granted */ }
  }
  return { id: String(info.id), email, email_verified: verified, name: info.name ?? info.login, avatar_url: info.avatar_url, raw: info };
}

export default async function (server: FastifyInstance) {
  server.get('/v1/:projectId/settings', { preValidation: [projectContext] }, async (req, reply) => {
    const s = authSettings(req.ctx.project);
    return reply.send({
      signup_enabled: s.enable_signup, email_confirmation_required: s.require_email_confirmation,
      magic_link_enabled: s.enable_magic_link, mfa_enabled: s.enable_mfa, password_min_length: s.password_min_length,
      external: Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, !!credentials(s, p)])),
    });
  });

  server.get('/v1/:projectId/authorize', { preValidation: [projectContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const settings = authSettings(project);
    const q = req.query as { provider?: string; redirect_to?: string; scopes?: string };
    const def = PROVIDERS[q.provider ?? ''];
    if (!def) return reply.status(400).send({ error: 'Bad Request', message: `Unsupported provider. Use one of: ${Object.keys(PROVIDERS).join(', ')}` });
    const creds = credentials(settings, q.provider!);
    if (!creds) return reply.status(400).send({ error: 'Provider Disabled', message: `${q.provider} sign-in is not configured for this project` });

    const redirectTo = isAllowedRedirect(settings, q.redirect_to) ? q.redirect_to! : (settings.site_url || config.SITE_URL);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await db`
      INSERT INTO auth.oauth_states (project_id, state, code_verifier, provider, redirect_uri, scopes, ip_address, expires_at)
      VALUES (${project.id}, ${state}, ${verifier}, ${q.provider!}, ${redirectTo}, ${q.scopes ?? def.scope}, ${req.ip}, NOW() + INTERVAL '10 minutes')`;

    const url = new URL(def.authorize);
    url.searchParams.set('client_id', creds.id);
    url.searchParams.set('redirect_uri', `${authPublicUrl}/v1/${project.id}/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', q.scopes ?? def.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (q.provider === 'google') url.searchParams.set('access_type', 'online');
    return reply.redirect(url.toString());
  });

  server.get('/v1/:projectId/callback', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const project = await platform.getProject(projectId);
    if (!project || project.status !== 'active') return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    const settings = authSettings(project);

    const [st] = q.state ? await db`
      DELETE FROM auth.oauth_states WHERE state = ${q.state} AND project_id = ${projectId} RETURNING *` : [];
    const fallback = settings.site_url || config.SITE_URL;
    if (!st || new Date(st['expires_at'] as string) < new Date()) {
      return reply.redirect(`${fallback}#error=invalid_state&error_description=${encodeURIComponent('OAuth state is missing or expired')}`);
    }
    const redirectTo = st['redirect_uri'] as string;
    const fail = (msg: string) => reply.redirect(`${redirectTo}#error=oauth_failed&error_description=${encodeURIComponent(msg)}`);
    if (q.error) return fail(q.error_description ?? q.error);
    if (!q.code) return fail('Missing authorization code');

    const provider = st['provider'] as string;
    const def = PROVIDERS[provider]!;
    const creds = credentials(settings, provider);
    if (!creds) return fail('Provider is no longer configured');

    let profile: Profile;
    try {
      const tokenRes = await fetch(def.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: q.code, client_id: creds.id, client_secret: creds.secret,
          redirect_uri: `${authPublicUrl}/v1/${projectId}/callback`, code_verifier: st['code_verifier'] as string,
        }),
      });
      const tok = (await tokenRes.json()) as any;
      if (!tok.access_token) return fail(tok.error_description ?? tok.error ?? 'Token exchange failed');
      profile = await fetchProfile(provider, def, tok.access_token);
    } catch (err) {
      req.log.error({ err }, 'OAuth exchange failed');
      return fail('Could not reach the identity provider');
    }

    // 1) existing identity → 2) verified email match → 3) new user
    let user: UserRow | null = null;
    const [ident] = await db`SELECT user_id FROM auth.identities WHERE project_id = ${projectId} AND provider = ${provider} AND provider_id = ${profile.id}`;
    if (ident) {
      const [u] = await db<UserRow[]>`SELECT * FROM auth.users WHERE id = ${ident['user_id'] as string} AND deleted_at IS NULL`;
      user = u ?? null;
    }
    if (!user && profile.email && profile.email_verified) user = await getUserByEmail(projectId, profile.email);
    if (!user) {
      if (!settings.enable_signup) return fail('Signups are disabled for this project');
      const [u] = await db<UserRow[]>`
        INSERT INTO auth.users (project_id, email, email_verified, confirmed_at, raw_user_meta_data, raw_app_meta_data)
        VALUES (${projectId}, ${profile.email?.toLowerCase() ?? null}, ${profile.email_verified}, ${profile.email_verified ? new Date() : null},
                ${db.json({ full_name: profile.name ?? null, avatar_url: profile.avatar_url ?? null })},
                ${db.json({ provider, providers: [provider] })})
        RETURNING *`;
      user = u!;
    }
    if (user.banned_until && new Date(user.banned_until) > new Date()) return fail('User is banned');
    await db`
      INSERT INTO auth.identities (project_id, user_id, provider, provider_id, identity_data, last_sign_in_at)
      VALUES (${projectId}, ${user.id}, ${provider}, ${profile.id}, ${db.json(profile.raw)}, NOW())
      ON CONFLICT (project_id, provider, provider_id) DO UPDATE SET identity_data = EXCLUDED.identity_data, last_sign_in_at = NOW()`;

    const s = await issueSession(project, user, req, { amr: 'oauth' });
    await audit(projectId, 'login', req, user.id, s.session_id, { method: 'oauth', provider });
    const frag = new URLSearchParams({
      access_token: s.access_token, refresh_token: s.refresh_token, expires_in: String(s.expires_in), token_type: 'bearer', provider,
    });
    return reply.redirect(`${redirectTo}#${frag.toString()}`);
  });
}
