import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { EntitySchemaCache } from '../EntitySchemaCache.js';
import * as DB from '../MetadataDB.js';

import { z } from 'zod';
import { connOpt, userIdOpt } from './shared.js';

const PICKLIST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const sfMetadataSchema = {
  description: 'Explore the SF data model. get_entity: field names/types for one entity. list_entities: all available entity sets. get_picklist: valid option codes for a picklist. Results are cached.',
  inputSchema: {
    action: z.enum(['get_entity', 'list_entities', 'get_picklist']).describe('What to retrieve'),
    entity: z.string().optional().describe('Entity set name — required for get_entity'),
    picklistId: z.string().optional().describe('Picklist ID — required for get_picklist (e.g. "status")'),
    forceRefresh: z.boolean().optional().describe('Bypass the 24h schema cache and re-fetch from SF. Use when a field was added or entity definition changed.'),
    connection: connOpt,
    userId: userIdOpt,
  },
};


export async function sfMetadataHandler({ action, entity, picklistId, forceRefresh = false, connection, userId }) {
  const { alias, conn, userId: resolvedUserId } = ConnectionRegistry.resolveUser(connection, userId);
  const session = sessionCache.odata(`${alias}::${resolvedUserId}`, { ...conn, userId: resolvedUserId });

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
        navFieldCount: schema.navFields.length,
        keyFields: schema.keyFields.map(f => f.name),
        fields: schema.fields,
        navFields: schema.navFields,
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

      // Cache check
      if (!forceRefresh) {
        const cached = DB.getPicklist(alias, picklistId);
        if (cached && Date.now() - cached.fetchedAt <= PICKLIST_TTL_MS) {
          return { connection: alias, picklistId, cached: true, options: cached.options };
        }
      }

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

      // Persist to SQLite
      try { DB.setPicklist(alias, picklistId, null, options); } catch { /* best-effort */ }

      return { connection: alias, picklistId, cached: false, options };
    }

    default:
      return { error: `Unknown action "${action}"` };
  }
}
