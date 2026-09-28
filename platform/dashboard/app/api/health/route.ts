// Liveness probe for the dashboard container itself (does not proxy to the control API).
export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ status: 'ok', service: 'dashboard', timestamp: new Date().toISOString() });
}
