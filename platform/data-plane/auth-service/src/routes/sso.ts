/**
 * Single sign-on with SAML 2.0 (docs/sso.md), compatible with supabase.auth.signInWithSSO().
 *
 *   POST /v1/:projectId/sso                 { domain | provider_id, redirect_to, skip_http_redirect, code_challenge… }
 *                                           → the IdP sign-in URL ({ url } or a 303)
 *   POST /v1/:projectId/sso/saml/acs        the IdP posts SAMLResponse + RelayState here
 *   GET  /v1/:projectId/sso/saml/metadata   service-provider metadata to register with the IdP
 *   /v1/:projectId/admin/sso/providers      [service_role] list / add / get / update / delete IdPs
 *
 * SAML responses are validated by @node-saml/node-saml: the assertion must be signed by one of the
 * IdP's certificates, name this project as audience, be within its validity window, and answer an
 * AuthnRequest this project sent (InResponseTo, also bound to the RelayState). An IdP may only assert
 * email addresses in the domains registered for it; only those are treated as verified.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { inflateRawSync } from 'node:zlib';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile as SamlProfile } from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { authPublicUrl, config } from '../config.js';
import { projectContext, serviceContext } from '../middleware/auth.js';
import { authSettings, isAllowedRedirect, platform } from '../lib/session.js';
import type { ProjectInfo } from '../lib/platform-auth.js';
import { assertPublicUrl } from '../lib/sms.js';
import { completeRedirectSignIn, signInUser } from './oauth.js';

const spEntityId = (projectId: string) => `${authPublicUrl}/v1/${projectId}/sso/saml/metadata`;
const acsUrl = (projectId: string) => `${authPublicUrl}/v1/${projectId}/sso/saml/acs`;

// ── IdP metadata ─────────────────────────────────────────────────────────────

interface IdpInfo { entityId: string; ssoUrl: string; certificates: string[]; nameIdFormat: string | null }

const NS = { md: 'urn:oasis:names:tc:SAML:2.0:metadata', ds: 'http://www.w3.org/2000/09/xmldsig#' };
const select = xpath.useNamespaces(NS);

function toPem(b64: string) {
  const body = b64.replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export function parseIdpMetadata(xml: string): IdpInfo {
  if (xml.length > 1_000_000) throw new Error('Metadata is too large');
  if (/<!DOCTYPE/i.test(xml)) throw new Error('Metadata must not contain a DOCTYPE');
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Node;
  const entities = select('//md:EntityDescriptor[md:IDPSSODescriptor]', doc) as Element[];
  if (entities.length !== 1) throw new Error('Metadata must describe exactly one identity provider (IDPSSODescriptor)');
  const entity = entities[0]!;
  const entityId = entity.getAttribute('entityID') ?? '';
  const services = select('md:IDPSSODescriptor/md:SingleSignOnService', entity) as Element[];
  const redirect = services.find((s) => s.getAttribute('Binding') === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect');
  const ssoUrl = redirect?.getAttribute('Location') ?? '';
  const certificates = (select("md:IDPSSODescriptor/md:KeyDescriptor[not(@use) or @use='signing']//ds:X509Certificate/text()", entity) as Node[])
    .map((n) => toPem(String(n.nodeValue ?? '')));
  const nameIdFormat = (select('string(md:IDPSSODescriptor/md:NameIDFormat[1])', entity) as unknown as string) || null;
  if (!entityId) throw new Error('Metadata has no entityID');
  if (!/^https?:\/\//.test(ssoUrl)) throw new Error('Metadata has no HTTP-Redirect SingleSignOnService');
  if (!certificates.length) throw new Error('Metadata has no signing certificate');
  return { entityId, ssoUrl, certificates, nameIdFormat };
}

async function fetchMetadata(url: string): Promise<string> {
  if (!url.startsWith('https://') && process.env['SSO_ALLOW_HTTP_METADATA'] !== 'true') throw new Error('metadata_url must be https');
  await assertPublicUrl(url, 'SSO metadata URLs');
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`metadata_url returned ${r.status}`);
  const text = await r.text();
  if (text.length > 1_000_000) throw new Error('Metadata is too large');
  return text;
}

// ── SAML ─────────────────────────────────────────────────────────────────────

/** AuthnRequest ids we issued, for InResponseTo validation (10 minutes). */
const requestCache: CacheProvider = {
  async saveAsync(key, value) {
    const ok = await redis.set(`saml:req:${key}`, value, 'EX', 600, 'NX');
    return ok ? { value, createdAt: Date.now() } : null;
  },
  async getAsync(key) { return redis.get(`saml:req:${key}`); },
  async removeAsync(key) {
    if (!key) return null;
    const v = await redis.get(`saml:req:${key}`);
    await redis.del(`saml:req:${key}`);
    return v;
  },
};

