import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { EntitySchemaCache } from '../EntitySchemaCache.js';

import { z } from 'zod';
import { connOpt } from './shared.js';

export const sfQuerySchema = {
  description: 'Read any SAP SuccessFactors OData v2 entity. Use for HR data: employees, positions, org units, MDF objects, etc. Supports filtering, pagination, date-effective queries, and server-driven paging.',
  inputSchema: {
    entity: z.string().describe('Entity set name (e.g. "Position", "EmpJob", "User", "cust_stressTest4M")'),
    filter: z.string().optional().describe('OData $filter expression (e.g. "effectiveStatus eq \'A\'" or "jobCode eq \'ENG01\'"). Operators: eq, ne, gt, ge, lt, le, and, or, in, like. Functions: startswith, endswith, substringof.'),
    select: z.string().optional().describe('Comma-separated fields to return'),
    expand: z.string().optional().describe('Navigation properties to expand'),
    top: z.number().optional().default(20).describe('Max records (default 20, SF max 1000). Ignored for paging=cursor — use customPageSize instead.'),
    skip: z.number().optional().default(0).describe('Records to skip for pagination. Ignored for paging=cursor/snapshot.'),
    orderby: z.string().optional().describe('Sort expression (e.g. "startDate desc")'),
    inlinecount: z.boolean().optional().describe('Set true to get total record count in response (adds $inlinecount=allpages)'),
    fromDate: z.string().optional().describe('Start date for effective-dated entities (e.g. "2024-01-01")'),
    toDate: z.string().optional().describe('End date for effective-dated entities (e.g. "2024-12-31")'),
    effectiveAt: z.string().optional().describe('Point-in-time for effective-dated queries'),
    asOfDate: z.string().optional().describe('As-of date for queries'),
    customPageSize: z.number().optional().describe('Override page size for server-driven paging (must be < 1000). Use with paging=cursor/snapshot instead of top.'),
    paging: z.enum(['cursor', 'snapshot']).optional().describe('Server-side pagination mode. cursor: full extracts, follow __next links, do not set top. snapshot: supports $filter/$orderby, max 300k records, do not set top/$skip.'),
    recordStatus: z.enum(['normal', 'pending', 'pendinghistory']).optional().describe('MDF only. normal: approved records. pending: awaiting workflow (admin only). pendinghistory: declined/cancelled (admin only).'),
    filterParentDate: z.boolean().optional().describe('MDF composite child entities only. Set true to apply date params to child records when querying them directly.'),
    versionId: z.string().optional().describe('MDF only. Query a specific version of a pending record.'),
    rawParams: z.object({}).passthrough().optional().describe('Any additional query params as key-value pairs (pass-through to SF)'),
    connection: connOpt,
  },
};


export async function sfQueryHandler({ entity, filter, select, expand, top = 20, skip = 0, orderby, inlinecount, fromDate, toDate, effectiveAt, asOfDate, customPageSize, paging, recordStatus, filterParentDate, versionId, rawParams, connection }) {
  const { alias, conn } = ConnectionRegistry.resolve(connection);
  const session = sessionCache.odata(alias, conn);

  // Warm the schema cache in the background — does not block the query.
  // On a cache hit this is near-instant; on a miss it fetches metadata concurrently
  // so the schema is ready for any subsequent upsert against the same entity.
  EntitySchemaCache.fetchAndCache(alias, entity, session).catch(() => {});

  // paging=snapshot rejects $top/$skip; paging=cursor needs no $top to return __next
  const isSnapshot = paging === 'snapshot';
  const isCursor = paging === 'cursor';
  const safeTop = Math.min(Math.max(1, top ?? 20), 1000);
  const params = new URLSearchParams();
  params.set('$format', 'json');
  if (!isSnapshot && !isCursor) params.set('$top', String(safeTop));
  if (!isSnapshot && !isCursor && skip) params.set('$skip', String(skip));
  if (filter) params.set('$filter', filter);
  if (select) params.set('$select', select);
  if (expand) params.set('$expand', expand);
  if (orderby) params.set('$orderby', orderby);
  if (inlinecount) params.set('$inlinecount', 'allpages');
  // SF-specific date params for effective-dated entities
  if (fromDate) params.set('fromDate', fromDate);
  if (toDate) params.set('toDate', toDate);
  if (effectiveAt) params.set('effectiveAt', effectiveAt);
  if (asOfDate) params.set('asOfDate', asOfDate);
  if (customPageSize) params.set('customPageSize', String(customPageSize));
  if (paging) params.set('paging', paging);
  if (recordStatus) params.set('recordStatus', recordStatus);
  if (filterParentDate) params.set('filterParentDate', 'true');
  if (versionId) params.set('versionId', versionId);
  // Pass-through for any other SF params not explicitly modeled
  if (rawParams) {
    for (const [k, v] of Object.entries(rawParams)) params.set(k, String(v));
  }

  const path = `/${entity}?${params}`;
  const res = await session.request('GET', path);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { error: `SF returned ${res.status}: ${errText.slice(0, 500)}` };
  }

  const data = await res.json();
  const results = data.d?.results ?? data.d ?? data;
  const count = Array.isArray(results) ? results.length : '?';

  const response = {
    connection: alias,
    entity,
    count,
    results,
  };

  // $inlinecount → total from __count
  if (data.d?.__count !== undefined) {
    response.totalCount = parseInt(data.d.__count, 10);
  }

  // Server-driven pagination → __next link
  if (data.d?.__next) {
    response.__next = data.d.__next;
  }

  return response;
}
