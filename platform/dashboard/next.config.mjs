/** @type {import('next').NextConfig} */
// In Docker Compose, Caddy routes /api, /auth, /rest, /storage, /functions and
// /realtime. These rewrites make `next dev` / `next start` work on their own too.
const CONTROL = process.env.CONTROL_API_INTERNAL_URL || 'http://control-api:3000';
const STORAGE = process.env.STORAGE_INTERNAL_URL || 'http://storage-api:3005';
const DATA_API = process.env.DATA_API_INTERNAL_URL || 'http://api-service:3003';
const AUTH = process.env.AUTH_INTERNAL_URL || 'http://auth-service:3002';

const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return {
      // afterFiles: our own /api/health route wins over the proxy
      afterFiles: [
        { source: '/api/:path*', destination: `${CONTROL}/api/:path*` },
        { source: '/storage/:path*', destination: `${STORAGE}/:path*` },
        { source: '/rest/:path*', destination: `${DATA_API}/:path*` },
        { source: '/functions/:path*', destination: `${DATA_API}/functions/:path*` },
        { source: '/auth/:path*', destination: `${AUTH}/:path*` },
      ],
    };
  },
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default nextConfig;
