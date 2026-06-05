import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';

// ETag cache only: alias -> { etag, xml } for full $metadata (avoids re-downloading 5.9MB)
const etagCache = {};

export const sfMetadataTool = {
  name: 'sf_metadata',
  description: 'Explore the SAP SuccessFactors data model. Actions: get_entity (field names, types, and required flags for one entity), list_entities (all available entity sets), get_picklist (valid option codes for a picklist ID).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_entity', 'list_entities', 'get_picklist'],
        description: 'What to retrieve',
      },
      entity: { type: 'string', description: 'Entity set name — required for get_entity' },
      picklistId: { type: 'string', description: 'Picklist ID — required for get_picklist (e.g. "status", "ecJobCode")' },
      connection: { type: 'string', description: 'Connection alias. Omit for default.' },
    },
    required: ['action'],
  },
};

export async function sfMetadataHandler({ action, entity, picklistId, connection }) {
  const { alias, conn } = ConnectionRegistry.resolve(connection);
  const session = sessionCache.odata(alias, conn);

  switch (action) {
    case 'get_entity': {
      if (!entity) return { error: 'entity is required for get_entity' };
      // Primary: per-entity metadata (small payload) with fallback to full $metadata
      let xml;
      const perEntityRes = await session.request('GET', `/${entity}/$metadata`, undefined, { Accept: 'application/xml' });
      if (perEntityRes.ok) {
        xml = await perEntityRes.text();
      } else {
        // Fallback: full $metadata with ETag caching (avoids re-downloading 5.9MB)
        xml = await fetchFullMetadataWithETag(session, alias);
        if (!xml) return { error: `Metadata fetch failed` };
      }
      const fields = parseEntityFromMetadata(xml, entity);

      if (fields) {
        return { connection: alias, entity, source: 'metadata', fieldCount: fields.length, fields };
      }
      // Fallback: infer from a sample record
      const sampleRes = await session.request('GET', `/${entity}?$top=1&$format=json`);
      if (!sampleRes.ok) return { error: `Entity "${entity}" not found in metadata and sample fetch failed (${sampleRes.status})` };
      const data = await sampleRes.json();
      const sample = data.d?.results?.[0] ?? data.d;
      if (!sample) return { error: `Entity "${entity}" not found in metadata and has no records to infer schema from` };
      const inferred = inferFieldsFromRecord(sample);
      return { connection: alias, entity, source: 'inferred_from_sample', fieldCount: inferred.length, fields: inferred };
    }

    case 'list_entities': {
      const res = await session.request('GET', `/`);
      if (!res.ok) return { error: `Service document fetch failed: ${res.status}` };
      const data = await res.json();
      const entities_ = (data.EntitySets ?? data.d?.EntitySets ?? []).sort();
      return { connection: alias, entities: entities_ };
    }

    case 'get_picklist': {
      if (!picklistId) return { error: 'picklistId is required for get_picklist' };
      const res = await session.request('GET', `/Picklist('${picklistId}')/picklistOptions?$select=id,externalCode,mdfExternalCode,sortOrder,status&$format=json`);
      if (!res.ok) return { error: `Picklist "${picklistId}" not found (${res.status})` };
      const data = await res.json();
      const options = (data.d?.results ?? [])
        .filter(o => o.externalCode != null || o.mdfExternalCode != null)
        .map(o => ({
          externalCode: o.externalCode ?? o.mdfExternalCode,
          sortOrder: o.sortOrder,
          active: o.status === 'ACTIVE',
        })).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      return { connection: alias, picklistId, options };
    }

    default:
      return { error: `Unknown action "${action}"` };
  }
}

/**
 * Fetch full $metadata XML with ETag caching.
 * On 304 Not Modified, returns cached XML without re-downloading.
 */
async function fetchFullMetadataWithETag(session, alias) {
  const cached = etagCache[alias];
  const extraHeaders = { Accept: 'application/xml' };
  if (cached?.etag) extraHeaders['If-None-Match'] = cached.etag;

  const res = await session.request('GET', `/$metadata`, undefined, extraHeaders);
  if (res.status === 304 && cached?.xml) return cached.xml;
  if (!res.ok) return null;

  const xml = await res.text();
  const etag = res.headers.get('etag');
  if (etag) etagCache[alias] = { etag, xml };
  return xml;
}

/**
 * Infers a field list from a sample OData JSON record.
 * Navigation properties (deferred links) are marked as type 'NavigationProperty'.
 */
function inferFieldsFromRecord(record) {
  const fields = [];
  for (const [key, val] of Object.entries(record)) {
    if (key === '__metadata') continue;
    let type = 'Unknown';
    if (val && typeof val === 'object' && val.__deferred) {
      type = 'NavigationProperty';
    } else if (val === null || val === undefined) {
      type = 'Unknown';
    } else if (typeof val === 'string') {
      type = val.match(/^\/Date\(/) ? 'DateTime' : 'String';
    } else if (typeof val === 'number') {
      type = Number.isInteger(val) ? 'Int32' : 'Decimal';
    } else if (typeof val === 'boolean') {
      type = 'Boolean';
    }
    fields.push({ name: key, type, key: false, required: false });
  }
  return fields;
}

function parseEntityFromMetadata(xml, entityName) {
  // Extract EntityType with matching Name
  const entityTypeRegex = new RegExp(`<EntityType[^>]+Name="${entityName}"[\\s\\S]*?</EntityType>`, 'i');
  const entityMatch = xml.match(entityTypeRegex);
  if (!entityMatch) return null;

  const block = entityMatch[0];

  // Extract key properties
  const keyProps = [];
  const keyBlock = block.match(/<Key>([\s\S]*?)<\/Key>/);
  if (keyBlock) {
    const keyRefs = keyBlock[1].matchAll(/PropertyRef[^>]+Name="([^"]+)"/g);
    for (const m of keyRefs) keyProps.push(m[1]);
  }

  // Extract all properties with SAP annotations
  const fields = [];
  const propRegex = /<Property\s([^>]+)(?:\/>|>[^<]*<\/Property>)/g;
  let m;
  while ((m = propRegex.exec(block)) !== null) {
    const attrs = m[1];
    const name = attrs.match(/Name="([^"]+)"/)?.[1];
    const type = attrs.match(/Type="([^"]+)"/)?.[1];
    const nullable = attrs.match(/Nullable="([^"]+)"/)?.[1];
    if (name) {
      const field = {
        name,
        type: type?.replace('Edm.', '') ?? 'Unknown',
        key: keyProps.includes(name),
        required: nullable === 'false',
      };
      // SAP annotations — only include if present
      const label = attrs.match(/sap:label="([^"]+)"/)?.[1];
      const filterable = attrs.match(/sap:filterable="([^"]+)"/)?.[1];
      const sortable = attrs.match(/sap:sortable="([^"]+)"/)?.[1];
      const creatable = attrs.match(/sap:creatable="([^"]+)"/)?.[1];
      const updatable = attrs.match(/sap:updatable="([^"]+)"/)?.[1];
      if (label) field.label = label;
      if (filterable === 'false') field.filterable = false;
      if (sortable === 'false') field.sortable = false;
      if (creatable === 'false') field.creatable = false;
      if (updatable === 'false') field.updatable = false;
      fields.push(field);
    }
  }

  return fields;
}
