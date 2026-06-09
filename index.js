import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { sfConnectSchema, sfConnectHandler } from './src/tools/sfConnect.js';
import { sfQuerySchema, sfQueryHandler } from './src/tools/sfQuery.js';
import { sfUpsertSchema, sfUpsertHandler } from './src/tools/sfUpsert.js';
import { sfMetadataSchema, sfMetadataHandler } from './src/tools/sfMetadata.js';

const server = new McpServer({
  name: 'sf-mcp-server',
  version: '1.0.0',
});

// ─── Tools ───────────────────────────────────────────────────────────────────

server.registerTool('sf_connect', sfConnectSchema, async (args) => wrap(sfConnectHandler, args));
server.registerTool('sf_query',   sfQuerySchema,   async (args) => wrap(sfQueryHandler,   args));
server.registerTool('sf_upsert',  sfUpsertSchema,  async (args) => wrap(sfUpsertHandler,  args));
server.registerTool('sf_metadata',sfMetadataSchema,async (args) => wrap(sfMetadataHandler,args));

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function wrap(handler, args) {
  try {
    const result = await handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const detail = err.cause
      ? `${err.message} (${err.cause.code ?? err.cause.message ?? String(err.cause)})`
      : err.message;
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: detail }) }],
      isError: true,
    };
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('SF MCP Server running on stdio');
