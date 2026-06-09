/**
 * EntitySchemaCache — shared, persisted metadata cache for SF OData entities.
 *
 * Responsibilities:
 *  - Cache parsed entity schemas (field list + key fields) keyed by alias:entity
 *  - 24-hour TTL; explicit forceRefresh to bypass
 *  - Persist to ~/.sf-mcp/schema-cache.json so cache survives process restarts
 *  - fetchAndCache() is the single entry point used by sfUpsert, sfQuery, sfMetadata
 *
 * Fetch strategy per entity (in order):
 *  1. In-memory / disk cache (if fresh)
 *  2. Per-entity metadata  GET /{entity}/$metadata  (small, fast)
 *  3. Full $metadata        GET /$metadata           (ETag-cached, 5.9 MB)
 *  4. Sample record         GET /{entity}?$top=1     (infers types from values)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_DIR  = join(homedir(), '.sf-mcp');
const CACHE_FILE = join(CACHE_DIR, 'schema-cache.json');
const TTL_MS     = 24 * 60 * 60 * 1000; // 24 hours

// ── Disk persistence ──────────────────────────────────────────────────────────

function _loadDisk() {
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch { /* corrupt file — start fresh */ }
  return { schemas: {}, etags: {} };
}

function _saveDisk(store) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch { /* best-effort */ }
}

// ── In-memory store (initialised from disk at module load) ────────────────────

let _store = _loadDisk();
// _store.schemas: { "alias:Entity": { fields, keyFields, fetchedAt } }
// _store.etags:   { "alias":        { etag, xml } }  — for full $metadata

// ── Public cache API ──────────────────────────────────────────────────────────

export const EntitySchemaCache = {

  /** Return cached schema if fresh, otherwise null. */
  get(alias, entity) {
    const entry = _store.schemas[`${alias}:${entity}`];
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > TTL_MS) return null;
    return entry;
  },

  /** Store a parsed field list for an entity. */
  set(alias, entity, fields) {
    const keyFields = fields.filter(f => f.key === true);
    _store.schemas[`${alias}:${entity}`] = { fields, keyFields, fetchedAt: Date.now() };
    _saveDisk(_store);
  },

  /** Remove one entity's cached schema. */
  invalidate(alias, entity) {
    delete _store.schemas[`${alias}:${entity}`];
    _saveDisk(_store);
  },

  /** Remove all cached schemas for a connection (e.g. after credentials change). */
  invalidateAll(alias) {
    const prefix = `${alias}:`;
    for (const key of Object.keys(_store.schemas)) {
      if (key.startsWith(prefix)) delete _store.schemas[key];
    }
    delete _store.etags[alias];
    _saveDisk(_store);
  },

  /**
   * Main entry point: return schema from cache or fetch from SF.
   *
   * @param {string}       alias          Connection alias
   * @param {string}       entity         OData entity set name
   * @param {ODataSession} session        Authenticated session
   * @param {object}       [opts]
   * @param {boolean}      [opts.forceRefresh=false]  Skip cache, re-fetch from SF
   * @returns {object|null}  { fields, keyFields, fetchedAt } or null on failure
   */
  async fetchAndCache(alias, entity, session, { forceRefresh = false } = {}) {
    if (!forceRefresh) {
      const cached = this.get(alias, entity);
      if (cached) return cached;
    }

    let fields = null;

    // Strategy 1: per-entity $metadata (small payload, ~2–5 KB)
    try {
      const res = await session.request('GET', `/${entity}/$metadata`, undefined, { Accept: 'application/xml' });
      if (res.ok) {
        const xml = await res.text();
        fields = _parseEntityFromXml(xml, entity);
      }
    } catch { /* fall through */ }

    // Strategy 2: full $metadata with ETag caching (~5.9 MB, 304 if unchanged)
    if (!fields) {
      try {
        const xml = await _fetchFullMetadata(alias, session);
        if (xml) fields = _parseEntityFromXml(xml, entity);
      } catch { /* fall through */ }
    }

    // Strategy 3: infer schema from a sample record (no reliable key detection)
    if (!fields) {
      try {
        const res = await session.request('GET', `/${entity}?$top=1&$format=json`);
        if (res.ok) {
          const data = await res.json();
          const sample = data.d?.results?.[0] ?? data.d;
          if (sample && typeof sample === 'object') fields = _inferFromSample(sample);
        }
      } catch { /* give up */ }
    }

    if (fields && fields.length > 0) {
      this.set(alias, entity, fields);
      return this.get(alias, entity);
    }

    return null;
  },
};

