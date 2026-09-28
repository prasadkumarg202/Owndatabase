import { apiClient } from '../client.js';
import { pid, type Tool } from './types.js';

export const authTools: Tool[] = [
  {
    name: 'list_users', description: 'End users of a project (email, verification, MFA, last sign-in).',
    inputSchema: { type: 'object', properties: { ...pid, search: { type: 'string' }, limit: { type: 'number' } }, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/users?limit=${a.limit ?? 50}${a.search ? `&search=${encodeURIComponent(a.search)}` : ''}`)).data,
  },
  {
    name: 'get_auth_config', description: 'Project auth settings (signup, email confirmation, MFA, OAuth providers).',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => apiClient(`/api/projects/${a.projectId}/auth-config`),
  },
  {
    name: 'update_auth_config', description: 'Change project auth settings. Only the keys you pass are changed.',
    inputSchema: { type: 'object', properties: { ...pid, settings: { type: 'object' } }, required: ['projectId', 'settings'] },
    handler: async (a) => apiClient(`/api/projects/${a.projectId}/auth-config`, { method: 'PUT', body: JSON.stringify(a.settings) }),
  },
];
