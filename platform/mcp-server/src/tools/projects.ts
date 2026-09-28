import { apiClient } from '../client.js';
import { pid, type Tool } from './types.js';

export const projectTools: Tool[] = [
  {
    name: 'list_projects', description: 'List every project the signed-in user can access (id, name, slug, status).',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    handler: async () => (await apiClient('/api/projects')).data,
  },
  {
    name: 'get_project', description: 'Project details: schema name, service URLs (REST/auth/storage/realtime), counts.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => apiClient(`/api/projects/${a.projectId}`),
  },
  {
    name: 'create_project', description: 'Create a project. Returns its API keys ONCE — show them to the user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, organization_id: { type: 'string' } }, required: ['name'] },
    handler: async (a) => apiClient('/api/projects', { method: 'POST', body: JSON.stringify(a) }),
  },
  {
    name: 'get_project_stats', description: 'Database size, connections, cache hit ratio, vacuum stats and slowest queries.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/stats`)).data,
  },
  {
    name: 'get_logs', description: 'Recent project logs (audit, auth, functions).',
    inputSchema: { type: 'object', properties: { ...pid, source: { type: 'string', enum: ['all', 'audit', 'auth', 'functions', 'platform'] }, limit: { type: 'number' } }, required: ['projectId'] },
    annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/logs?source=${a.source ?? 'all'}&limit=${a.limit ?? 50}`)).data,
  },
  {
    name: 'service_status', description: 'Health of every platform service.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    handler: async () => (await apiClient('/api/observability/services')).data,
  },
];
