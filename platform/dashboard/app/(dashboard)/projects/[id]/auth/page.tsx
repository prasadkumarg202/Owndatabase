'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, authApi, formatDate, timeAgo } from '@/lib/api';
import { useProject, useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader, Tabs } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { CopyField } from '@/components/ui/CopyField';

function UserDetail({ projectId, userId, onClose }: { projectId: string; userId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['auth-user', projectId, userId], queryFn: () => api.get(`/projects/${projectId}/users/${userId}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['auth-user', projectId, userId] }); qc.invalidateQueries({ queryKey: ['auth-users', projectId] }); };
  const patch = useMutation({ mutationFn: (b: any) => api.patch(`/projects/${projectId}/users/${userId}`, b), onSuccess: () => { toast.success('User updated'); refresh(); }, onError: (e) => toast.error(e) });
  const signOut = useMutation({ mutationFn: () => api.delete(`/projects/${projectId}/users/${userId}/sessions`), onSuccess: (r) => { toast.success(`${r.revoked} session(s) revoked`); refresh(); } });
  const del = useMutation({ mutationFn: () => api.delete(`/projects/${projectId}/users/${userId}`), onSuccess: () => { toast.success('User deleted'); refresh(); onClose(); }, onError: (e) => toast.error(e) });
  const u = data?.user;
  const banned = u?.banned_until && new Date(u.banned_until) > new Date();
  return (
    <Modal open onClose={onClose} title={u?.email ?? 'User'} wide>
      <ErrorBox error={error} />
      {u && (
        <div className="space-y-5 text-sm" data-testid="user-detail">
          <dl className="grid grid-cols-2 gap-3">
            <div><dt className="text-xs text-gray-500">User ID</dt><dd className="font-mono text-xs">{u.id}</dd></div>
            <div><dt className="text-xs text-gray-500">Created</dt><dd>{formatDate(u.created_at)}</dd></div>
            <div><dt className="text-xs text-gray-500">Last sign in</dt><dd>{formatDate(u.last_sign_in_at)}</dd></div>
            <div><dt className="text-xs text-gray-500">Status</dt><dd className="space-x-1">
              {u.email_verified ? <Badge tone="green">email verified</Badge> : <Badge tone="yellow">unverified</Badge>}
              {banned && <Badge tone="red">banned until {formatDate(u.banned_until)}</Badge>}
              {data.factors.some((f: any) => f.status === 'verified') && <Badge tone="purple">MFA</Badge>}
            </dd></div>
            <div><dt className="text-xs text-gray-500">Providers</dt><dd>{data.identities.map((i: any) => i.provider).join(', ') || '—'}</dd></div>
            <div><dt className="text-xs text-gray-500">User metadata</dt><dd className="font-mono text-xs">{JSON.stringify(u.user_metadata)}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            {!u.email_verified && <Button size="sm" variant="secondary" onClick={() => patch.mutate({ email_verified: true })}>Mark email verified</Button>}
            {banned
              ? <Button size="sm" variant="secondary" onClick={() => patch.mutate({ ban_hours: 0 })}>Unban</Button>
              : <Button size="sm" variant="secondary" onClick={() => patch.mutate({ ban_hours: 24 * 365 * 10 })} data-testid="ban-user">Ban user</Button>}
            <Button size="sm" variant="secondary" onClick={() => signOut.mutate()}>Sign out everywhere ({data.sessions.length})</Button>
            <Button size="sm" variant="danger" onClick={() => { if (confirm('Delete this user permanently?')) del.mutate(); }}>Delete user</Button>
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase text-gray-500">Recent auth events</h4>
            <ul className="max-h-48 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-200">
              {data.events.map((e: any, i: number) => <li key={i} className="flex justify-between px-3 py-1.5 text-xs"><span>{e.event_type}</span><span className="text-gray-400">{e.ip_address} · {timeAgo(e.timestamp)}</span></li>)}
              {data.events.length === 0 && <li className="px-3 py-2 text-xs text-gray-500">No events</li>}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Users({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: '', password: '' });
  const { data, error } = useQuery({ queryKey: ['auth-users', projectId, search], queryFn: () => api.get(`/projects/${projectId}/users?search=${encodeURIComponent(search)}`) });
  const create = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/users`, { ...form, email_confirmed: true }),
    onSuccess: () => { toast.success('User created'); setCreating(false); setForm({ email: '', password: '' }); qc.invalidateQueries({ queryKey: ['auth-users', projectId] }); },
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <input aria-label="Search users" placeholder="Search by email…" className="w-72 rounded-md border border-gray-300 px-3 py-1.5 text-sm" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button size="sm" onClick={() => setCreating(true)} data-testid="add-user"><Plus className="h-3.5 w-3.5" />Add user</Button>
      </div>
      <ErrorBox error={error} />
      <DataTable testId="users-table" data={data?.data} onRowClick={(u: any) => setSelected(u.id)} empty="No users yet. Users appear here when they sign up through the Auth API."
        columns={[
          { key: 'email', label: 'Email', render: (u: any) => <span className="font-medium">{u.email ?? u.phone ?? u.id}</span> },
          { key: 'providers', label: 'Providers', render: (u: any) => (u.is_anonymous ? ['anonymous', ...(u.providers ?? [])] : (u.providers ?? [])).join(', ') || '—' },
          { key: 'email_verified', label: 'Verified', render: (u: any) => u.email_verified ? <Badge tone="green">yes</Badge> : <Badge tone="yellow">no</Badge> },
          { key: 'mfa_enabled', label: 'MFA', render: (u: any) => u.mfa_enabled ? <Badge tone="purple">on</Badge> : '' },
          { key: 'banned_until', label: 'Banned', render: (u: any) => u.banned_until && new Date(u.banned_until) > new Date() ? <Badge tone="red">banned</Badge> : '' },
          { key: 'last_sign_in_at', label: 'Last sign in', render: (u: any) => timeAgo(u.last_sign_in_at) },
          { key: 'created_at', label: 'Created', render: (u: any) => formatDate(u.created_at, false) },
        ]} />
      <p className="text-xs text-gray-500">{data?.total ?? 0} user(s)</p>
      {selected && <UserDetail projectId={projectId} userId={selected} onClose={() => setSelected(null)} />}
      <Modal open={creating} onClose={() => setCreating(false)} title="Add user"
        footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} data-testid="create-user">Create user</Button></>}>
        <div className="space-y-3">
          <ErrorBox error={create.error} />
          <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input label="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} hint="The email is marked as confirmed." />
        </div>
      </Modal>
    </div>
  );
}