// ── Full $metadata fetcher (ETag-based) ───────────────────────────────────────

async function _fetchFullMetadata(alias, session) {
  const cached = _store.etags[alias];
  const extraHeaders = { Accept: 'application/xml' };
  if (cached?.etag) extraHeaders['If-None-Match'] = cached.etag;

  const res = await session.request('GET', '/$metadata', undefined, extraHeaders);
  if (res.status === 304 && cached?.xml) return cached.xml;
  if (!res.ok) return null;

  const xml = await res.text();
  const etag = res.headers.get('etag');
  if (etag) {
    _store.etags[alias] = { etag, xml };
    _saveDisk(_store);
  }
  return xml;
}

// ── XML parser ────────────────────────────────────────────────────────────────

function _parseEntityFromXml(xml, entityName) {
  const entityTypeRe = new RegExp(`<EntityType[^>]+Name="${entityName}"[\\s\\S]*?</EntityType>`, 'i');
  const entityMatch = xml.match(entityTypeRe);
  if (!entityMatch) return null;

  const block = entityMatch[0];

  // Declared key field names
  const keyProps = new Set();
  const keyBlock = block.match(/<Key>([\s\S]*?)<\/Key>/);
  if (keyBlock) {
    for (const m of keyBlock[1].matchAll(/PropertyRef[^>]+Name="([^"]+)"/g)) {
      keyProps.add(m[1]);
    }
  }

  const fields = [];
  const propRe = /<Property\s([^>]+)(?:\/>|>[^<]*<\/Property>)/g;
  let m;
  while ((m = propRe.exec(block)) !== null) {
    const attrs = m[1];
    const name  = attrs.match(/Name="([^"]+)"/)?.[1];
    const type  = attrs.match(/Type="([^"]+)"/)?.[1];
    const nullable = attrs.match(/Nullable="([^"]+)"/)?.[1];
    if (!name) continue;

    const field = {
      name,
      type:     type?.replace('Edm.', '') ?? 'Unknown',
      key:      keyProps.has(name),
      required: nullable === 'false',
    };

    const label      = attrs.match(/sap:label="([^"]+)"/)?.[1];
    const filterable = attrs.match(/sap:filterable="([^"]+)"/)?.[1];
    const sortable   = attrs.match(/sap:sortable="([^"]+)"/)?.[1];
    const creatable  = attrs.match(/sap:creatable="([^"]+)"/)?.[1];
    const updatable  = attrs.match(/sap:updatable="([^"]+)"/)?.[1];
    if (label)                  field.label      = label;
    if (filterable === 'false') field.filterable = false;
    if (sortable   === 'false') field.sortable   = false;
    if (creatable  === 'false') field.creatable  = false;
    if (updatable  === 'false') field.updatable  = false;

    fields.push(field);
  }

  return fields.length > 0 ? fields : null;
}

// ── Sample-record type inferrer (fallback only) ───────────────────────────────

function _inferFromSample(record) {
  const fields = [];
  for (const [key, val] of Object.entries(record)) {
    if (key === '__metadata') continue;
    let type = 'Unknown';
    if (val && typeof val === 'object' && val.__deferred) {
      type = 'NavigationProperty';
    } else if (typeof val === 'string') {
      type = val.match(/^\/Date\(/) ? 'DateTime' : 'String';
    } else if (typeof val === 'number') {
      type = Number.isInteger(val) ? 'Int32' : 'Decimal';
    } else if (typeof val === 'boolean') {
      type = 'Boolean';
    }
    fields.push({ name: key, type, key: false, required: false, label: key });
  }
  return fields;
}
