/**
 * POST /v1/:projectId/rpc/:fn   — call a function in the project schema with named arguments
 * GET  /v1/:projectId/rpc/:fn   — same, arguments from the query string (stable/immutable functions only)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { poolerDb } from '../lib/db.js';
import { getSchema } from '../lib/schema-cache.js';
import { withRole } from '../lib/platform-auth.js';
import { config } from '../config.js';
import { Params, QueryError, ident } from '../lib/query-builder.js';
import { sendError } from './rest.js';

export default async function rpcRoutes(server: FastifyInstance) {
  const call = async (req: FastifyRequest, reply: FastifyReply, args: Record<string, unknown>) => {
    try {
      const { fn } = req.params as { fn: string };
      const schema = await getSchema(req.auth.project.id, req.auth.project.db_schema);
      const f = schema.functions.get(fn);
      if (!f) throw new QueryError(404, `Function '${fn}' not found in the project schema`);
      if (req.method === 'GET' && f.volatility === 'volatile') throw new QueryError(405, 'Volatile functions must be called with POST');

      const p = new Params();
      const known = new Map(f.args.map((a) => [a.name, a]));
      const parts: string[] = [];
      for (const [k, v] of Object.entries(args ?? {})) {
        if (k === 'apikey') continue;
        const a = known.get(k);
        if (!a) throw new QueryError(400, `Function '${fn}' has no argument '${k}'`, `Arguments: ${f.args.map((x) => `${x.name} ${x.type}`).join(', ') || '(none)'}`);
        const val = v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
        parts.push(`${ident(k)} => ${p.add(val)}::text::${a.type}`);
      }
      for (const a of f.args) {
        if (!a.has_default && !(a.name in (args ?? {}))) throw new QueryError(400, `Missing argument '${a.name}'`);
      }
      const callExpr = `${ident(req.auth.project.db_schema)}.${ident(fn)}(${parts.join(', ')})`;
      const scalar = !f.returns_set && !/^(TABLE|SETOF)/i.test(f.returns) && !schema.tables.has(f.returns.replace(/^.*\./, '').replace(/"/g, ''));
      const sql = scalar
        ? `SELECT to_json(${callExpr})::text AS body`
        : `SELECT COALESCE(json_agg(_r), '[]')::text AS body FROM ${callExpr} _r`;
      const [row] = await withRole(poolerDb, req.auth, (tx) => tx.unsafe(sql, p.values as any[]), config.STATEMENT_TIMEOUT_MS);
      return reply.type('application/json').send(row!['body'] ?? 'null');
    } catch (err) {
      return sendError(reply, err, req.auth?.role);
    }
  };
  server.post('/v1/:projectId/rpc/:fn', (req, reply) => call(req, reply, (req.body ?? {}) as Record<string, unknown>));
  server.get('/v1/:projectId/rpc/:fn', (req, reply) => call(req, reply, req.query as Record<string, unknown>));
}
