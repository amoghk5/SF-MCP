import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { sfConnectHandler } from './src/tools/sfConnect.js';
import { sfQueryHandler } from './src/tools/sfQuery.js';
import { sfUpsertHandler } from './src/tools/sfUpsert.js';
import { sfMetadataHandler } from './src/tools/sfMetadata.js';
import { readResource } from './src/resources/sfResources.js';

const server = new McpServer({
  name: 'sf-mcp-server',
  version: '1.0.0',
});

// ─── Tool Schemas (Zod) ───────────────────────────────────────────────────────

const connOpt = z.string().optional().describe('Connection alias. Omit to use default.');

server.registerTool('sf_connect', {
  description: 'Manage SuccessFactors connection registry. Actions: list (show all saved connections), add (register a new SF system by alias), remove (delete a connection), set_default (change the default), test (verify credentials).',
  inputSchema: {
    action: z.enum(['list', 'add', 'remove', 'set_default', 'test']).describe('Operation to perform'),
    alias: z.string().optional().describe('Short name for the connection (e.g. "1143", "t1", "prod")'),
    apiHost: z.string().optional().describe('OData API host (e.g. apisalesdemo2.successfactors.eu)'),
    uiHost: z.string().optional().describe('UI host for internal APIs (e.g. salesdemo.successfactors.eu)'),
    username: z.string().optional().describe('SF OData API username (usually user@COMPANYID)'),
    password: z.string().optional().describe('SF OData password'),
    uiUsername: z.string().optional().describe('SF UI login username (if different from OData username)'),
    uiPassword: z.string().optional().describe('SF UI login password (if different from OData password)'),
    companyId: z.string().optional().describe('SF company ID (e.g. SFCPART001143)'),
    conditionalAuthUrl: z.string().optional().describe('Optional: external IdP URL for SAML login'),
  },
}, async (args) => wrap(sfConnectHandler, args));

server.registerTool('sf_query', {
  description: 'Read any SAP SuccessFactors OData v2 entity. Use for HR data: employees, positions, org units, MDF objects, etc. Supports filtering, pagination, date-effective queries, and server-driven paging.',
  inputSchema: {
    entity: z.string().describe('Entity set name (e.g. "Position", "EmpJob", "User", "cust_stressTest4M")'),
    filter: z.string().optional().describe('OData $filter (e.g. "effectiveStatus eq \'A\'"). Operators: eq, ne, gt, ge, lt, le, and, or, in, like. Functions: startswith, endswith, substringof, tolower, toupper.'),
    select: z.string().optional().describe('Comma-separated fields to return'),
    expand: z.string().optional().describe('Navigation properties to expand'),
    top: z.number().optional().default(20).describe('Max records (default 20, SF max 1000)'),
    skip: z.number().optional().default(0).describe('Records to skip for pagination'),
    orderby: z.string().optional().describe('Sort expression (e.g. "startDate desc")'),
    inlinecount: z.boolean().optional().describe('Set true to get total record count in response (adds $inlinecount=allpages)'),
    fromDate: z.string().optional().describe('Start date for effective-dated entities (e.g. "2024-01-01")'),
    toDate: z.string().optional().describe('End date for effective-dated entities (e.g. "2024-12-31")'),
    effectiveAt: z.string().optional().describe('Point-in-time for effective-dated queries (e.g. "2024-06-15")'),
    asOfDate: z.string().optional().describe('As-of date for queries'),
    customPageSize: z.number().optional().describe('Override page size (must be < 1000)'),
    paging: z.enum(['cursor', 'snapshot']).optional().describe('Server-side pagination mode. cursor: full extracts, no $filter/$orderby. snapshot: supports $filter/$orderby, max 300k records.'),
    recordStatus: z.enum(['normal', 'pending', 'pendinghistory']).optional().describe('MDF only. normal (default): approved records. pending: awaiting workflow approval (admin only). pendinghistory: declined/cancelled records (admin only).'),
    filterParentDate: z.boolean().optional().describe('MDF composite child entities only. Set true to apply date params to child records when querying them directly.'),
    versionId: z.string().optional().describe('MDF only. Query a specific version of a pending record.'),
    rawParams: z.object({}).passthrough().optional().describe('Any additional query params as key-value pairs (pass-through to SF)'),
    connection: connOpt,
  },
}, async (args) => wrap(sfQueryHandler, args));

server.registerTool('sf_upsert', {
  description: 'Create or update records in any SAP SuccessFactors OData v2 entity. CSRF tokens handled automatically. Pass a single record or array for batch (max 1000). Use sf_metadata first if unsure about required fields.',
  inputSchema: {
    entity: z.string().describe('Entity set name'),
    payload: z.union([z.object({}).passthrough(), z.array(z.object({}).passthrough())]).describe('Single record or array of records to upsert'),
    purgeType: z.enum(['incremental', 'full', 'fullPurge', 'record']).optional().describe('Upsert mode: incremental (default), full/fullPurge (replace record), record (delete+insert)'),
    workflowConfirmed: z.boolean().optional().describe('Set true to trigger workflow on upsert for non-admin users. Required for workflow-enabled entities — without it, upsert fails with HTTP 500 for non-admin users.'),
    warningAcknowledged: z.boolean().optional().describe('Set true to bypass warning business rules on upsert for non-admin users. Required when a warning rule fires — without it, upsert fails.'),
    connection: connOpt,
  },
}, async (args) => wrap(sfUpsertHandler, args));

server.registerTool('sf_metadata', {
  description: 'Explore the SF data model. get_entity: field names/types for one entity. list_entities: all available entity sets. get_picklist: valid option codes for a picklist. Results are cached.',
  inputSchema: {
    action: z.enum(['get_entity', 'list_entities', 'get_picklist']).describe('What to retrieve'),
    entity: z.string().optional().describe('Entity set name — required for get_entity'),
    picklistId: z.string().optional().describe('Picklist ID — required for get_picklist (e.g. "status")'),
    forceRefresh: z.boolean().optional().describe('Bypass the 24h schema cache and re-fetch from SF. Use when a field was added or entity definition changed.'),
    connection: connOpt,
  },
}, async (args) => wrap(sfMetadataHandler, args));


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

// Resources with URI templates require ResourceTemplate from the SDK
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

