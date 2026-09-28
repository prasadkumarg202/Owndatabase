export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  handler: (args: any) => Promise<unknown>;
}

export const pid = { projectId: { type: 'string', description: 'Project UUID (see list_projects)' } };
