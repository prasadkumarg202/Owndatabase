import { apiClient } from '../client.js';
import { pid, type Tool } from './types.js';

export const keyTools: Tool[] = [
  {
    name: 'list_api_keys', description: 'API keys of a project (prefixes only; full keys are never retrievable).',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/keys?project_id=${a.projectId}`)).data,
  },
  {
    name: 'create_api_key', description: 'Create an API key. The full key is returned once — show it to the user.',
    inputSchema: { type: 'object', properties: { ...pid, name: { type: 'string' }, type: { type: 'string', enum: ['anon', 'service_role', 'admin'] } }, required: ['projectId', 'name', 'type'] },
    handler: async (a) => apiClient('/api/keys', { method: 'POST', body: JSON.stringify({ project_id: a.projectId, name: a.name, type: a.type }) }),
  },
  {
    name: 'revoke_api_key', description: 'Revoke an API key by id.',
    inputSchema: { type: 'object', properties: { keyId: { type: 'string' } }, required: ['keyId'] }, annotations: { destructiveHint: true },
    handler: async (a) => apiClient(`/api/keys/${a.keyId}`, { method: 'DELETE' }),
  },
];
