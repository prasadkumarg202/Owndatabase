/**
 * OAuth 2.0 / OpenID Connect sign-in.
 *
 *   GET  /v1/:projectId/authorize?provider=<p>&redirect_to=...[&scopes=...][&code_challenge=...&code_challenge_method=s256]
 *   GET  /v1/:projectId/callback?code=...&state=...      (POST for Apple's form_post)
 *   POST /v1/:projectId/token?grant_type=pkce            { auth_code, code_verifier }      (supabase-js flowType 'pkce')
 *   POST /v1/:projectId/token?grant_type=id_token        { provider, id_token, nonce? }    (native Google / Apple sign-in)
 *
 * `authorize` needs no API key, like Supabase: browsers navigate to it. Without
 * a code_challenge the tokens come back in the redirect's #fragment (implicit
 * flow); with one, the redirect carries ?code= to exchange with grant_type=pkce.
 *
 * Credentials come from the project's Auth settings, falling back to the
 * platform-wide <PROVIDER>_CLIENT_ID / <PROVIDER>_CLIENT_SECRET variables.
 * Endpoints can be overridden per provider with OAUTH_<PROVIDER>_<KIND>_URL
 * (KIND = AUTHORIZE, TOKEN, USERINFO, EMAILS, JWKS, ISSUER). Tests set
 * OAUTH_MOCK_URL / OAUTH_MOCK_PUBLIC_URL to route every provider to a mock at
 * <mock>/<provider>/<kind>.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, importPKCS8, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { db } from '../lib/db.js';
import { authPublicUrl, config } from '../config.js';
import type { ProjectInfo } from '../lib/platform-auth.js';
import { projectContext } from '../middleware/auth.js';
import { authSecret } from '../lib/vault.js';
import { audit, authSettings, getUserByEmail, isAllowedRedirect, issueSession, platform, type UserRow, userQuotaError } from '../lib/session.js';

type Kind = 'authorize' | 'token' | 'userinfo' | 'emails' | 'jwks' | 'issuer';
export interface ProviderSettings {
  enabled?: boolean; client_id?: string; client_secret?: string;
  /** base URL: GitHub Enterprise / self-hosted GitLab / Azure tenant / Keycloak realm */
  url?: string;
  /** more accepted id_token audiences (iOS / Android client ids), comma-separated */
  additional_client_ids?: string;
  /** Apple: generate the client secret from a .p8 key (client_secret = the key) */
  team_id?: string; key_id?: string;
}
interface Profile { id: string; email: string | null; email_verified: boolean; name?: string; avatar_url?: string; raw: Record<string, unknown> }
interface Ctx {
  access: string; idClaims: JWTPayload | null; clientId: string; form?: Record<string, string>;
  url: (kind: Kind) => string; get: (kind: Kind, headers?: Record<string, string>) => Promise<any>;
}
interface ProviderDef {
  endpoints: (base: string | undefined) => Partial<Record<Kind, string>>;
  scope: string;
  /** send a PKCE challenge to the provider (off where providers reject or ignore it for web apps) */
  pkce: boolean;
  /** client authentication at the token endpoint: form fields (default) or HTTP Basic */
  basicAuth?: boolean;
  authParams?: Record<string, string>;
  /** a base URL (settings.url) is required */
  needsUrl?: boolean;
  profile: (ctx: Ctx) => Promise<Profile>;
  /** id_token sign-in: how to read the verified claims (default: OIDC claims) */
  claims?: (c: JWTPayload) => Profile;
}

const trimBase = (u: string | undefined) => (u ?? '').replace(/\/+$/, '');
const truthy = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';
const oidcProfile = (c: Record<string, any>): Profile => ({
  id: String(c['sub']), email: c['email'] ?? null, email_verified: truthy(c['email_verified']),
  name: c['name'] ?? c['preferred_username'], avatar_url: c['picture'], raw: c,
});
const userinfoOidc = async (ctx: Ctx) => oidcProfile(await ctx.get('userinfo'));

