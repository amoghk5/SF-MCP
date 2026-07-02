import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { EntitySchemaCache } from '../EntitySchemaCache.js';

import { z } from 'zod';
import { connOpt, userIdOpt } from './shared.js';

export const sfUpsertSchema = {
  description: 'Create or update records in any SAP SuccessFactors OData v2 entity. CSRF tokens handled automatically. Pass a single record or array for batch (max 1000). Use sf_metadata first if unsure about required fields.',
  inputSchema: {
    entity: z.string().describe('Entity set name'),
    payload: z.union([z.object({}).passthrough(), z.array(z.object({}).passthrough())]).describe('Single record or array of records to upsert'),
    purgeType: z.enum(['incremental', 'full', 'fullPurge', 'record']).optional().describe('Upsert mode: incremental (default), full/fullPurge (replace record), record (delete+insert)'),
    workflowConfirmed: z.boolean().optional().describe('Set true to trigger workflow on upsert for non-admin users. Required for workflow-enabled entities — without it, upsert fails with HTTP 500 for non-admin users.'),
    warningAcknowledged: z.boolean().optional().describe('Set true to bypass warning business rules on upsert for non-admin users. Required when a warning rule fires — without it, upsert fails.'),
    connection: connOpt,
    userId: userIdOpt,
  },
};


export async function sfUpsertHandler({ entity, payload, purgeType, workflowConfirmed, warningAcknowledged, connection, userId }) {
  const { alias, conn, userId: resolvedUserId } = ConnectionRegistry.resolveUser(connection, userId);
  const session = sessionCache.odata(`${alias}::${resolvedUserId}`, { ...conn, userId: resolvedUserId });

  const records = Array.isArray(payload) ? payload : [payload];

  if (records.length > 1000) {
    return { error: `SF allows max 1000 records per upsert. Got ${records.length}. Split into batches.` };
  }

  // Fetch (or reuse cached) entity schema for dynamic key URI building.
  // Non-fatal: if metadata is unavailable we fall back to the hardcoded list below.
  const schema = await EntitySchemaCache.fetchAndCache(alias, entity, session).catch(() => null);

  // Auto-convert human-readable dates → SF /Date(ms)/ format
  const converted = records.map(convertDates);

  // SF OData v2 upsert requires __metadata with type + uri (entity key path) on each record.
  const withMeta = [];
  for (let i = 0; i < converted.length; i++) {
    const r = converted[i];
    if (r.__metadata?.uri && r.__metadata?.type) { withMeta.push(r); continue; }
    const uri = buildKeyUri(entity, r, schema);
    if (uri === entity) {
      const keyHint = schema?.keyFields?.map(f => f.name).join(', ') ?? 'externalCode, code, userId, personIdExternal, positionCode, jobCode, externalId, id';
      return { error: `Record at index ${i} has no recognizable key field. Provide __metadata.uri manually or include one of: ${keyHint}.` };
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
 *
 * When a schema is provided (from EntitySchemaCache), uses the entity's actual
 * key fields with type-aware formatting. Falls back to a hardcoded list for
 * connections or entities where metadata is unavailable.
 *
 * Type-to-URI-literal mapping:
 *   String, Guid       →  'value'
 *   Int64              →  valueL
 *   Int16, Int32       →  value
 *   Decimal, Single,
 *   Double             →  value (no suffix)
 *   DateTime           →  datetime'YYYY-MM-DDTHH:MM:SS'
 *   DateTimeOffset     →  datetimeoffset'...'
 *   Boolean            →  true | false
 */
function buildKeyUri(entity, record, schema) {
  // ── Schema-driven path ──────────────────────────────────────────────────────
  if (schema?.keyFields?.length > 0) {
    const parts = [];
    for (const kf of schema.keyFields) {
      if (record[kf.name] === undefined) continue;
      const literal = toODataLiteral(kf.name, kf.type, record[kf.name]);
      if (literal !== null) parts.push(`${kf.name}=${literal}`);
    }
    if (parts.length > 0) return `${entity}(${parts.join(',')})`;
    // All key fields missing from record — fall through to hardcoded
  }

  // ── Hardcoded fallback ──────────────────────────────────────────────────────
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

/** Format a field value as an OData v2 URI key literal based on its EDM type. */
function toODataLiteral(name, type, value) {
  switch (type) {
    case 'Int64':
      return `${value}L`;

    case 'Int16':
    case 'Int32':
    case 'Byte':
    case 'SByte':
      return String(value);

    case 'Decimal':
    case 'Single':
    case 'Double':
      return String(value);

    case 'Boolean':
      return value === true || value === 'true' ? 'true' : 'false';

    case 'DateTime': {
      const raw = String(value);
      const ms = raw.match(/\/Date\((\d+)\)\//);
      if (ms) return `datetime'${new Date(Number(ms[1])).toISOString().slice(0, 19)}'`;
      // Already ISO or datetime' format
      const clean = raw.replace(/^datetime'/, '').replace(/'$/, '');
      return `datetime'${clean.slice(0, 19)}'`;
    }

    case 'DateTimeOffset': {
      const raw = String(value);
      const ms = raw.match(/\/Date\((\d+)([+-]\d+)?\)\//);
      if (ms) return `datetimeoffset'${new Date(Number(ms[1])).toISOString()}'`;
      return `datetimeoffset'${raw}'`;
    }

    case 'String':
    case 'Guid':
    default: {
      const escaped = String(value).replace(/'/g, "''");
      return `'${escaped}'`;
    }
  }
}
