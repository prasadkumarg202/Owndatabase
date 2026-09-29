/** Outbound HTTP guard: refuse private / internal targets (SSRF) unless WEBHOOK_ALLOW_PRIVATE=true. */
import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOW_PRIVATE_WEBHOOKS = process.env['WEBHOOK_ALLOW_PRIVATE'] === 'true';

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l === '::';
}

export async function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) webhooks are allowed');
  if (ALLOW_PRIVATE_WEBHOOKS) return;
  const addrs = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error('Webhooks to private / internal addresses are blocked (set WEBHOOK_ALLOW_PRIVATE=true to allow)');
}