const PROVIDERS: Record<string, ProviderDef> = {
  google: {
    endpoints: () => ({
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
      userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', jwks: 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: 'https://accounts.google.com',
    }),
    scope: 'openid email profile', pkce: true, authParams: { access_type: 'online' },
    profile: userinfoOidc,
  },
  github: {
    endpoints: (base) => base
      ? { authorize: `${base}/login/oauth/authorize`, token: `${base}/login/oauth/access_token`, userinfo: `${base}/api/v3/user`, emails: `${base}/api/v3/user/emails` }
      : { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', userinfo: 'https://api.github.com/user', emails: 'https://api.github.com/user/emails' },
    scope: 'read:user user:email', pkce: true,
    async profile(ctx) {
      const info = await ctx.get('userinfo');
      let email: string | null = info.email ?? null, verified = false;
      try {
        const emails = (await ctx.get('emails')) as any[];
        const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        if (primary) { email = primary.email; verified = true; }
      } catch { /* scope not granted */ }
      return { id: String(info.id), email, email_verified: verified, name: info.name ?? info.login, avatar_url: info.avatar_url, raw: info };
    },
  },
  gitlab: {
    endpoints: (base) => { const b = base || 'https://gitlab.com'; return { authorize: `${b}/oauth/authorize`, token: `${b}/oauth/token`, userinfo: `${b}/oauth/userinfo` }; },
    scope: 'openid email profile', pkce: true,
    profile: userinfoOidc,
  },
  bitbucket: {
    endpoints: () => ({
      authorize: 'https://bitbucket.org/site/oauth2/authorize', token: 'https://bitbucket.org/site/oauth2/access_token',
      userinfo: 'https://api.bitbucket.org/2.0/user', emails: 'https://api.bitbucket.org/2.0/user/emails',
    }),
    scope: 'account email', pkce: false, basicAuth: true,
    async profile(ctx) {
      const info = await ctx.get('userinfo');
      const emails = ((await ctx.get('emails').catch(() => ({})))?.values ?? []) as any[];
      const primary = emails.find((e) => e.is_primary && e.is_confirmed) ?? emails.find((e) => e.is_confirmed);
      return { id: String(info.uuid ?? info.account_id), email: primary?.email ?? null, email_verified: !!primary, name: info.display_name ?? info.username, avatar_url: info.links?.avatar?.href, raw: info };
    },
  },
  azure: {
    // settings.url = https://login.microsoftonline.com/<tenant> (default: common = any Microsoft account)
    endpoints: (base) => {
      const b = base || 'https://login.microsoftonline.com/common';
      return { authorize: `${b}/oauth2/v2.0/authorize`, token: `${b}/oauth2/v2.0/token`, userinfo: 'https://graph.microsoft.com/oidc/userinfo', jwks: `${b}/discovery/v2.0/keys` };
    },
    scope: 'openid email profile', pkce: true,
    async profile(ctx) {
      const p = oidcProfile({ ...(ctx.idClaims ?? {}), ...(await ctx.get('userinfo')) });
      // Azure AD does not verify email addresses unless the tenant says so (xms_edov)
      p.email_verified = truthy(ctx.idClaims?.['xms_edov']);
      return p;
    },
    claims: (c) => ({ ...oidcProfile(c), email_verified: truthy(c['xms_edov']) }),
  },
  apple: {
    endpoints: () => ({
      authorize: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token',
      jwks: 'https://appleid.apple.com/auth/keys', issuer: 'https://appleid.apple.com',
    }),
    // Apple posts the result back (response_mode=form_post) when name/email are requested
    scope: 'name email', pkce: false, authParams: { response_mode: 'form_post' },
    async profile(ctx) {
      if (!ctx.idClaims) throw new Error('Apple returned no id_token');
      const p = oidcProfile(ctx.idClaims);
      try {
        // only on the first sign-in: user={"name":{"firstName":"..","lastName":".."}}
        const u = ctx.form?.['user'] ? JSON.parse(ctx.form['user']) : null;
        const name = [u?.name?.firstName, u?.name?.lastName].filter(Boolean).join(' ');
        if (name) { p.name = name; p.raw = { ...p.raw, full_name: name }; }
      } catch { /* ignore */ }
      return p;
    },
  },
  facebook: {
    endpoints: () => ({
      authorize: 'https://www.facebook.com/v19.0/dialog/oauth', token: 'https://graph.facebook.com/v19.0/oauth/access_token',
      userinfo: 'https://graph.facebook.com/v19.0/me?fields=id,name,email,picture.type(large)',
      jwks: 'https://limited.facebook.com/.well-known/oauth/openid/jwks/', issuer: 'https://www.facebook.com',
    }),
    scope: 'email public_profile', pkce: true,
    async profile(ctx) {
      const info = await ctx.get('userinfo');
      // Facebook only returns confirmed email addresses
      return { id: String(info.id), email: info.email ?? null, email_verified: !!info.email, name: info.name, avatar_url: info.picture?.data?.url, raw: info };
    },
    claims: (c) => ({ ...oidcProfile(c), email_verified: !!c['email'] }),
  },
  discord: {
    endpoints: () => ({ authorize: 'https://discord.com/oauth2/authorize', token: 'https://discord.com/api/oauth2/token', userinfo: 'https://discord.com/api/users/@me' }),
    scope: 'identify email', pkce: true,
    async profile(ctx) {
      const info = await ctx.get('userinfo');
      const avatar = info.avatar ? `https://cdn.discordapp.com/avatars/${info.id}/${info.avatar}.png` : undefined;
      return { id: String(info.id), email: info.email ?? null, email_verified: !!info.verified, name: info.global_name ?? info.username, avatar_url: avatar, raw: info };
    },
  },
  linkedin_oidc: {
    endpoints: () => ({ authorize: 'https://www.linkedin.com/oauth/v2/authorization', token: 'https://www.linkedin.com/oauth/v2/accessToken', userinfo: 'https://api.linkedin.com/v2/userinfo' }),
    scope: 'openid profile email', pkce: false,
    profile: userinfoOidc,
  },
  slack_oidc: {
    endpoints: () => ({ authorize: 'https://slack.com/openid/connect/authorize', token: 'https://slack.com/api/openid.connect.token', userinfo: 'https://slack.com/api/openid.connect.userInfo' }),
    scope: 'openid profile email', pkce: false,
    profile: userinfoOidc,
  },
  x: {
    // X (Twitter) OAuth 2.0; the email only comes with the users.email scope (confirmed_email)
    endpoints: () => ({
      authorize: 'https://twitter.com/i/oauth2/authorize', token: 'https://api.twitter.com/2/oauth2/token',
      userinfo: 'https://api.twitter.com/2/users/me?user.fields=profile_image_url,confirmed_email',
    }),
    scope: 'users.read tweet.read', pkce: true, basicAuth: true,
    async profile(ctx) {
      const info = (await ctx.get('userinfo'))?.data ?? {};
      return { id: String(info.id), email: info.confirmed_email ?? null, email_verified: !!info.confirmed_email, name: info.name ?? info.username, avatar_url: info.profile_image_url, raw: info };
    },
  },
  spotify: {
    endpoints: () => ({ authorize: 'https://accounts.spotify.com/authorize', token: 'https://accounts.spotify.com/api/token', userinfo: 'https://api.spotify.com/v1/me' }),
    scope: 'user-read-email user-read-private', pkce: true,
    async profile(ctx) {
      const info = await ctx.get('userinfo');
      // Spotify does not verify email addresses
      return { id: String(info.id), email: info.email ?? null, email_verified: false, name: info.display_name, avatar_url: info.images?.[0]?.url, raw: info };
    },
  },
  twitch: {
    endpoints: () => ({ authorize: 'https://id.twitch.tv/oauth2/authorize', token: 'https://id.twitch.tv/oauth2/token', userinfo: 'https://api.twitch.tv/helix/users' }),
    scope: 'user:read:email', pkce: false,
    async profile(ctx) {
      const info = (await ctx.get('userinfo', { 'Client-Id': ctx.clientId }))?.data?.[0] ?? {};
      return { id: String(info.id), email: info.email ?? null, email_verified: !!info.email, name: info.display_name ?? info.login, avatar_url: info.profile_image_url, raw: info };
    },
  },
  keycloak: {
    // settings.url = the realm URL, e.g. https://sso.example.com/realms/myrealm (works for any OIDC server with Keycloak's paths)
    endpoints: (base) => base ? {
      authorize: `${base}/protocol/openid-connect/auth`, token: `${base}/protocol/openid-connect/token`,
      userinfo: `${base}/protocol/openid-connect/userinfo`, jwks: `${base}/protocol/openid-connect/certs`, issuer: base,
    } : {},
    scope: 'openid email profile', pkce: true, needsUrl: true,
    profile: userinfoOidc,
  },
};
PROVIDERS['twitter'] = PROVIDERS['x']!;
export const OAUTH_PROVIDERS = Object.keys(PROVIDERS);

function endpoint(provider: string, def: ProviderDef, kind: Kind, base: string | undefined): string | undefined {
  const env = process.env[`OAUTH_${provider.toUpperCase()}_${kind.toUpperCase()}_URL`];
  if (env) return env;
  const mock = kind === 'authorize' ? (process.env['OAUTH_MOCK_PUBLIC_URL'] || process.env['OAUTH_MOCK_URL']) : process.env['OAUTH_MOCK_URL'];
  if (mock) return `${trimBase(mock)}/${provider}/${kind}`;
  return def.endpoints(trimBase(base) || undefined)[kind];
}

interface Creds { id: string; secret: string; p: ProviderSettings }
function credentials(settings: ReturnType<typeof authSettings>, provider: string, needSecret = true): Creds | null {
  const def = PROVIDERS[provider];
  if (!def) return null;
  const p: ProviderSettings = settings.providers?.[provider] ?? {};
  const envKey = provider.toUpperCase();
  let c: Creds | null = null;
  if (p.enabled && p.client_id && (p.client_secret || !needSecret)) c = { id: p.client_id, secret: p.client_secret ?? '', p };
  else {
    const envId = process.env[`${envKey}_CLIENT_ID`], envSecret = process.env[`${envKey}_CLIENT_SECRET`];
    if (p.enabled !== false && envId && (envSecret || !needSecret)) c = { id: envId, secret: envSecret ?? '', p: { ...p, url: p.url || process.env[`${envKey}_URL`] } };
  }
  if (c && def.needsUrl && !c.p.url && !process.env['OAUTH_MOCK_URL']) return null;
  return c;
}

/** Apple's client secret is a short-lived ES256 JWT signed with the .p8 key. */
async function clientSecret(projectId: string, provider: string, c: Creds): Promise<string> {
  // the project's secret is sealed in the vault (docs/vault.md); platform env credentials are not
  const secret = (await authSecret(projectId, `auth.providers.${provider}.client_secret`, c.secret)) ?? '';
  if (provider !== 'apple' || !secret.includes('PRIVATE KEY')) return secret;
  if (!c.p.team_id || !c.p.key_id) throw new Error('Apple needs the team ID and key ID with the .p8 key');
  const key = await importPKCS8(secret.replace(/\\n/g, '\n'), 'ES256');
  return new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: c.p.key_id })
    .setIssuer(c.p.team_id).setSubject(c.id).setAudience('https://appleid.apple.com')
    .setIssuedAt().setExpirationTime('5m').sign(key);
}

