import { apiClient } from './client.js';

export const resourceTemplates = [
  { uriTemplate: 'project://{projectId}/schema', name: 'Project schema (DDL)', description: 'CREATE statements for every table, index and policy', mimeType: 'text/plain' },
  { uriTemplate: 'project://{projectId}/tables/{table}', name: 'Table DDL', description: 'CREATE statement for one table', mimeType: 'text/plain' },
  { uriTemplate: 'project://{projectId}/info', name: 'Project info', description: 'Project details and service URLs', mimeType: 'application/json' },
];

export async function listResources() {
  const projects = (await apiClient('/api/projects')).data as { id: string; name: string }[];
  return projects.flatMap((p) => [
    { uri: `project://${p.id}/schema`, name: `${p.name} — schema`, mimeType: 'text/plain' },
    { uri: `project://${p.id}/info`, name: `${p.name} — info`, mimeType: 'application/json' },
  ]);
}

export async function handleResourceRead(uri: string) {
  let m = uri.match(/^project:\/\/([^/]+)\/schema$/);
  if (m) return { contents: [{ uri, mimeType: 'text/plain', text: (await apiClient(`/api/projects/${m[1]}/schema-dump`)).ddl }] };
  m = uri.match(/^project:\/\/([^/]+)\/tables\/([^/]+)$/);
  if (m) return { contents: [{ uri, mimeType: 'text/plain', text: (await apiClient(`/api/projects/${m[1]}/schema-dump?table=${encodeURIComponent(m[2]!)}`)).ddl }] };
  m = uri.match(/^project:\/\/([^/]+)\/info$/);
  if (m) return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await apiClient(`/api/projects/${m[1]}`), null, 2) }] };
  throw new Error(`Resource not found: ${uri}`);
}
