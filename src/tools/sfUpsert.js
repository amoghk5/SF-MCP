import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';

export const sfUpsertTool = {
  name: 'sf_upsert',
  description: 'Create or update records in any SAP SuccessFactors OData v2 entity. Handles CSRF tokens automatically. Pass a single record object or an array for batch upsert (max 1000). Use sf_metadata first if unsure about required fields.',
  inputSchema: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Entity set name (e.g. "Position", "cust_stressTest4M")' },
      payload: {
        description: 'A single record object or array of records to upsert',
        oneOf: [
          { type: 'object' },
          { type: 'array', items: { type: 'object' } },
        ],
      },
      purgeType: {
        type: 'string',
        enum: ['incremental', 'full', 'fullPurge', 'record'],
        description: 'Upsert mode: incremental (default, update only provided fields), full/fullPurge (replace entire record), record (delete+insert)',
      },
      workflowConfirmed: {
        type: 'boolean',
        description: 'Set true to trigger workflow on upsert for non-admin users. Required when the entity has workflow routing enabled — without it, upsert fails with HTTP 500 for non-admin users. Has no effect for admin users.',
      },
      warningAcknowledged: {
        type: 'boolean',
        description: 'Set true to bypass warning business rules on upsert for non-admin users. Required when a warning rule fires — without it, upsert fails. Has no effect for admin users.',
      },
      connection: { type: 'string', description: 'Connection alias to use. Omit for default.' },
    },
    required: ['entity', 'payload'],
  },
};

export async function sfUpsertHandler({ entity, payload, purgeType, workflowConfirmed, warningAcknowledged, connection }) {
  const { alias, conn } = ConnectionRegistry.resolve(connection);
  const session = sessionCache.odata(alias, conn);

  const records = Array.isArray(payload) ? payload : [payload];

  if (records.length > 1000) {
    return { error: `SF allows max 1000 records per upsert. Got ${records.length}. Split into batches.` };
  }

  // Auto-convert human-readable dates → SF /Date(ms)/ format
  const converted = records.map(convertDates);

  // SF OData v2 upsert requires __metadata with type + uri (entity key path) on each record.
  const withMeta = [];
  for (let i = 0; i < converted.length; i++) {
    const r = converted[i];
    if (r.__metadata?.uri && r.__metadata?.type) { withMeta.push(r); continue; }
    const uri = buildKeyUri(entity, r);
    if (uri === entity) {
      return { error: `Record at index ${i} has no recognizable key field. Provide __metadata.uri manually or ensure the record has one of: externalCode, code, userId, personIdExternal, positionCode, jobCode, externalId, id, effectiveStartDate, startDate, mdfSystemEffectiveStartDate.` };
    }
    withMeta.push({ __metadata: { uri, type: `SFOData.${entity}` }, ...r });
  }

  // Entity-specific endpoint is faster (less metadata resolution server-side)
  const qs = new URLSearchParams({ $format: 'json' });
  if (purgeType) qs.set('purgeType', purgeType);
  if (workflowConfirmed) qs.set('workflowConfirmed', 'true');
  if (warningAcknowledged) qs.set('warningAcknowledged', 'true');
  const path = `/${entity}/upsert?${qs}`;

  const res = await session.request('POST', path, withMeta);

  const status = res.status;
  if (status >= 400) {
    const errText = await res.text().catch(() => '');
    return { error: `SF returned ${status}: ${errText.slice(0, 500)}` };
  }

  let responseData;
  try {
    responseData = await res.json();
  } catch {
    responseData = null;
  }

  // Surface per-record editStatus from SF response
  const details = responseData?.d;
  const summary = Array.isArray(details)
    ? details.map(d => ({ key: d.key, editStatus: d.editStatus, httpCode: d.httpCode, message: d.message }))
    : null;

  return {
    connection: alias,
    entity,
    upserted: withMeta.length,
    status,
    ...(purgeType && { purgeType }),
    ...(summary && { details: summary }),
    response: responseData,
  };
}

/**
 * Auto-converts human-readable date strings to SF /Date(ms)/ format.
 * Handles: "2026-04-10", "2026-04-10T00:00:00Z", "2026-04-10T14:30:00.000+05:30"
 * Leaves values already in /Date(...)/ format untouched.
 */
function convertDates(record) {
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const result = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string' && ISO_DATE_RE.test(v)) {
      const ms = new Date(v).getTime();
      if (!isNaN(ms)) {
        result[k] = `/Date(${ms})/`;
        continue;
      }
    }
    result[k] = v;
  }
  return result;
}

/**
 * Builds an SF OData v2 key URI string for __metadata.uri.
 * Handles single-key and composite-key entities.
 * Date values (/Date(...)/) are converted to datetime'...' format expected in key URIs.
 */
function buildKeyUri(entity, record) {
  const SF_KEYS = ['externalCode', 'code', 'userId', 'personIdExternal', 'positionCode', 'jobCode', 'externalId', 'id'];
  const DATE_KEYS = ['effectiveStartDate', 'startDate', 'mdfSystemEffectiveStartDate'];

  const keyParts = [];

  for (const dk of DATE_KEYS) {
    if (record[dk] !== undefined) {
      const raw = record[dk];
      const ms = typeof raw === 'string' ? raw.match(/\/Date\((\d+)\)\//) : null;
      const dateStr = ms ? new Date(Number(ms[1])).toISOString().slice(0, 19) : raw;
      keyParts.push(`${dk}=datetime'${dateStr}'`);
      break;
    }
  }

  for (const sk of SF_KEYS) {
    if (record[sk] !== undefined) {
      const escaped = String(record[sk]).replace(/'/g, "''");
      keyParts.push(`${sk}='${escaped}'`);
      break;
    }
  }

  if (keyParts.length === 0) return entity;
  return `${entity}(${keyParts.join(',')})`;
}