async function getJson(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers });
  const body = (await r.json().catch(() => null)) as any;
  if (!r.ok || body == null) throw new Error(`${new URL(url).host} returned ${r.status}`);
  return body;
}

/** 1) existing identity → 2) email match (verified provider email) → 3) new user. Returns a user or an error message. */
async function signInUser(project: ProjectInfo, provider: string, profile: Profile): Promise<UserRow | string> {
  const projectId = project.id;
  const settings = authSettings(project);
  let user: UserRow | null = null;
  const [ident] = await db`SELECT user_id FROM auth.identities WHERE project_id = ${projectId} AND provider = ${provider} AND provider_id = ${profile.id}`;
  if (ident) {
    const [u] = await db<UserRow[]>`SELECT * FROM auth.users WHERE id = ${ident['user_id'] as string} AND deleted_at IS NULL`;
    user = u ?? null;
  }
  if (!user && profile.email) {
    const existing = await getUserByEmail(projectId, profile.email);
    if (existing && !profile.email_verified) return 'An account with this email already exists. Sign in with it first.';
    if (existing) {
      if (!existing.email_verified) {
        // Someone registered this address without proving they own it: the provider just proved it,
        // so drop the unverified password and sessions before linking (prevents pre-registration takeover).
        await db`DELETE FROM auth.user_passwords WHERE user_id = ${existing.id}`;
        await db`DELETE FROM auth.sessions WHERE user_id = ${existing.id}`;
        await db`UPDATE auth.users SET email_verified = true, confirmed_at = COALESCE(confirmed_at, NOW()) WHERE id = ${existing.id}`;
      }
      user = existing;
    }
  }
  if (!user) {
    if (!settings.enable_signup) return 'Signups are disabled for this project';
    const quota = await userQuotaError(project);
    if (quota) return quota;
    const [u] = await db<UserRow[]>`
      INSERT INTO auth.users (project_id, email, email_verified, confirmed_at, raw_user_meta_data, raw_app_meta_data)
      VALUES (${projectId}, ${profile.email?.toLowerCase() ?? null}, ${profile.email_verified}, ${profile.email_verified ? new Date() : null},
              ${db.json({ full_name: profile.name ?? null, name: profile.name ?? null, avatar_url: profile.avatar_url ?? null, email: profile.email, email_verified: profile.email_verified, provider_id: profile.id, sub: profile.id })},
              ${db.json({ provider, providers: [provider] })})
      RETURNING *`;
    user = u!;
  } else {
    const providers = new Set([...((user.raw_app_meta_data?.['providers'] as string[] | undefined) ?? []), provider]);
    if (providers.size !== ((user.raw_app_meta_data?.['providers'] as string[] | undefined) ?? []).length) {
      const [u] = await db<UserRow[]>`
        UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || ${db.json({ providers: [...providers] })} WHERE id = ${user.id} RETURNING *`;
      user = u ?? user;
    }
  }
  if (user.banned_until && new Date(user.banned_until) > new Date()) return 'User is banned';
  await db`
    INSERT INTO auth.identities (project_id, user_id, provider, provider_id, identity_data, last_sign_in_at)
    VALUES (${projectId}, ${user.id}, ${provider}, ${profile.id},
            ${db.json({ ...profile.raw, sub: profile.id, email: profile.email, email_verified: profile.email_verified })}, NOW())
    ON CONFLICT (project_id, provider, provider_id) DO UPDATE SET identity_data = EXCLUDED.identity_data, last_sign_in_at = NOW()`;
  return user;
}

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const sha256hex = (v: string) => createHash('sha256').update(v).digest('hex');
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** POST /token?grant_type=id_token — sign in with an ID token from a native SDK (Google, Apple, ...). */
export async function idTokenGrant(req: FastifyRequest, reply: FastifyReply) {
  const { project } = req.ctx;
  const settings = authSettings(project);
  const b = (req.body ?? {}) as { provider?: string; id_token?: string; nonce?: string; access_token?: string; issuer?: string };
  const provider = b.provider ?? '';
  const def = PROVIDERS[provider];
  if (!def || !b.id_token) {
    return reply.status(400).send({ error: 'Bad Request', message: 'provider and id_token are required' });
  }
  const creds = credentials(settings, provider, false);
  if (!creds) return reply.status(400).send({ error: 'Provider Disabled', message: `${provider} sign-in is not configured for this project` });
  const jwksUrl = endpoint(provider, def, 'jwks', creds.p.url);
  const issuer = endpoint(provider, def, 'issuer', creds.p.url);
  if (!jwksUrl) return reply.status(400).send({ error: 'Bad Request', message: `${provider} does not support id_token sign-in` });
  const audience = [creds.id, ...(creds.p.additional_client_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean)];

  let claims: JWTPayload;
  try {
    let jwks = jwksCache.get(jwksUrl);
    if (!jwks) { jwks = createRemoteJWKSet(new URL(jwksUrl)); jwksCache.set(jwksUrl, jwks); }
    ({ payload: claims } = await jwtVerify(b.id_token, jwks, { audience, clockTolerance: 30 }));
  } catch (err) {
    return reply.status(400).send({ error: 'Invalid ID Token', message: `The id_token could not be verified: ${(err as Error).message}` });
  }
  const iss = String(claims.iss ?? '');
  const issuerOk = provider === 'azure'
    ? /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(iss) || (!!issuer && iss === issuer)
    : provider === 'google' ? ['https://accounts.google.com', 'accounts.google.com'].includes(iss) || iss === issuer
    : !!issuer && iss === trimBase(issuer);
  if (!issuerOk) return reply.status(400).send({ error: 'Invalid ID Token', message: `Unexpected issuer '${iss}'` });
  // The token carries sha256(nonce) (Apple, Google with a hashed nonce) or the nonce itself.
  if (claims['nonce'] !== undefined) {
    const n = String(claims['nonce']);
    if (!b.nonce || !(safeEq(n, sha256hex(b.nonce)) || safeEq(n, b.nonce))) {
      return reply.status(400).send({ error: 'Invalid ID Token', message: 'Nonces mismatch' });
    }
  } else if (b.nonce) {
    return reply.status(400).send({ error: 'Invalid ID Token', message: 'The id_token has no nonce but one was provided' });
  }

  const profile = (def.claims ?? oidcProfile)(claims as Record<string, any>);
  const user = await signInUser(project, provider, profile);
  if (typeof user === 'string') return reply.status(user === 'User is banned' ? 403 : 400).send({ error: 'Sign-in Failed', message: user });
  const s = await issueSession(project, user, req, { amr: 'oauth' });
  await audit(project.id, 'login', req, user.id, s.session_id, { method: 'id_token', provider });
  return reply.send(s);
}

