import { apiClient } from '../client.js';
import { pid, type Tool } from './types.js';

export const dbTools: Tool[] = [
  {
    name: 'list_tables', description: 'Tables in the project schema with row counts, size, RLS and realtime status.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/tables`)).data,
  },
  {
    name: 'describe_table', description: 'Columns, types, keys, indexes, constraints, RLS policies and DDL of one table.',
    inputSchema: { type: 'object', properties: { ...pid, table: { type: 'string' } }, required: ['projectId', 'table'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/tables/${encodeURIComponent(a.table)}`)).data,
  },
  {
    name: 'run_sql',
    description: 'Execute SQL as the project owner role (confined to the project schema; unqualified names resolve there). Set read_only=true for queries that must not change data.',
    inputSchema: { type: 'object', properties: { ...pid, query: { type: 'string' }, read_only: { type: 'boolean', default: false } }, required: ['projectId', 'query'] },
    annotations: { destructiveHint: true },
    handler: async (a) => apiClient(`/api/projects/${a.projectId}/execute`, { method: 'POST', body: JSON.stringify({ query: a.query, read_only: !!a.read_only }) }),
  },
  {
    name: 'explain_query', description: 'EXPLAIN (ANALYZE) a single statement. Always rolled back, so it is safe for INSERT/UPDATE/DELETE too.',
    inputSchema: { type: 'object', properties: { ...pid, query: { type: 'string' }, analyze: { type: 'boolean', default: true } }, required: ['projectId', 'query'] },
    annotations: { readOnlyHint: true },
    handler: async (a) => {
      const r = await apiClient(`/api/projects/${a.projectId}/explain`, { method: 'POST', body: JSON.stringify({ query: a.query, analyze: a.analyze ?? true }) });
      return { plan: r.plan, planning_time_ms: r.planning_time_ms, execution_time_ms: r.execution_time_ms };
    },
  },
  {
    name: 'get_schema_ddl', description: 'CREATE TABLE / INDEX / POLICY statements for the whole project schema.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/schema-dump`)).ddl,
  },
  {
    name: 'list_policies', description: 'Row Level Security policies in the project.',
    inputSchema: { type: 'object', properties: { ...pid, table: { type: 'string' } }, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/policies${a.table ? `?table=${encodeURIComponent(a.table)}` : ''}`)).data,
  },
  {
    name: 'create_policy', description: 'Create an RLS policy (enables RLS on the table). Use auth.uid() for the signed-in user id.',
    inputSchema: {
      type: 'object', required: ['projectId', 'table', 'name'],
      properties: { ...pid, table: { type: 'string' }, name: { type: 'string' }, command: { type: 'string', enum: ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'] }, roles: { type: 'array', items: { type: 'string', enum: ['anon', 'authenticated', 'service_role', 'public'] } }, using: { type: 'string' }, with_check: { type: 'string' } },
    },
    handler: async (a) => { const { projectId, ...body } = a; return apiClient(`/api/projects/${projectId}/policies`, { method: 'POST', body: JSON.stringify(body) }); },
  },
  {
    name: 'enable_realtime', description: 'Enable or disable realtime change events for a table.',
    inputSchema: { type: 'object', properties: { ...pid, table: { type: 'string' }, enabled: { type: 'boolean', default: true } }, required: ['projectId', 'table'] },
    handler: async (a) => apiClient(`/api/projects/${a.projectId}/tables/${encodeURIComponent(a.table)}/realtime`, { method: 'POST', body: JSON.stringify({ enabled: a.enabled ?? true }) }),
  },
  {
    name: 'list_extensions', description: 'PostgreSQL extensions that can be enabled, and which are installed.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/extensions`)).data,
  },
];
