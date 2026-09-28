#!/usr/bin/env node
/**
 * OwnDatabase MCP server (stdio). Lets AI agents inspect and manage projects:
 * tables, SQL, RLS policies, auth users, API keys, secrets, storage, functions, backups, logs.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { projectTools } from './tools/projects.js';
import { dbTools } from './tools/database.js';
import { authTools } from './tools/auth.js';
import { keyTools } from './tools/keys.js';
import { secretTools } from './tools/secrets.js';
import { storageTools, functionTools } from './tools/storage.js';
import { resourceTemplates, listResources, handleResourceRead } from './resources.js';
import { registerPrompts } from './prompts.js';

const tools = [...projectTools, ...dbTools, ...authTools, ...keyTools, ...secretTools, ...storageTools, ...functionTools];
const byName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: 'owndatabase', version: '0.2.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

registerPrompts(server);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ handler: _h, ...t }) => t),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = byName.get(request.params.name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  const args = request.params.arguments ?? {};
  for (const req of tool.inputSchema.required ?? []) {
    if (args[req] === undefined || args[req] === '') return { content: [{ type: 'text', text: `Missing required argument: ${req}` }], isError: true };
  }
  try {
    const result = await tool.handler(args);
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await listResources().catch(() => []) }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => handleResourceRead(request.params.uri));

await server.connect(new StdioServerTransport());
console.error('OwnDatabase MCP server running on stdio');
