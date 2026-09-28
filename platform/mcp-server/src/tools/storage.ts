import { apiClient, storageClient } from '../client.js';
import { pid, type Tool } from './types.js';

export const storageTools: Tool[] = [
  {
    name: 'list_buckets', description: 'Storage buckets with object counts and size.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => storageClient(`/v1/${a.projectId}/bucket`),
  },
  {
    name: 'create_bucket', description: 'Create a storage bucket.',
    inputSchema: { type: 'object', properties: { ...pid, name: { type: 'string' }, public: { type: 'boolean' }, file_size_limit: { type: 'number' }, allowed_mime_types: { type: 'array', items: { type: 'string' } } }, required: ['projectId', 'name'] },
    handler: async (a) => { const { projectId, ...b } = a; return storageClient(`/v1/${projectId}/bucket`, { method: 'POST', body: JSON.stringify(b) }); },
  },
  {
    name: 'list_objects', description: 'Files and folders in a bucket (optionally under a prefix).',
    inputSchema: { type: 'object', properties: { ...pid, bucket: { type: 'string' }, prefix: { type: 'string' } }, required: ['projectId', 'bucket'] }, annotations: { readOnlyHint: true },
    handler: async (a) => storageClient(`/v1/${a.projectId}/object/list/${a.bucket}`, { method: 'POST', body: JSON.stringify({ prefix: a.prefix ?? '' }) }),
  },
];

export const functionTools: Tool[] = [
  {
    name: 'list_functions', description: 'Deployed serverless functions with 24h invocation / error counts.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/functions`)).data,
  },
  {
    name: 'deploy_function',
    description: 'Deploy (or update) a function. Code is an ES module: `export default async function (req) { return { status: 200, body: {...} } }`. req has method, path, query, headers, body, env.',
    inputSchema: { type: 'object', properties: { ...pid, slug: { type: 'string' }, code: { type: 'string' }, verify_jwt: { type: 'boolean', default: true }, timeout_ms: { type: 'number' } }, required: ['projectId', 'slug', 'code'] },
    handler: async (a) => { const { projectId, ...b } = a; return apiClient(`/api/projects/${projectId}/functions`, { method: 'POST', body: JSON.stringify(b) }); },
  },
  {
    name: 'get_function_logs', description: 'Recent invocations of a function with console output and errors.',
    inputSchema: { type: 'object', properties: { ...pid, slug: { type: 'string' } }, required: ['projectId', 'slug'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/projects/${a.projectId}/functions/${a.slug}/logs`)).data,
  },
  {
    name: 'create_backup', description: 'Queue a backup of the project database.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] },
    handler: async (a) => apiClient('/api/backups', { method: 'POST', body: JSON.stringify({ project_id: a.projectId }) }),
  },
  {
    name: 'list_backups', description: 'Backups of a project with status and verification result.',
    inputSchema: { type: 'object', properties: pid, required: ['projectId'] }, annotations: { readOnlyHint: true },
    handler: async (a) => (await apiClient(`/api/backups?project_id=${a.projectId}`)).data,
  },
];
