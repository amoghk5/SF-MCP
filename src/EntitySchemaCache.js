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
 *  3. Full $metadata        GET /$metadata           (ETag-cached, ~12 MB)
 *  4. Sample record         GET /{entity}?$top=1     (infers types from values)
 *
 * Field object shape (mirrors integrtr's attribute set):
 *   name, type, key, required (sap:required), nullable (Nullable=false),
 *   label, filterable, sortable, creatable, updatable, upsertable, visible,
 *   picklist, displayFormat, maxLength, sensitive
 *
 * navFields shape:
 *   name, label, toRole, upsertable, filterable, sortable, creatable, updatable,
 *   visible, required, picklist, relationship, fromRole
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
// _store.schemas: { "alias:Entity": { fields, navFields, keyFields, fetchedAt } }
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
  set(alias, entity, fields, navFields = []) {
    const keyFields = fields.filter(f => f.key === true);
    _store.schemas[`${alias}:${entity}`] = { fields, navFields, keyFields, fetchedAt: Date.now() };
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
   * @returns {object|null}  { fields, navFields, keyFields, fetchedAt } or null on failure
   */
  async fetchAndCache(alias, entity, session, { forceRefresh = false } = {}) {
    if (!forceRefresh) {
      const cached = this.get(alias, entity);
      if (cached) return cached;
    }

    let parsed = null;

    // Strategy 1: per-entity $metadata (small payload, ~2–5 KB)
    try {
      const res = await session.request('GET', `/${entity}/$metadata`, undefined, { Accept: 'application/xml' });
      if (res.ok) {
        const xml = await res.text();
        parsed = _parseEntityFromXml(xml, entity);
      }
    } catch { /* fall through */ }

    // Strategy 2: full $metadata with ETag caching (~12 MB, 304 if unchanged)
    if (!parsed) {
      try {
        const xml = await _fetchFullMetadata(alias, session);
        if (xml) parsed = _parseEntityFromXml(xml, entity);
      } catch { /* fall through */ }
    }

    // Strategy 3: infer schema from a sample record (no reliable key detection)
    if (!parsed) {
      try {
        const res = await session.request('GET', `/${entity}?$top=1&$format=json`);
        if (res.ok) {
          const data = await res.json();
          const sample = data.d?.results?.[0] ?? data.d;
          if (sample && typeof sample === 'object') {
            const fields = _inferFromSample(sample);
            if (fields.length > 0) parsed = { fields, navFields: [] };
          }
        }
      } catch { /* give up */ }
    }

    if (parsed && parsed.fields.length > 0) {
      this.set(alias, entity, parsed.fields, parsed.navFields);
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

/**
 * Parses a single EntityType from $metadata XML.
 *
 * Captures all attributes that integrtr tracks:
 *   Property:           name, type, key, required (sap:required), nullable,
 *                       label, filterable, sortable, creatable, updatable,
 *                       upsertable, visible, picklist, displayFormat, maxLength, sensitive
 *   NavigationProperty: name, label, toRole, relationship, fromRole,
 *                       required, creatable, updatable, upsertable,
 *                       filterable, sortable, visible, picklist
 */
function _parseEntityFromXml(xml, entityName) {
  const entityTypeRe = new RegExp(`<EntityType[^>]+Name="${entityName}"[\\s\\S]*?</EntityType>`, 'i');
  const entityMatch = xml.match(entityTypeRe);
  if (!entityMatch) return null;

  const block = entityMatch[0];

  // ── Key field names ────────────────────────────────────────────────────────
  const keyProps = new Set();
  const keyBlock = block.match(/<Key>([\s\S]*?)<\/Key>/);
  if (keyBlock) {
    for (const m of keyBlock[1].matchAll(/PropertyRef[^>]+Name="([^"]+)"/g)) {
      keyProps.add(m[1]);
    }
  }

  // ── Properties ─────────────────────────────────────────────────────────────
  const fields = [];
  const propRe = /<Property\s([^>]+)(?:\/>|>[^<]*<\/Property>)/g;
  let m;
  while ((m = propRe.exec(block)) !== null) {
    const a = m[1];
    const attr = (name) => a.match(new RegExp(name.replace(':', '\\:') + '="([^"]+)"'))?.[1];

    const name = attr('Name');
    if (!name) continue;

    const field = {
      name,
      type:     attr('Type')?.replace('Edm.', '') ?? 'Unknown',
      key:      keyProps.has(name),
      // sap:required = SF business rule; Nullable = OData schema constraint (different!)
      required: attr('sap:required') === 'true',
      nullable: attr('Nullable') !== 'false',  // false = non-nullable in OData schema
    };

    // Conditionally add attributes only when they carry non-default values
    // (keeps the object lean; omitted = "default / not specified")
    const label    = attr('sap:label');
    if (label) field.label = label;

    const maxLen   = attr('MaxLength');
    if (maxLen) field.maxLength = parseInt(maxLen, 10);

    if (attr('sap:filterable') === 'false') field.filterable = false;
    if (attr('sap:sortable')   === 'false') field.sortable   = false;
    if (attr('sap:creatable')  === 'false') field.creatable  = false;
    if (attr('sap:updatable')  === 'false') field.updatable  = false;
    if (attr('sap:upsertable') === 'false') field.upsertable = false;
    if (attr('sap:visible')    === 'false') field.visible    = false;

    const picklist     = attr('sap:picklist');
    if (picklist) field.picklist = picklist;

    const displayFormat = attr('sap:display-format');
    if (displayFormat) field.displayFormat = displayFormat;

    if (attr('sap:sensitive-personal-data') === 'true') field.sensitive = true;

    fields.push(field);
  }

  // ── NavigationProperties ───────────────────────────────────────────────────
  const navFields = [];
  const navRe = /<NavigationProperty\s([^>]+?)(?:\/>|>[\s\S]*?<\/NavigationProperty>)/g;
  let n;
  while ((n = navRe.exec(block)) !== null) {
    const a = n[1];
    const attr = (name) => a.match(new RegExp(name.replace(':', '\\:') + '="([^"]+)"'))?.[1];

    const name = attr('Name');
    if (!name) continue;

    const nav = {
      name,
      relationship: attr('Relationship'),
      fromRole:     attr('FromRole'),
      toRole:       attr('ToRole'),
    };

    const label = attr('sap:label');
    if (label) nav.label = label;

    // Only include capability flags when they're false (non-default)
    if (attr('sap:upsertable') === 'false') nav.upsertable = false;
    if (attr('sap:creatable')  === 'false') nav.creatable  = false;
    if (attr('sap:updatable')  === 'false') nav.updatable  = false;
    if (attr('sap:filterable') === 'false') nav.filterable = false;
    if (attr('sap:sortable')   === 'false') nav.sortable   = false;
    if (attr('sap:visible')    === 'false') nav.visible    = false;
    if (attr('sap:required')   === 'true')  nav.required   = true;

    const picklist = attr('sap:picklist');
    if (picklist) nav.picklist = picklist;

    navFields.push(nav);
  }

  return fields.length > 0 ? { fields, navFields } : null;
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
    fields.push({ name: key, type, key: false, required: false, nullable: true });
  }
  return fields;
}
