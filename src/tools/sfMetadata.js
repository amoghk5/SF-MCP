import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { EntitySchemaCache } from '../EntitySchemaCache.js';

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
      forceRefresh: {
        type: 'boolean',
        description: 'For get_entity: bypass the 24h schema cache and re-fetch from SF. Use when a new field was added or the entity definition changed.',
      },
      connection: { type: 'string', description: 'Connection alias. Omit for default.' },
    },
    required: ['action'],
  },
};

export async function sfMetadataHandler({ action, entity, picklistId, forceRefresh = false, connection }) {
  const { alias, conn } = ConnectionRegistry.resolve(connection);
  const session = sessionCache.odata(alias, conn);

  switch (action) {
    case 'get_entity': {
      if (!entity) return { error: 'entity is required for get_entity' };

      const schema = await EntitySchemaCache.fetchAndCache(alias, entity, session, { forceRefresh });
      if (!schema) return { error: `Metadata fetch failed for entity "${entity}"` };

      return {
        connection: alias,
        entity,
        cached: !forceRefresh,
        fieldCount: schema.fields.length,
        keyFields: schema.keyFields.map(f => f.name),
        fields: schema.fields,
      };
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
