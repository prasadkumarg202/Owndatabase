/**
 * OpenAPI 3.1 document generated from the live project schema.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSchema, type ColumnInfo } from './schema-cache.js';
import { config } from '../config.js';

function jsonType(c: ColumnInfo): Record<string, unknown> {
  const u = c.udt;
  let t: Record<string, unknown>;
  if (['int2', 'int4'].includes(u)) t = { type: 'integer' };
  else if (u === 'int8') t = { type: 'integer', format: 'int64' };
  else if (['float4', 'float8', 'numeric'].includes(u)) t = { type: 'number' };
  else if (u === 'bool') t = { type: 'boolean' };
  else if (['json', 'jsonb'].includes(u)) t = {};
  else if (u === 'uuid') t = { type: 'string', format: 'uuid' };
  else if (['timestamptz', 'timestamp'].includes(u)) t = { type: 'string', format: 'date-time' };
  else if (u === 'date') t = { type: 'string', format: 'date' };
  else if (u.startsWith('_')) t = { type: 'array', items: {} };
  else t = { type: 'string' };
  return { ...t, description: `${c.type}${c.is_pk ? ' (primary key)' : ''}` };
}

export async function openApiHandler(req: FastifyRequest, reply: FastifyReply) {
  const { project } = req.auth;
  const schema = await getSchema(project.id, project.db_schema);
  const base = `/v1/${project.id}`;
  const paths: Record<string, any> = {};
  const schemas: Record<string, any> = {};
  const filterParams = [
    { name: 'select', in: 'query', schema: { type: 'string' }, description: 'Columns and embedded relations, e.g. id,title,author:users(name)' },
    { name: 'order', in: 'query', schema: { type: 'string' }, description: 'e.g. created_at.desc,id' },
    { name: 'limit', in: 'query', schema: { type: 'integer' } },
    { name: 'offset', in: 'query', schema: { type: 'integer' } },
    { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Keyset pagination token (see X-Next-Cursor)' },
  ];
  const errors = { 400: { description: 'Bad request' }, 401: { description: 'Missing or invalid API key / token' }, 403: { description: 'Forbidden by RLS or grants' } };

  for (const [name, t] of schema.tables) {
    schemas[name] = {
      type: 'object',
      required: t.columns.filter((c) => !c.nullable && !c.has_default && !c.is_generated).map((c) => c.name),
      properties: Object.fromEntries(t.columns.map((c) => [c.name, jsonType(c)])),
      ...(t.comment ? { description: t.comment } : {}),
    };
    const ref = { $ref: `#/components/schemas/${name}` };
    const colFilters = t.columns.map((c) => ({ name: c.name, in: 'query', required: false, schema: { type: 'string' }, description: `Filter, e.g. ${c.name}=eq.value` }));
    paths[`${base}/${name}`] = {
      get: { tags: [name], summary: `Read ${name}`, parameters: [...filterParams, ...colFilters], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: ref } } } }, ...errors } },
      ...(t.kind === 'table' ? {
        post: { tags: [name], summary: `Insert into ${name}`, requestBody: { content: { 'application/json': { schema: { oneOf: [ref, { type: 'array', items: ref }] } } } }, responses: { 201: { description: 'Created' }, 409: { description: 'Conflict' }, ...errors } },
        patch: { tags: [name], summary: `Update ${name} (requires filters)`, parameters: colFilters, requestBody: { content: { 'application/json': { schema: ref } } }, responses: { 200: { description: 'Updated rows' }, ...errors } },
        delete: { tags: [name], summary: `Delete from ${name} (requires filters)`, parameters: colFilters, responses: { 204: { description: 'Deleted' }, ...errors } },
      } : {}),
    };
    if (t.pk.length === 1) {
      const idParam = [{ name: 'id', in: 'path', required: true, schema: jsonType(t.columnMap.get(t.pk[0]!)!) }];
      paths[`${base}/${name}/{id}`] = {
        get: { tags: [name], summary: `Get ${name} by ${t.pk[0]}`, parameters: idParam, responses: { 200: { description: 'OK', content: { 'application/json': { schema: ref } } }, 404: { description: 'Not found' } } },
        ...(t.kind === 'table' ? {
          patch: { tags: [name], summary: `Update ${name} by ${t.pk[0]}`, parameters: idParam, requestBody: { content: { 'application/json': { schema: ref } } }, responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } },
          delete: { tags: [name], summary: `Delete ${name} by ${t.pk[0]}`, parameters: idParam, responses: { 204: { description: 'Deleted' }, 404: { description: 'Not found' } } },
        } : {}),
      };
    }
  }
  for (const [name, f] of schema.functions) {
    paths[`${base}/rpc/${name}`] = {
      post: {
        tags: ['rpc'], summary: `Call ${name}(${f.args.map((a) => `${a.name} ${a.type}`).join(', ')}) → ${f.returns}`,
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(f.args.map((a) => [a.name, { description: a.type }])) } } } },
        responses: { 200: { description: 'Result' }, ...errors },
      },
    };
  }
  return reply.send({
    openapi: '3.1.0',
    info: { title: `OwnDatabase REST — ${project.slug}`, version: '1.0.0', description: `Auto-generated from schema ${project.db_schema}. Send your API key in the apikey header.` },
    servers: [{ url: `${config.PUBLIC_URL.replace(/\/$/, '')}/rest` }],
    security: [{ apikey: [] }],
    components: {
      securitySchemes: {
        apikey: { type: 'apiKey', in: 'header', name: 'apikey' },
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas,
    },
    paths,
  });
}
