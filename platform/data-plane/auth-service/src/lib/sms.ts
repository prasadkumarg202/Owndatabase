/**
 * SMS delivery for phone OTP. Providers, per project (Auth settings → sms),
 * falling back to platform-wide TWILIO_* env vars:
 *
 *   twilio   — Twilio Messages API (from number or messaging service SID)
 *   webhook  — POST {to, body, code, project_id} to your own URL, signed with
 *              HMAC-SHA256 (x-odb-signature: sha256=<hex>). Use it for MSG91,
 *              Gupshup, AWS SNS, WhatsApp, ... behind a small adapter.
 *
 * AUTH_DEV_MAILBOX also captures messages at GET /v1/:projectId/_dev/sms.
 */
import { createHmac } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { redis } from './redis.js';

export interface SmsSettings {
  provider?: 'none' | 'twilio' | 'webhook';
  twilio_account_sid?: string;
  twilio_auth_token?: string;
  twilio_from?: string;
  twilio_messaging_service_sid?: string;
  webhook_url?: string;
  webhook_secret?: string;
  template?: string;
}

export class SmsNotConfigured extends Error {}

// Same rule as the queue worker's webhooks: no private / internal targets (SSRF)
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l === '::';
}

async function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) SMS webhooks are allowed');
  if (process.env['WEBHOOK_ALLOW_PRIVATE'] === 'true') return;
  const addrs = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error('SMS webhooks to private / internal addresses are blocked');
}

/** E.164 (+ and 8-15 digits). Accepts spaces, dashes, brackets and a missing '+'. */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim().replace(/[\s\-().]/g, '');
  const digits = s.startsWith('+') ? s.slice(1) : s.startsWith('00') ? s.slice(2) : s;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

function resolve(s: SmsSettings): SmsSettings {
  if (s.provider && s.provider !== 'none') return s;
  if (config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && (config.TWILIO_FROM || config.TWILIO_MESSAGING_SERVICE_SID)) {
    return {
      ...s, provider: 'twilio', twilio_account_sid: config.TWILIO_ACCOUNT_SID, twilio_auth_token: config.TWILIO_AUTH_TOKEN,
      twilio_from: config.TWILIO_FROM, twilio_messaging_service_sid: config.TWILIO_MESSAGING_SERVICE_SID,
    };
  }
  return { ...s, provider: 'none' };
}

/** True when a code can actually reach a phone (a provider, or the dev mailbox). */
export function smsAvailable(s: SmsSettings): boolean {
  return resolve(s).provider !== 'none' || !!config.AUTH_DEV_MAILBOX;
}

export async function sendSmsCode(projectId: string, settings: SmsSettings, to: string, code: string) {
  const s = resolve(settings);
  const body = (s.template || 'Your verification code is {{code}}').replace(/\{\{\s*code\s*\}\}/g, code);

  if (config.AUTH_DEV_MAILBOX) {
    const key = `auth:dev-sms:${projectId}:${to}`;
    await redis.lpush(key, JSON.stringify({ to, body, code, sent_at: new Date().toISOString() }));
    await redis.ltrim(key, 0, 19);
    await redis.expire(key, 3600);
  }

  if (s.provider === 'twilio') {
    const form = new URLSearchParams({ To: to, Body: body });
    if (s.twilio_messaging_service_sid) form.set('MessagingServiceSid', s.twilio_messaging_service_sid);
    else form.set('From', s.twilio_from ?? '');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.twilio_account_sid ?? '')}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.twilio_account_sid}:${s.twilio_auth_token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Twilio returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }

  if (s.provider === 'webhook') {
    const payload = JSON.stringify({ type: 'sms_otp', project_id: projectId, to, body, code });
    await assertPublicUrl(s.webhook_url ?? '');
    const res = await fetch(s.webhook_url ?? '', {
      redirect: 'manual',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(s.webhook_secret ? { 'x-odb-signature': `sha256=${createHmac('sha256', s.webhook_secret).update(payload).digest('hex')}` } : {}),
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SMS webhook returned ${res.status}`);
    return;
  }

  if (!config.AUTH_DEV_MAILBOX) throw new SmsNotConfigured('No SMS provider is configured for this project');
}
