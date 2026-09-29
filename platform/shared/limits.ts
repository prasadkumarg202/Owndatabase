/**
 * Per-project usage limits (projects.settings.limits), set by platform admins.
 * A missing / null limit means unlimited. Shared by the data-plane services
 * (copied by scripts/sync-shared.sh — edit platform/shared/limits.ts).
 *
 *   api_requests_per_day          REST + RPC requests (UTC day)       → 429 until midnight UTC
 *   function_invocations_per_day  function calls (UTC day)            → 429 until midnight UTC
 *   storage_bytes                 total stored object bytes           → 402 on upload
 *   auth_users                    end users (not deleted)             → 402 on sign-up
 *   realtime_connections          concurrent WebSocket connections    → refused on connect
 *   database_bytes                project schema size, checked every minute by the
 *                                 control API; over it the project is read-only
 *                                 (inserts/updates → 402, reads and deletes still work)
 */
export interface ProjectLimits {
  api_requests_per_day?: number | null;
  function_invocations_per_day?: number | null;
  storage_bytes?: number | null;
  auth_users?: number | null;
  realtime_connections?: number | null;
  database_bytes?: number | null;
}

export const LIMIT_KEYS = [
  'api_requests_per_day', 'function_invocations_per_day', 'storage_bytes', 'auth_users', 'realtime_connections', 'database_bytes',
] as const;

interface WithSettings { settings?: Record<string, any> | null }

export function limitOf(project: WithSettings, key: keyof ProjectLimits): number | null {
  const v = project.settings?.['limits']?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Set by the control API's database-size check. */
export function isDbReadOnly(project: WithSettings): boolean {
  return project.settings?.['quota_state']?.['db_read_only'] === true;
}

export function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export const QUOTA_ERROR = 'Quota Exceeded';