/** POST /token?grant_type=pkce — exchange the ?code= from an OAuth redirect (supabase-js flowType 'pkce'). */
export async function pkceGrant(req: FastifyRequest, reply: FastifyReply) {
  const { project } = req.ctx;
  const b = (req.body ?? {}) as { auth_code?: string; code_verifier?: string };
  if (!b.auth_code || !b.code_verifier) return reply.status(400).send({ error: 'Bad Request', message: 'auth_code and code_verifier are required' });
  const [f] = await db`
    DELETE FROM auth.flow_state WHERE project_id = ${project.id} AND auth_code = ${sha256hex(b.auth_code)} RETURNING *`;
  const bad = () => reply.status(400).send({ error: 'Invalid Grant', message: 'The code is invalid, expired or already used' });
  if (!f || new Date(f['expires_at'] as string) < new Date()) return bad();
  const expected = f['code_challenge'] as string;
  const got = f['code_challenge_method'] === 'plain' ? b.code_verifier : s256(b.code_verifier);
  if (!safeEq(got, expected)) return bad();
  const [user] = await db<UserRow[]>`SELECT * FROM auth.users WHERE id = ${f['user_id'] as string} AND project_id = ${project.id} AND deleted_at IS NULL`;
  if (!user) return bad();
  const s = await issueSession(project, user, req, { amr: 'oauth' });
  await audit(project.id, 'login', req, user.id, s.session_id, { method: 'oauth', provider: f['provider'] });
  return reply.send({ ...s, provider_token: f['provider_access_token'] ?? null, provider_refresh_token: f['provider_refresh_token'] ?? null });
}

