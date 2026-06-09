import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { EntitySchemaCache } from '../EntitySchemaCache.js';

export const sfQueryTool = {
  name: 'sf_query',
  description: 'Read any SAP SuccessFactors OData v2 entity. Use for retrieving HR data like employees, positions, org units, custom MDF objects, etc. Supports filtering, field selection, navigation property expansion, and pagination.',
  inputSchema: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Entity set name (e.g. "Position", "EmpJob", "User", "cust_stressTest4M")' },
      filter: { type: 'string', description: 'OData $filter expression (e.g. "effectiveStatus eq \'A\' and jobCode eq \'ENG01\'")', },
      select: { type: 'string', description: 'Comma-separated field names to return (e.g. "positionCode,jobTitle,costCenter")', },
      expand: { type: 'string', description: 'Navigation properties to expand (e.g. "department,jobClassification")', },
      top: { type: 'number', description: 'Max records to return (default 20, max 1000 per call)', default: 20 },
      skip: { type: 'number', description: 'Records to skip for pagination', default: 0 },
      orderby: { type: 'string', description: 'Sort expression (e.g. "startDate desc")' },
      recordStatus: { type: 'string', enum: ['normal', 'pending', 'pendinghistory'], description: 'MDF only. "normal" (default): approved records. "pending": records awaiting workflow approval (requires admin). "pendinghistory": declined/cancelled records (requires admin).' },
      filterParentDate: { type: 'boolean', description: 'MDF composite child entities only. Set true to apply fromDate/toDate/asOfDate filtering to child records when querying them directly. Default false (date params silently ignored on child entities).' },
      versionId: { type: 'string', description: 'MDF only. Query a specific version of a pending record. Implicitly returns pending data. Omit to get the latest version.' },
      connection: { type: 'string', description: 'Connection alias to use. Omit to use the default.' },
    },
    required: ['entity'],
  },
};

export async function sfQueryHandler({ entity, filter, select, expand, top = 20, skip = 0, orderby, inlinecount, fromDate, toDate, effectiveAt, asOfDate, customPageSize, paging, recordStatus, filterParentDate, versionId, rawParams, connection }) {
  const { alias, conn } = ConnectionRegistry.resolve(connection);
  const session = sessionCache.odata(alias, conn);

  // Warm the schema cache in the background — does not block the query.
  // On a cache hit this is near-instant; on a miss it fetches metadata concurrently
  // so the schema is ready for any subsequent upsert against the same entity.
  EntitySchemaCache.fetchAndCache(alias, entity, session).catch(() => {});

  const safeTop = Math.min(Math.max(1, top ?? 20), 1000);
  const params = new URLSearchParams();
  params.set('$format', 'json');
  params.set('$top', String(safeTop));
  if (skip) params.set('$skip', String(skip));
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