function samlFor(projectId: string, p: Record<string, any>) {
  return new SAML({
    issuer: spEntityId(projectId),
    callbackUrl: acsUrl(projectId),
    entryPoint: p['sso_url'],
    idpCert: p['certificates'] as string[],
    idpIssuer: p['entity_id'],
    audience: spEntityId(projectId),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    acceptedClockSkewMs: 60_000,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 600_000,
    cacheProvider: requestCache,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
  });
}

const EMAIL_ATTRS = ['email', 'mail', 'emailAddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3'];
const NAME_ATTRS = ['name', 'displayName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'urn:oid:2.16.840.1.113730.3.1.241'];

function attr(profile: SamlProfile, names: string[]): string | null {
  for (const n of names) {
    const v = (profile as any)[n] ?? (profile as any).attributes?.[n];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s) return s;
  }
  return null;
}

/** attribute_mapping: { keys: { email: { name: 'mail' }, name: { name: 'displayName' }, <custom>: { name } } } (Supabase format) */
function mapAttributes(profile: SamlProfile, mapping: any) {
  const keys = (mapping?.keys ?? {}) as Record<string, { name?: string; default?: unknown }>;
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(keys)) {
    const v = spec?.name ? attr(profile, [spec.name]) : null;
    out[k] = v ?? spec?.default ?? null;
  }
  const nameIdEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profile.nameID ?? '') ? profile.nameID : null;
  const email = (out['email'] as string | null) ?? attr(profile, EMAIL_ATTRS) ?? nameIdEmail;
  const name = (out['name'] as string | null) ?? attr(profile, NAME_ATTRS);
  return { email: email ? email.toLowerCase() : null, name, custom: out };
}

const providerView = (p: Record<string, any>, domains: string[]) => ({
  id: p['id'],
  saml: { entity_id: p['entity_id'], metadata_url: p['metadata_url'] ?? undefined, metadata_xml: p['metadata_xml'], attribute_mapping: p['attribute_mapping'] },
  domains: domains.map((domain) => ({ domain })),
  created_at: p['created_at'], updated_at: p['updated_at'],
});

const providerSchema = z.object({
  type: z.literal('saml').optional(),
  metadata_xml: z.string().max(1_000_000).optional(),
  metadata_url: z.string().url().max(1000).optional(),
  domains: z.array(z.string().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'invalid domain')).max(50).optional(),
  attribute_mapping: z.object({ keys: z.record(z.object({ name: z.string().max(300).optional(), default: z.unknown().optional() })) }).partial().optional(),
});