export default async function (server: FastifyInstance) {
  server.get('/v1/:projectId/settings', { preValidation: [projectContext] }, async (req, reply) => {
    const s = authSettings(req.ctx.project);
    return reply.send({
      signup_enabled: s.enable_signup, disable_signup: !s.enable_signup, email_confirmation_required: s.require_email_confirmation,
      mailer_autoconfirm: !s.require_email_confirmation, phone_autoconfirm: false,
      magic_link_enabled: s.enable_magic_link, mfa_enabled: s.enable_mfa, password_min_length: s.password_min_length,
      external: {
        email: true, phone: !!s.enable_phone_auth,
        ...Object.fromEntries(OAUTH_PROVIDERS.map((p) => [p, !!(credentials(s, p) ?? credentials(s, p, false))])),
      },
    });
  });

  // No API key: browsers (supabase-js signInWithOAuth) navigate here directly.
  server.get('/v1/:projectId/authorize', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await platform.getProject(projectId);
    if (!project || project.status !== 'active') return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    const settings = authSettings(project);
    const q = req.query as { provider?: string; redirect_to?: string; scopes?: string; code_challenge?: string; code_challenge_method?: string };
    const provider = q.provider ?? '';
    const def = PROVIDERS[provider];
    if (!def) return reply.status(400).send({ error: 'Bad Request', message: `Unsupported provider. Use one of: ${OAUTH_PROVIDERS.join(', ')}` });
    const creds = credentials(settings, provider);
    if (!creds) return reply.status(400).send({ error: 'Provider Disabled', message: `${provider} sign-in is not configured for this project` });
    const method = (q.code_challenge_method ?? 's256').toLowerCase();
    if (q.code_challenge && (!['s256', 'plain'].includes(method) || !/^[A-Za-z0-9._~-]{43,128}$/.test(q.code_challenge))) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Invalid code_challenge' });
    }

    const redirectTo = isAllowedRedirect(settings, q.redirect_to) ? q.redirect_to! : (settings.site_url || config.SITE_URL);
    // extra scopes are added to the provider's defaults (as in Supabase)
    const scope = [...new Set([...def.scope.split(' '), ...(q.scopes ?? '').split(/[\s,]+/)].filter(Boolean))].join(' ');
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await db`
      INSERT INTO auth.oauth_states (project_id, state, code_verifier, provider, redirect_uri, scopes, ip_address, expires_at,
                                     client_code_challenge, client_code_challenge_method)
      VALUES (${project.id}, ${state}, ${verifier}, ${provider}, ${redirectTo}, ${scope}, ${req.ip}, NOW() + INTERVAL '10 minutes',
              ${q.code_challenge ?? null}, ${q.code_challenge ? method : null})`;

    const url = new URL(endpoint(provider, def, 'authorize', creds.p.url)!);
    url.searchParams.set('client_id', creds.id);
    url.searchParams.set('redirect_uri', `${authPublicUrl}/v1/${project.id}/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    if (def.pkce) {
      url.searchParams.set('code_challenge', s256(verifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    for (const [k, v] of Object.entries(def.authParams ?? {})) url.searchParams.set(k, v);
    return reply.redirect(url.toString());
  });

  const callback = async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };
    const q = { ...(req.query as object), ...(req.method === 'POST' ? (req.body as object ?? {}) : {}) } as Record<string, string>;
    const project = await platform.getProject(projectId);
    if (!project || project.status !== 'active') return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    const settings = authSettings(project);

    const [st] = q['state'] ? await db`
      DELETE FROM auth.oauth_states WHERE state = ${q['state']} AND project_id = ${projectId} RETURNING *` : [];
    const fallback = settings.site_url || config.SITE_URL;
    if (!st || new Date(st['expires_at'] as string) < new Date()) {
      return reply.redirect(`${fallback}#error=invalid_state&error_description=${encodeURIComponent('OAuth state is missing or expired')}`);
    }
    const redirectTo = st['redirect_uri'] as string;
    const pkce = !!st['client_code_challenge'];
    const withParams = (p: Record<string, string>) => {
      const qs = new URLSearchParams(p).toString();
      if (!pkce) return `${redirectTo}#${qs}`;
      return `${redirectTo}${redirectTo.includes('?') ? '&' : '?'}${qs}`;
    };
    const fail = (msg: string) => reply.redirect(withParams({ error: 'oauth_failed', error_description: msg }));
    if (q['error']) return fail(q['error_description'] ?? q['error']);
    if (!q['code']) return fail('Missing authorization code');

    const provider = st['provider'] as string;
    const def = PROVIDERS[provider];
    const creds = def && credentials(settings, provider);
    if (!def || !creds) return fail('Provider is no longer configured');
    const url = (kind: Kind) => {
      const u = endpoint(provider, def, kind, creds.p.url);
      if (!u) throw new Error(`${provider} has no ${kind} endpoint`);
      return u;
    };

    let profile: Profile;
    let tok: any;
    try {
      const secret = await clientSecret(projectId, provider, creds);
      const form: Record<string, string> = {
        grant_type: 'authorization_code', code: q['code'], redirect_uri: `${authPublicUrl}/v1/${projectId}/callback`,
      };
      if (def.pkce) form['code_verifier'] = st['code_verifier'] as string;
      const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
      if (def.basicAuth) {
        headers['Authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(creds.id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
        form['client_id'] = creds.id;
      } else Object.assign(form, { client_id: creds.id, client_secret: secret });
      const tokenRes = await fetch(url('token'), { method: 'POST', headers, body: new URLSearchParams(form) });
      tok = (await tokenRes.json().catch(() => ({}))) as any;
      if (!tok.access_token && !tok.id_token) return fail(tok.error_description ?? tok.error ?? `Token exchange failed (${tokenRes.status})`);
      // The id_token comes straight from the provider's token endpoint over TLS, so its claims can be read without a signature check (OIDC Core 3.1.3.7).
      const idClaims = typeof tok.id_token === 'string' ? decodeJwt(tok.id_token) : null;
      const auth = { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json', 'User-Agent': 'OwnDatabase-Auth' };
      profile = await def.profile({
        access: tok.access_token, idClaims, clientId: creds.id, form: req.method === 'POST' ? q : undefined,
        url, get: (kind, extra) => getJson(url(kind), { ...auth, ...(extra ?? {}) }),
      });
      if (!profile.id || profile.id === 'undefined') throw new Error('The provider returned no user id');
    } catch (err) {
      req.log.error({ err, provider }, 'OAuth exchange failed');
      return fail('Could not complete sign-in with the identity provider');
    }

    const user = await signInUser(project, provider, profile);
    if (typeof user === 'string') return fail(user);

    if (pkce) {
      const code = randomBytes(24).toString('base64url');
      await db`DELETE FROM auth.flow_state WHERE expires_at < NOW() - INTERVAL '1 hour'`;
      await db`
        INSERT INTO auth.flow_state (project_id, auth_code, code_challenge, code_challenge_method, user_id, provider,
                                     provider_access_token, provider_refresh_token, expires_at)
        VALUES (${projectId}, ${sha256hex(code)}, ${st['client_code_challenge'] as string}, ${st['client_code_challenge_method'] as string},
                ${user.id}, ${provider}, ${tok.access_token ?? null}, ${tok.refresh_token ?? null}, NOW() + INTERVAL '5 minutes')`;
      return reply.redirect(withParams({ code }));
    }
    const s = await issueSession(project, user, req, { amr: 'oauth' });
    await audit(projectId, 'login', req, user.id, s.session_id, { method: 'oauth', provider });
    const frag: Record<string, string> = {
      access_token: s.access_token, refresh_token: s.refresh_token, expires_in: String(s.expires_in),
      expires_at: String(Math.floor(Date.now() / 1000) + Number(s.expires_in)), token_type: 'bearer', provider,
    };
    if (tok.access_token) frag['provider_token'] = tok.access_token;
    if (tok.refresh_token) frag['provider_refresh_token'] = tok.refresh_token;
    return reply.redirect(withParams(frag));
  };
  server.get('/v1/:projectId/callback', callback);
  server.post('/v1/:projectId/callback', callback);
}