const OAUTH_PROVIDERS: { id: string; label: string; url?: string; apple?: boolean }[] = [
  { id: 'google', label: 'Google' },
  { id: 'apple', label: 'Apple', apple: true },
  { id: 'github', label: 'GitHub', url: 'GitHub Enterprise URL (optional)' },
  { id: 'azure', label: 'Microsoft (Azure AD)', url: 'Tenant URL (optional, e.g. https://login.microsoftonline.com/<tenant>)' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'gitlab', label: 'GitLab', url: 'Self-hosted GitLab URL (optional)' },
  { id: 'bitbucket', label: 'Bitbucket' },
  { id: 'discord', label: 'Discord' },
  { id: 'linkedin_oidc', label: 'LinkedIn' },
  { id: 'slack_oidc', label: 'Slack' },
  { id: 'x', label: 'X / Twitter (OAuth 2.0)' },
  { id: 'spotify', label: 'Spotify' },
  { id: 'twitch', label: 'Twitch' },
  { id: 'keycloak', label: 'Keycloak / OIDC', url: 'Realm URL (e.g. https://sso.example.com/realms/main)' },
];

function Settings({ projectId }: { projectId: string }) {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['auth-config', projectId], queryFn: () => api.get(`/projects/${projectId}/auth-config`) });
  const [cfg, setCfg] = useState<any>(null);
  useEffect(() => { if (data) setCfg(data); }, [data]);
  const save = useMutation({ mutationFn: () => api.put(`/projects/${projectId}/auth-config`, { ...cfg, redirect_urls: (cfg.redirect_urls_text ?? cfg.redirect_urls.join('\n')).split('\n').map((s: string) => s.trim()).filter(Boolean), redirect_urls_text: undefined }), onSuccess: (r) => { setCfg(r); toast.success('Auth settings saved'); } });
  const { data: project } = useProject(projectId);
  const authUrl = project?.endpoints?.auth_url ?? '<auth url>';
  if (!cfg) return <p className="text-sm text-gray-500">Loading…</p>;
  const set = (k: string, v: any) => setCfg({ ...cfg, [k]: v });
  const prov = (p: string, k: string, v: any) => setCfg({ ...cfg, providers: { ...cfg.providers, [p]: { ...cfg.providers?.[p], [k]: v } } });
  const sms = (k: string, v: any) => setCfg({ ...cfg, sms: { ...cfg.sms, [k]: v } });
  const toggle = (k: string, label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={!!cfg[k]} onChange={(e) => set(k, e.target.checked)} /><span>{label}{hint && <span className="block text-xs text-gray-500">{hint}</span>}</span></label>
  );
  return (
    <div className="space-y-6">
      <Card title="Sign-up and sign-in">
        <div className="grid gap-4 md:grid-cols-2">
          {toggle('enable_signup', 'Allow new users to sign up')}
          {toggle('require_email_confirmation', 'Require email confirmation', 'Users must verify their email before signing in')}
          {toggle('enable_magic_link', 'Magic links / email codes')}
          {toggle('enable_anonymous_sign_ins', 'Anonymous sign-ins', 'signInAnonymously(): guest users who can add an email or phone later')}
          {toggle('enable_mfa', 'Multi-factor authentication (TOTP)')}
          {toggle('enable_mfa_phone', 'SMS codes as a second factor', 'Sent with the phone (SMS) settings below')}
          <Input label="Minimum password length" type="number" value={cfg.password_min_length} onChange={(e) => set('password_min_length', Number(e.target.value))} />
          <Input label="Access token lifetime (seconds)" type="number" value={cfg.jwt_expiry} onChange={(e) => set('jwt_expiry', Number(e.target.value))} />
          <Input label="Lock account after failed logins" type="number" value={cfg.max_failed_logins} onChange={(e) => set('max_failed_logins', Number(e.target.value))} />
          <Input label="Lockout duration (minutes)" type="number" value={cfg.lockout_minutes} onChange={(e) => set('lockout_minutes', Number(e.target.value))} />
        </div>
      </Card>
      <Card title="URLs" description="Where users land after email links and OAuth sign-in">
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Site URL" value={cfg.site_url} onChange={(e) => set('site_url', e.target.value)} placeholder="https://myapp.com" />
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700" htmlFor="redirects">Additional redirect URLs (one per line)</label>
            <textarea id="redirects" rows={3} className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs" value={cfg.redirect_urls_text ?? cfg.redirect_urls.join('\n')} onChange={(e) => set('redirect_urls_text', e.target.value)} />
          </div>
        </div>
      </Card>
      <Card title="OAuth providers" description={`Callback URL to register with each provider: ${authUrl}/callback`}>
        <div className="grid gap-4 md:grid-cols-2">
          {OAUTH_PROVIDERS.map(({ id: p, label, url, apple }) => {
            const c = cfg.providers?.[p] ?? {};
            return (
              <details key={p} className="rounded-md border border-gray-200 p-3" open={!!c.enabled}>
                <summary className="cursor-pointer text-sm font-medium">{label}{c.enabled && <span className="ml-2 text-xs text-green-600">enabled</span>}</summary>
                <div className="mt-3 space-y-2">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`Enable ${label}`} checked={!!c.enabled} onChange={(e) => prov(p, 'enabled', e.target.checked)} />Enabled</label>
                  <Input label={apple ? 'Services ID (client ID)' : 'Client ID'} value={c.client_id ?? ''} onChange={(e) => prov(p, 'client_id', e.target.value)} />
                  {apple ? (
                    <>
                      <div className="space-y-1">
                        <label className="block text-xs font-medium text-gray-700" htmlFor={`${p}-secret`}>Secret key (.p8 contents) or a client-secret JWT</label>
                        <textarea id={`${p}-secret`} rows={3} className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs" value={c.client_secret ?? ''} onChange={(e) => prov(p, 'client_secret', e.target.value)} />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input label="Team ID" value={c.team_id ?? ''} onChange={(e) => prov(p, 'team_id', e.target.value)} />
                        <Input label="Key ID" value={c.key_id ?? ''} onChange={(e) => prov(p, 'key_id', e.target.value)} />
                      </div>
                    </>
                  ) : (
                    <Input label="Client secret" type="password" value={c.client_secret ?? ''} onChange={(e) => prov(p, 'client_secret', e.target.value)} />
                  )}
                  {url && <Input label={url} value={c.url ?? ''} onChange={(e) => prov(p, 'url', e.target.value)} />}
                  {['google', 'apple', 'azure', 'facebook', 'keycloak'].includes(p) && (
                    <Input label="Other client IDs for native sign-in (comma-separated)" value={c.additional_client_ids ?? ''} onChange={(e) => prov(p, 'additional_client_ids', e.target.value)} />
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </Card>
      <Card title="Phone (SMS)" description="Sign-in with one-time SMS codes and phone + password. Numbers are stored in international format (+919876543210).">
        <div className="grid gap-4 md:grid-cols-2">
          {toggle('enable_phone_auth', 'Enable phone sign-in')}
          <Input label="Code lifetime (minutes)" type="number" value={cfg.sms_otp_expiry_minutes} onChange={(e) => set('sms_otp_expiry_minutes', Number(e.target.value))} />
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700" htmlFor="sms-provider">SMS provider</label>
            <select id="sms-provider" className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={cfg.sms?.provider ?? 'none'} onChange={(e) => sms('provider', e.target.value)}>
              <option value="none">Platform default</option>
              <option value="twilio">Twilio</option>
              <option value="webhook">Webhook (MSG91, Gupshup, SNS, …)</option>
              <option value="log">Log only — never send (development)</option>
            </select>
          </div>
          <Input label="Message template" value={cfg.sms?.template ?? ''} onChange={(e) => sms('template', e.target.value)} placeholder="Your verification code is {{code}}" hint="{{code}} or {{ .Code }} is replaced by the code" />
          <div className="space-y-1 md:col-span-2">
            <label className="block text-xs font-medium text-gray-700" htmlFor="sms-test-otp">Test numbers (no SMS is sent; the fixed code always works)</label>
            <input id="sms-test-otp" className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs" value={cfg.sms?.test_otp ?? ''} onChange={(e) => sms('test_otp', e.target.value)} placeholder="+919999999999=123456, +15555550100=000000" />
          </div>
          {cfg.sms?.provider === 'twilio' && (<>
            <Input label="Account SID" value={cfg.sms?.twilio_account_sid ?? ''} onChange={(e) => sms('twilio_account_sid', e.target.value)} />
            <Input label="Auth token" type="password" value={cfg.sms?.twilio_auth_token ?? ''} onChange={(e) => sms('twilio_auth_token', e.target.value)} />
            <Input label="From number" value={cfg.sms?.twilio_from ?? ''} onChange={(e) => sms('twilio_from', e.target.value)} placeholder="+15005550006" />
            <Input label="Messaging service SID (instead of From)" value={cfg.sms?.twilio_messaging_service_sid ?? ''} onChange={(e) => sms('twilio_messaging_service_sid', e.target.value)} />
          </>)}
          {cfg.sms?.provider === 'webhook' && (<>
            <Input label="Webhook URL" value={cfg.sms?.webhook_url ?? ''} onChange={(e) => sms('webhook_url', e.target.value)} placeholder="https://sms-adapter.example.com/send" />
            <Input label="Signing secret (x-odb-signature)" type="password" value={cfg.sms?.webhook_secret ?? ''} onChange={(e) => sms('webhook_secret', e.target.value)} />
          </>)}
        </div>
      </Card>
      <Card title="Bot protection (CAPTCHA)" description="Require a Cloudflare Turnstile or hCaptcha token on sign-up, password sign-in, magic links / OTP and password recovery. Add the provider's widget to your forms and send its token as captcha_token.">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={!!cfg.captcha?.enabled} onChange={(e) => setCfg({ ...cfg, captcha: { ...cfg.captcha, enabled: e.target.checked } })} /><span>Require CAPTCHA</span></label>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700" htmlFor="captcha-provider">Provider</label>
            <select id="captcha-provider" className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={cfg.captcha?.provider ?? 'turnstile'} onChange={(e) => setCfg({ ...cfg, captcha: { ...cfg.captcha, provider: e.target.value } })}>
              <option value="turnstile">Cloudflare Turnstile</option>
              <option value="hcaptcha">hCaptcha</option>
            </select>
          </div>
          <Input label="Secret key" type="password" value={cfg.captcha?.secret ?? ''} onChange={(e) => setCfg({ ...cfg, captcha: { ...cfg.captcha, secret: e.target.value } })} />
        </div>
      </Card>
      <div className="flex items-center gap-3"><Button onClick={() => save.mutate()} loading={save.isPending} data-testid="save-auth-settings">Save settings</Button><ErrorBox error={save.error} /></div>
    </div>
  );
}

/** SAML identity providers (docs/sso.md): signInWithSSO({ domain }) */
function SsoProviders({ projectId }: { projectId: string }) {
  const toast = useToast();
  const { data: project } = useProject(projectId);
  const authUrl = project?.endpoints?.auth_url ?? '';
  const list = useQuery({ queryKey: ['sso', projectId], queryFn: () => authApi.get(`/v1/${projectId}/admin/sso/providers`).then((r: any) => r.items as any[]) });
  const [form, setForm] = useState({ metadata: '', domains: '' });
  const add = useMutation({
    mutationFn: () => {
      const m = form.metadata.trim();
      return authApi.post(`/v1/${projectId}/admin/sso/providers`, {
        type: 'saml', ...(m.startsWith('http') ? { metadata_url: m } : { metadata_xml: m }),
        domains: form.domains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
      });
    },
    onSuccess: () => { toast.success('Identity provider added'); setForm({ metadata: '', domains: '' }); list.refetch(); },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (id: string) => authApi.delete(`/v1/${projectId}/admin/sso/providers/${id}`),
    onSuccess: () => { toast.success('Removed'); list.refetch(); },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="space-y-4">
      <Card title="Register with your identity provider" description="Create a SAML app in Okta, Entra ID, Google Workspace, ... with these values.">
        <div className="grid gap-3 md:grid-cols-2">
          <CopyField label="Entity ID / metadata URL" value={`${authUrl}/sso/saml/metadata`} />
          <CopyField label="ACS (reply) URL" value={`${authUrl}/sso/saml/acs`} />
        </div>
      </Card>
      <Card title="Identity providers" bodyClassName="p-0">
        <ErrorBox error={list.error} />
        <DataTable testId="sso-providers" data={list.data} empty="No identity providers" columns={[
          { key: 'entity', label: 'Entity ID', render: (p: any) => <span className="font-mono text-xs">{p.saml.entity_id}</span> },
          { key: 'domains', label: 'Domains', render: (p: any) => p.domains.map((d: any) => d.domain).join(', ') || '—' },
          { key: 'id', label: 'Provider ID', render: (p: any) => <span className="font-mono text-xs">{p.id}</span> },
          { key: 'x', label: '', render: (p: any) => <Button size="sm" variant="danger" onClick={() => remove.mutate(p.id)}>Remove</Button> },
        ]} />
      </Card>
      <Card title="Add identity provider">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700" htmlFor="sso-metadata">IdP metadata URL (https) or metadata XML</label>
            <textarea id="sso-metadata" rows={5} className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs" value={form.metadata} onChange={(e) => setForm({ ...form, metadata: e.target.value })} />
          </div>
          <Input label="Email domains (comma-separated)" value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} placeholder="acme.com, acme.in" />
          <Button onClick={() => add.mutate()} disabled={!form.metadata.trim()} loading={add.isPending} data-testid="add-sso">Add provider</Button>
        </div>
      </Card>
    </div>
  );
}

export default function AuthPage() {
  const id = useProjectId();
  const [tab, setTab] = useState('users');
  return (
    <div>
      <PageHeader title="Authentication" description="End users of this project, and how they sign in." />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'users', label: 'Users' }, { id: 'settings', label: 'Settings' }, { id: 'sso', label: 'SSO' }]} />
      {tab === 'users' ? <Users projectId={id} /> : tab === 'sso' ? <SsoProviders projectId={id} /> : <Settings projectId={id} />}
    </div>
  );
}
