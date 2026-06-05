import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { sfMetadataHandler } from '../tools/sfMetadata.js';

/**
 * MCP Resource handlers for schema caching.
 *
 * sf://metadata/{entity}  — field schema for an entity
 * sf://picklist/{id}       — valid picklist option codes
 * sf://session/status      — active session info
 */

export function listResources() {
  return [
    {
      uri: 'sf://session/status',
      name: 'SF Session Status',
      description: 'Active connections and session state',
      mimeType: 'application/json',
    },
    {
      uri: 'sf://metadata/{entity}',
      name: 'SF Entity Metadata',
      description: 'Field names, types, and required flags for any SF entity. Replace {entity} with entity name.',
      mimeType: 'application/json',
    },
    {
      uri: 'sf://picklist/{id}',
      name: 'SF Picklist Options',
      description: 'Valid option codes for a picklist. Replace {id} with the picklist ID.',
      mimeType: 'application/json',
    },
  ];
}

export async function readResource(uri) {
  // sf://session/status
  if (uri === 'sf://session/status') {
    const { connections, default: def } = ConnectionRegistry.list();
    const sessions = sessionCache.status();
    return {
      connections,
      default: def,
      sessions,
    };
  }

  // sf://metadata/{entity}
  const metaMatch = uri.match(/^sf:\/\/metadata\/(.+)$/);
  if (metaMatch) {
    const entity = metaMatch[1];
    const result = await sfMetadataHandler({ action: 'get_entity', entity });
    return result;
  }

  // sf://picklist/{id}
  const plMatch = uri.match(/^sf:\/\/picklist\/(.+)$/);
  if (plMatch) {
    const picklistId = plMatch[1];
    const result = await sfMetadataHandler({ action: 'get_picklist', picklistId });
    return result;
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
