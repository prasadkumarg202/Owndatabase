import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function generateOTP(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function generateLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOTP(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

export function verifyOTP(otp: string, hash: string): boolean {
  const a = Buffer.from(hashOTP(otp));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
