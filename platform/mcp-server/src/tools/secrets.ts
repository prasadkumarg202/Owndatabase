import { apiClient } from '../client.js';
import { pid, type Tool } from './types.js';

export const secretTools: Tool[] = [
  {
    name: 'list_secrets', description: 'Secret names (values are never returned).',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/secrets?project_id=${a.projectId}`)).data,
  },
  {
    name: 'set_secret', description: 'Create or rotate an encrypted secret (UPPER_SNAKE_CASE name). Available to functions as env.',
    inputSchema: { type: 'object', properties: { ...pid, name: { type: 'string' }, value: { type: 'string' } }, required: ['projectId', 'name', 'value'] },
    handler: async (a) => apiClient('/api/secrets', { method: 'POST', body: JSON.stringify({ project_id: a.projectId, name: a.name, value: a.value }) }),
  },
];
