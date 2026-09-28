import { ListPromptsRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

export const mcpPrompts = [
  { name: "create_table", description: "Design a well-structured PostgreSQL table for an OwnDatabase project" },
  { name: "write_rls_policy", description: "Write Row Level Security policies using auth.uid()", arguments: [{ name: "table", description: "table name", required: false }] },
  { name: "debug_query", description: "Debug a failing SQL query", arguments: [{ name: "query", description: "the SQL", required: false }] },
  { name: "optimize_query", description: "Optimize a slow query with EXPLAIN ANALYZE", arguments: [{ name: "query", description: "the SQL", required: false }] },
];

export function registerPrompts(server: Server) {
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: mcpPrompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    
    switch (name) {
      case "create_table":
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text: "I need help creating a PostgreSQL table. What best practices should I follow regarding primary keys, timestamps, and indexes?" }
            }
          ]
        };
      case "write_rls_policy":
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text: `Help me write Row Level Security policies${request.params.arguments?.["table"] ? " for the table " + request.params.arguments["table"] : ""} so users can only read and write their own rows. In OwnDatabase the signed-in user id is available as auth.uid(), API roles are anon, authenticated and service_role (which bypasses RLS). Use the list_policies and create_policy tools.` }
            }
          ]
        };
      case "debug_query":
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text: `This SQL query fails${request.params.arguments?.["query"] ? ":\n\n" + request.params.arguments["query"] : ""}\n\nAnalyze syntax and semantic errors (use describe_table to check column names) and suggest a fix.` }
            }
          ]
        };
      case "optimize_query":
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text: `Optimize this query${request.params.arguments?.["query"] ? ":\n\n" + request.params.arguments["query"] : ""}\n\nRun explain_query, identify the bottleneck and propose indexes or rewrites. get_project_stats shows the slowest queries.` }
            }
          ]
        };
      default:
        throw new Error(`Prompt not found: ${name}`);
    }
  });
}
