import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { sfConnectSchema, sfConnectHandler } from './src/tools/sfConnect.js';
import { sfQuerySchema, sfQueryHandler } from './src/tools/sfQuery.js';
import { sfUpsertSchema, sfUpsertHandler } from './src/tools/sfUpsert.js';
import { sfMetadataSchema, sfMetadataHandler } from './src/tools/sfMetadata.js';
import { readResource } from './src/resources/sfResources.js';

const server = new McpServer({
  name: 'sf-mcp-server',
  version: '1.0.0',
});

// ─── Tools ───────────────────────────────────────────────────────────────────

server.registerTool('sf_connect', sfConnectSchema, async (args) => wrap(sfConnectHandler, args));
server.registerTool('sf_query',   sfQuerySchema,   async (args) => wrap(sfQueryHandler,   args));
server.registerTool('sf_upsert',  sfUpsertSchema,  async (args) => wrap(sfUpsertHandler,  args));
server.registerTool('sf_metadata',sfMetadataSchema,async (args) => wrap(sfMetadataHandler,args));

// ─── Resources ───────────────────────────────────────────────────────────────

server.registerResource(
  'sf-session-status',
  'sf://session/status',
  { description: 'Active SF connections and session state', mimeType: 'application/json' },
  async ({ uri }) => {
    const data = await readResource(uri);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
);

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

const metadataTemplate = new ResourceTemplate('sf://metadata/{entity}', { list: undefined });
server.registerResource(
  'sf-entity-metadata',
  metadataTemplate,
  { description: 'Field names, types, and required flags for any SF entity', mimeType: 'application/json' },
  async ({ uri }) => {
    const data = await readResource(uri);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
);

const picklistTemplate = new ResourceTemplate('sf://picklist/{id}', { list: undefined });
server.registerResource(
  'sf-picklist',
  picklistTemplate,
  { description: 'Valid option codes for a picklist ID', mimeType: 'application/json' },
  async ({ uri }) => {
    const data = await readResource(uri);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
);

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
