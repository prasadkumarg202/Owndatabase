/**
 * Read-replica routing for REST reads.
 *
 * With READ_REPLICA_URL set (HA: HAProxy's `replicas` listener, postgres:5433),
 * GET/HEAD requests on /rest run on a streaming replica while it is healthy:
 * in recovery and within REPLICA_MAX_LAG_BYTES of the primary (checked every
 * 2 s by comparing WAL positions — replay timestamps would make an idle primary
 * look like lag). Otherwise, and for writes and RPC, the primary is used.
 *
 * Clients that need to read their own just-written data send
 * `x-odb-read-consistency: strong`. Every response says where it was served
 * from in `x-odb-read-from: replica | primary`.
 */
import postgres from 'postgres';
import type { FastifyRequest } from 'fastify';
import { Counter, Gauge } from 'prom-client';
import { config } from '../config.js';
import { db, poolerDb } from './db.js';

export const replicaDb = config.READ_REPLICA_URL
  ? postgres(config.READ_REPLICA_URL, { max: 20, idle_timeout: 30, prepare: false, onnotice: () => {} })
  : null;

const reads = new Counter({ name: 'owndatabase_rest_reads_total', help: 'REST reads by target', labelNames: ['target'] });
const lagGauge = new Gauge({ name: 'owndatabase_read_replica_lag_bytes', help: 'Replay lag of the read replica used by the data API (-1 = unavailable)' });

let healthy = false;
let lastLag: number | null = null;

async function check() {
  if (!replicaDb) return;
  try {
    const [r] = await replicaDb`SELECT pg_is_in_recovery() AS standby, pg_last_wal_replay_lsn()::text AS replay`;
    if (!r?.['standby'] || !r['replay']) throw new Error('not a streaming replica');
    const [p] = await db`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), ${r['replay'] as string}::pg_lsn)::float8 AS lag`;
    lastLag = Math.max(0, Number(p?.['lag'] ?? 0));
    healthy = lastLag <= config.REPLICA_MAX_LAG_BYTES;
  } catch {
    healthy = false;
    lastLag = null;
  }
  lagGauge.set(lastLag ?? -1);
}

if (replicaDb) {
  void check();
  setInterval(() => void check(), 2000).unref();
}

export function replicaStatus() {
  return { configured: !!replicaDb, healthy, lag_bytes: lastLag };
}

/** Connection-level failures (and hot-standby conflicts) worth retrying on the primary. */
function retryable(err: any): boolean {
  const code = String(err?.code ?? '');
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
    '57P01', '57P02', '57P03', '40001', '08006', '08001', '08003'].includes(code);
}

/**
 * Runs a read on the replica when allowed, falling back to the primary pool.
 * `run` receives the pool to use.
 */
export async function routedRead<T>(req: FastifyRequest, run: (sql: postgres.Sql<any>) => Promise<T>): Promise<{ result: T; from: 'replica' | 'primary' }> {
  const strong = String(req.headers['x-odb-read-consistency'] ?? '').toLowerCase() === 'strong';
  if (replicaDb && healthy && !strong) {
    try {
      const result = await run(replicaDb);
      reads.inc({ target: 'replica' });
      return { result, from: 'replica' };
    } catch (err) {
      if (!retryable(err)) throw err;
      healthy = false;
      req.log.warn({ err: (err as Error).message }, 'read replica failed; retrying on the primary');
    }
  }
  const result = await run(poolerDb);
  reads.inc({ target: 'primary' });
  return { result, from: 'primary' };
}
