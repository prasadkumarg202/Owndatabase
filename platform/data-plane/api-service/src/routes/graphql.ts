/**
 * GraphQL endpoint:  POST /graphql/v1/:projectId  { query, variables?, operationName? }
 *                    GET  /graphql/v1/:projectId?query=…   (queries only)
 * See lib/graphql.ts for the generated schema.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GraphQLError } from 'graphql';
import { poolerDb } from '../lib/db.js';
import { getSchema, type SchemaInfo } from '../lib/schema-cache.js';
import { buildSchema, runGraphql, type BuiltSchema } from '../lib/graphql.js';
import { withRole } from '../lib/platform-auth.js';
import { isDbReadOnly } from '../lib/limits.js';
import { config } from '../config.js';

const built = new WeakMap<SchemaInfo, BuiltSchema>();

function schemaFor(info: SchemaInfo): BuiltSchema {
  let b = built.get(info);
  if (!b) { b = buildSchema(info); built.set(info, b); }
  return b;
}

export default async function graphqlRoutes(server: FastifyInstance) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.auth;
    const info = await getSchema(auth.project.id, auth.project.db_schema);
    const body = req.method === 'GET'
      ? { query: (req.query as any)['query'], variables: (() => { try { return JSON.parse((req.query as any)['variables'] ?? 'null'); } catch { return null; } })(), operationName: (req.query as any)['operationName'] }
      : (req.body ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
    if (req.method === 'GET' && /\bmutation\b/.test(String(body.query ?? ''))) {
      return reply.status(405).send({ errors: [{ message: 'Use POST for mutations' }] });
    }
    const { status, result } = await runGraphql(schemaFor(info), {
      schemaName: auth.project.db_schema,
      maxRows: config.MAX_ROWS,
      run: async (sql, values) => {
        try {
          return await withRole(poolerDb, auth, async (tx) => (await tx.unsafe(sql, values as any[]))[0]?.['r'], config.STATEMENT_TIMEOUT_MS);
        } catch (err: any) {
          throw new GraphQLError(err?.code === '42501' ? `${err.message} (check the table's grants and Row Level Security policies)` : err?.message ?? 'Query failed',
            { extensions: { code: err?.code } });
        }
      },
    }, body, { readOnly: isDbReadOnly(auth.project) });
    return reply.status(status).send(result);
  };
  server.post('/graphql/v1/:projectId', handler);
  server.get('/graphql/v1/:projectId', handler);
}