export default async function (server: FastifyInstance) {
  // ── admin: providers ────────────────────────────────────────────────────────
  const domainsOf = async (id: string) => (await db`SELECT domain FROM auth.sso_domains WHERE provider_id = ${id} ORDER BY domain`).map((r) => r['domain'] as string);

  async function saveDomains(projectId: string, providerId: string, domains: string[] | undefined) {
    if (!domains) return;
    await db`DELETE FROM auth.sso_domains WHERE provider_id = ${providerId}`;
    for (const d of [...new Set(domains)]) {
      await db`INSERT INTO auth.sso_domains (provider_id, project_id, domain) VALUES (${providerId}, ${projectId}, ${d})`;
    }
  }

  const bad = (reply: FastifyReply, message: string, status = 400) => reply.status(status).send({ error: 'Bad Request', message });

  server.get('/v1/:projectId/admin/sso/providers', { preValidation: [serviceContext] }, async (req, reply) => {
    const rows = await db`SELECT * FROM auth.sso_providers WHERE project_id = ${req.ctx.project.id} ORDER BY created_at`;
    return reply.send({ items: await Promise.all(rows.map(async (p) => providerView(p, await domainsOf(p['id'])))) });
  });

  server.post('/v1/:projectId/admin/sso/providers', { preValidation: [serviceContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const b = providerSchema.safeParse(req.body);
    if (!b.success) return bad(reply, b.error.errors[0]?.message ?? 'Invalid input');
    if (!b.data.metadata_xml === !b.data.metadata_url) return bad(reply, 'Send metadata_xml or metadata_url');
    let xml: string, idp: IdpInfo;
    try {
      xml = b.data.metadata_xml ?? await fetchMetadata(b.data.metadata_url!);
      idp = parseIdpMetadata(xml);
    } catch (err) { return bad(reply, (err as Error).message); }
    try {
      const [p] = await db`
        INSERT INTO auth.sso_providers (project_id, entity_id, sso_url, certificates, metadata_xml, metadata_url, attribute_mapping, name_id_format)
        VALUES (${project.id}, ${idp.entityId}, ${idp.ssoUrl}, ${idp.certificates}, ${xml}, ${b.data.metadata_url ?? null},
                ${db.json((b.data.attribute_mapping ?? {}) as any)}, ${idp.nameIdFormat})
        RETURNING *`;
      await saveDomains(project.id, p!['id'], b.data.domains);
      return reply.status(201).send(providerView(p!, await domainsOf(p!['id'])));
    } catch (err: any) {
      if (err?.code === '23505') return bad(reply, 'A provider with this entity id or one of these domains already exists', 409);
      throw err;
    }
  });

  server.get('/v1/:projectId/admin/sso/providers/:id', { preValidation: [serviceContext] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Not Found', message: 'Provider not found' });
    const [p] = await db`SELECT * FROM auth.sso_providers WHERE id = ${id} AND project_id = ${req.ctx.project.id}`;
    if (!p) return reply.status(404).send({ error: 'Not Found', message: 'Provider not found' });
    return reply.send(providerView(p, await domainsOf(id)));
  });

  server.put('/v1/:projectId/admin/sso/providers/:id', { preValidation: [serviceContext] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { project } = req.ctx;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Not Found', message: 'Provider not found' });
    const [cur] = await db`SELECT * FROM auth.sso_providers WHERE id = ${id} AND project_id = ${project.id}`;
    if (!cur) return reply.status(404).send({ error: 'Not Found', message: 'Provider not found' });
    const b = providerSchema.safeParse(req.body);
    if (!b.success) return bad(reply, b.error.errors[0]?.message ?? 'Invalid input');
    try {
      if (b.data.metadata_xml || b.data.metadata_url) {
        const xml = b.data.metadata_xml ?? await fetchMetadata(b.data.metadata_url!);
        const idp = parseIdpMetadata(xml);
        if (idp.entityId !== cur['entity_id']) return bad(reply, 'The metadata is for a different entity id');
        await db`UPDATE auth.sso_providers SET sso_url = ${idp.ssoUrl}, certificates = ${idp.certificates}, metadata_xml = ${xml},
                   metadata_url = ${b.data.metadata_url ?? cur['metadata_url']}, name_id_format = ${idp.nameIdFormat}, updated_at = NOW() WHERE id = ${id}`;
      }
      if (b.data.attribute_mapping) await db`UPDATE auth.sso_providers SET attribute_mapping = ${db.json(b.data.attribute_mapping as any)}, updated_at = NOW() WHERE id = ${id}`;
      await saveDomains(project.id, id, b.data.domains);
    } catch (err: any) {
      if (err?.code === '23505') return bad(reply, 'One of these domains belongs to another provider', 409);
      return bad(reply, (err as Error).message);
    }
    const [p] = await db`SELECT * FROM auth.sso_providers WHERE id = ${id}`;
    return reply.send(providerView(p!, await domainsOf(id)));
  });

  server.delete('/v1/:projectId/admin/sso/providers/:id', { preValidation: [serviceContext] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Not Found', message: 'Provider not found' });
    const [p] = await db`DELETE FROM auth.sso_providers WHERE id = ${id} AND project_id = ${req.ctx.project.id} RETURNING *`;
    if (!p) return reply.status(404).send({ error: 'Not Found', message: 'Provider not found' });
    return reply.send(providerView(p, []));
  });

  // ── sign-in ─────────────────────────────────────────────────────────────────
  server.get('/v1/:projectId/sso/saml/metadata', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await platform.getProject(projectId);
    if (!project) return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    const xml = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${spEntityId(projectId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl(projectId)}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
    return reply.header('Content-Type', 'application/samlmetadata+xml').send(xml);
  });

  server.post('/v1/:projectId/sso', { preValidation: [projectContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const settings = authSettings(project);
    const b = z.object({
      // supabase-js sends null for the fields it does not use
      domain: z.string().toLowerCase().nullish(), provider_id: z.string().uuid().nullish(),
      redirect_to: z.string().nullish(), skip_http_redirect: z.boolean().nullish(),
      code_challenge: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).nullish(), code_challenge_method: z.string().nullish(),
    }).safeParse(req.body ?? {});
    if (!b.success) return bad(reply, b.error.errors[0]?.message ?? 'Invalid input');
    if (!b.data.domain === !b.data.provider_id) return bad(reply, 'Send domain or provider_id');
    const [p] = b.data.provider_id
      ? await db`SELECT * FROM auth.sso_providers WHERE id = ${b.data.provider_id} AND project_id = ${project.id}`
      : await db`SELECT p.* FROM auth.sso_providers p JOIN auth.sso_domains d ON d.provider_id = p.id
                 WHERE d.project_id = ${project.id} AND d.domain = ${b.data.domain!}`;
    if (!p) return reply.status(404).send({ error: 'SSO Provider Not Found', message: 'No SSO provider matches' });
    const method = (b.data.code_challenge_method ?? 's256').toLowerCase();
    if (b.data.code_challenge && !['s256', 'plain'].includes(method)) return bad(reply, 'Invalid code_challenge_method');
    const redirectTo = isAllowedRedirect(settings, b.data.redirect_to ?? undefined) ? b.data.redirect_to! : (settings.site_url || config.SITE_URL);

    await db`DELETE FROM auth.saml_relay_states WHERE expires_at < NOW()`;
    const [relay] = await db`
      INSERT INTO auth.saml_relay_states (project_id, provider_id, redirect_to, code_challenge, code_challenge_method, expires_at)
      VALUES (${project.id}, ${p['id']}, ${redirectTo}, ${b.data.code_challenge ?? null}, ${b.data.code_challenge ? method : null}, NOW() + INTERVAL '10 minutes')
      RETURNING id`;
    const url = await samlFor(project.id, p).getAuthorizeUrlAsync(relay!['id'], undefined, {});
    // bind the RelayState to this AuthnRequest's id
    const samlRequest = new URL(url).searchParams.get('SAMLRequest');
    const requestId = samlRequest ? /\sID="([^"]+)"/.exec(inflateRawSync(Buffer.from(samlRequest, 'base64')).toString('utf8'))?.[1] : null;
    await db`UPDATE auth.saml_relay_states SET request_id = ${requestId ?? null} WHERE id = ${relay!['id']}`;
    if (b.data.skip_http_redirect) return reply.send({ url });
    return reply.redirect(url, 303);
  });

  server.post('/v1/:projectId/sso/saml/acs', async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };
    const form = (req.body ?? {}) as Record<string, string>;
    const project = await platform.getProject(projectId) as ProjectInfo | null;
    if (!project || project.status !== 'active') return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    const settings = authSettings(project);
    const relayId = String(form['RelayState'] ?? '');
    const [relay] = /^[0-9a-f-]{36}$/i.test(relayId)
      ? await db`DELETE FROM auth.saml_relay_states WHERE id = ${relayId} AND project_id = ${projectId} RETURNING *` : [];
    const fallback = settings.site_url || config.SITE_URL;
    if (!relay || new Date(relay['expires_at']) < new Date()) {
      return reply.redirect(`${fallback}#error=invalid_request&error_description=${encodeURIComponent('SAML sign-in expired or was not started here')}`);
    }
    const redirectTo = relay['redirect_to'] as string;
    const pkce = relay['code_challenge'] ? { challenge: relay['code_challenge'] as string, method: relay['code_challenge_method'] as string } : null;
    const fail = (msg: string) => {
      const qs = new URLSearchParams({ error: 'sso_failed', error_description: msg }).toString();
      return reply.redirect(pkce ? `${redirectTo}${redirectTo.includes('?') ? '&' : '?'}${qs}` : `${redirectTo}#${qs}`);
    };
    const [p] = await db`SELECT * FROM auth.sso_providers WHERE id = ${relay['provider_id']} AND project_id = ${projectId}`;
    if (!p) return fail('The SSO provider no longer exists');

    let profile: SamlProfile;
    try {
      const r = await samlFor(projectId, p).validatePostResponseAsync({ SAMLResponse: String(form['SAMLResponse'] ?? '') });
      if (!r.profile) throw new Error('No profile in the SAML response');
      profile = r.profile;
      // the response must answer the request this RelayState was created for
      const inResponseTo = /InResponseTo="([^"]+)"/.exec(profile.getSamlResponseXml?.() ?? '')?.[1];
      if (!relay['request_id'] || inResponseTo !== relay['request_id']) throw new Error('The SAML response does not answer this sign-in request');
    } catch (err) {
      req.log.warn({ err: (err as Error).message, provider: p['id'] }, 'SAML response rejected');
      return fail('The identity provider response could not be verified');
    }

    const mapped = mapAttributes(profile, p['attribute_mapping']);
    const domains = await domainsOf(p['id']);
    const emailDomain = mapped.email?.split('@')[1] ?? '';
    // only the IdP's own domains are trusted: a verified email can be linked to an existing account
    const verified = !!mapped.email && domains.includes(emailDomain);
    if (mapped.email && domains.length && !verified) return fail(`This identity provider may not sign in ${emailDomain} addresses`);
    const provider = `sso:${p['id']}`;
    const user = await signInUser(project, provider, {
      id: profile.nameID, email: mapped.email, email_verified: verified, name: mapped.name ?? undefined,
      raw: { ...mapped.custom, name_id: profile.nameID, name_id_format: profile.nameIDFormat, issuer: profile.issuer },
    });
    if (typeof user === 'string') return fail(user);
    return completeRedirectSignIn(req, reply, project, user, provider, { redirectTo, amr: 'sso/saml', pkce });
  });
}
