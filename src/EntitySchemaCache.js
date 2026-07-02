/**
 * EntitySchemaCache — metadata cache for SF OData entities.
 *
 * Storage: SQLite via MetadataDB (one DB at ~/.sf-mcp/metadata.db).
 * Full $metadata XML stored as a flat file per alias for ETag resumption.
 *
 * Fetch strategy per entity (in order):
 *  1. In-memory cache (TTL check)
 *  2. SQLite (disk, same TTL)
 *  3. Per-entity  GET /{entity}/$metadata  — fields only (no NavigationProperty)
 *  4. Full        GET /$metadata           — ETag-cached, ~13 MB, has nav + associations
 *  5. Sample      GET /{entity}?$top=1     — type inference fallback
 *
 * navField shape:
 *   name, label, relationship, fromRole, toRole,
 *   targetEntity, targetEntityKeys, multiplicity, hasAssociation,
 *   upsertable, filterable, sortable, creatable, updatable, visible, required, picklist
 *
 * field shape (adds vs. before):
 *   isExternalCodeTranslation — true=old picklist style (write via field value),
 *                               false=new style (write via nav property)
 *   relatedFoundationObject   — target FO entity name if this field links to one
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import * as DB from './MetadataDB.js';

const XML_DIR = join(homedir(), '.sf-mcp', 'schemas');
const TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours

// ── In-memory layer (write-through cache over SQLite) ─────────────────────────
// "alias:entity" → { fields, navFields, keyFields, fetchedAt, entityMeta }
const _mem = {};

// ── Per-alias derived maps (built once from full XML, cleared on ETag refresh) ─
// alias → { assocSetMap, assocMap, entityKeyMap, foundationObjectSet, entityMetaMap }
const _maps = {};

// ── XML file helpers ──────────────────────────────────────────────────────────

function _xmlPath(alias) {
  return join(XML_DIR, alias, '_metadata.xml');
}

function _saveXml(alias, xml) {
  try {
    mkdirSync(join(XML_DIR, alias), { recursive: true });
    writeFileSync(_xmlPath(alias), xml, 'utf8');
  } catch { /* best-effort */ }
}

function _loadXml(alias) {
  try { return readFileSync(_xmlPath(alias), 'utf8'); } catch { return null; }
}

// ── Public cache API ──────────────────────────────────────────────────────────

export const EntitySchemaCache = {

  /** Return cached schema (memory → SQLite). Returns null when missing or stale. */
  get(alias, entity) {
    const key = `${alias}:${entity}`;

    // 1. Memory
    const mem = _mem[key];
    if (mem && Date.now() - mem.fetchedAt <= TTL_MS) return mem;

    // 2. SQLite
    const row = DB.getEntity(alias, entity);
    if (row && Date.now() - row.fetchedAt <= TTL_MS) {
      _mem[key] = row;
      return row;
    }
    return null;
  },

  /** Persist a parsed schema (memory + SQLite). */
  set(alias, entity, fields, navFields = [], entityMeta = {}) {
    DB.setEntity(alias, entity, {
      entityName: entityMeta.entityName ?? entity,
      ...entityMeta,
    }, fields, navFields);

    const keyFields = fields.filter(f => f.key);
    const schema = { fields, navFields, keyFields, fetchedAt: Date.now(), entityMeta };
    _mem[`${alias}:${entity}`] = schema;
  },

  /** Remove one entity. */
  invalidate(alias, entity) {
    delete _mem[`${alias}:${entity}`];
    DB.deleteEntity(alias, entity);
  },

  /** Remove everything for a connection. */
  invalidateAll(alias) {
    for (const key of Object.keys(_mem)) {
      if (key.startsWith(`${alias}:`)) delete _mem[key];
    }
    delete _maps[alias];
    DB.deleteAlias(alias);
  },

  /**
   * Main entry point: return schema from cache or fetch + parse from SF.
   *
   * Key-predicate strings (e.g. "EmpJob(userId='x')") are rejected —
   * those are single-record lookups, not schema requests.
   */
  async fetchAndCache(alias, entity, session, { forceRefresh = false } = {}) {
    if (entity.includes('(')) return null; // key-predicate pollution guard

    if (!forceRefresh) {
      const cached = this.get(alias, entity);
      if (cached) return cached;
    }

    let parsed = null;
    let entityMeta = {};

    // Strategy 1: per-entity $metadata (fields only — NavigationProperty absent)
    try {
      const res = await session.request('GET', `/${entity}/$metadata`, undefined, { Accept: 'application/xml' });
      if (res.ok) {
        const xml = await res.text();
        parsed = _parseEntityFromXml(xml, entity);
      }
    } catch { /* fall through */ }

    // Strategy 2: full $metadata (ETag-cached) — always run when nav fields are absent,
    // since the per-entity endpoint omits NavigationProperty elements.
    if (!parsed || parsed.navFields.length === 0) {
      try {
        const xml = await _fetchFullMetadata(alias, session);
        if (xml) {
          const maps = _getMaps(alias);
          const fullParsed = _parseEntityFromXml(xml, entity, maps);
          if (fullParsed) {
            parsed = fullParsed;
            entityMeta = maps?.entityMetaMap?.[entity] ?? {};
          }
        }
      } catch { /* fall through */ }
    }

    // Strategy 3: infer from sample record
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
      this.set(alias, entity, parsed.fields, parsed.navFields, entityMeta);
      return this.get(alias, entity);
    }

    return null;
  },
};

// ── Full $metadata fetcher (ETag-based) ───────────────────────────────────────

async function _fetchFullMetadata(alias, session) {
  // Bootstrap ETag + XML from disk on cold start
  let etagEntry = DB.getEtag(alias);
  let cachedXml = null;
  if (etagEntry) {
    cachedXml = _loadXml(alias);
    if (!cachedXml) etagEntry = null; // XML file missing — re-fetch unconditionally
  }

  const headers = { Accept: 'application/xml' };
  if (etagEntry?.etag) headers['If-None-Match'] = etagEntry.etag;

  const res = await session.request('GET', '/$metadata', undefined, headers);

  if (res.status === 304 && cachedXml) return cachedXml;
  if (!res.ok) return null;

  const xml = await res.text();
  const etag = res.headers.get('etag');

  if (etag) {
    _saveXml(alias, xml);
    DB.setEtag(alias, etag, _xmlPath(alias));
    delete _maps[alias]; // invalidate derived maps — XML may have changed
  }
  return xml;
}

// ── Derived-map builders ──────────────────────────────────────────────────────

function _getMaps(alias) {
  if (_maps[alias]) return _maps[alias];
  const xml = _loadXml(alias);
  if (!xml) return null;
  _maps[alias] = {
    assocSetMap:      _buildAssocSetMap(xml),
    assocMap:         _buildAssocMap(xml),
    entityKeyMap:     _buildEntityKeyMap(xml),
    foundationObjectSet: _buildFoundationObjectSet(xml),
    entityMetaMap:    _buildEntityMetaMap(xml),
  };
  return _maps[alias];
}

/**
 * AssociationSet map: relationship → { role → entitySet }
 * e.g. "SFOData.EmpJob_user" → { "EmpJob": "EmpJob", "User_ref": "User" }
 */
function _buildAssocSetMap(xml) {
  const map = {};
  const re = /<AssociationSet\s([^>]+)>([\s\S]*?)<\/AssociationSet>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const rel = m[1].match(/Association="([^"]+)"/)?.[1];
    if (!rel) continue;
    const ends = {};
    const endRe = /<End\s([^>]+)>/g;
    let e;
    while ((e = endRe.exec(m[2])) !== null) {
      const a = e[1];
      const entitySet = a.match(/EntitySet="([^"]+)"/)?.[1];
      const role      = a.match(/Role="([^"]+)"/)?.[1];
      if (entitySet && role) ends[role] = entitySet;
    }
    map[rel] = ends;
  }
  return map;
}

/**
 * Association map: assocName → { role → multiplicity }
 * e.g. "EmpJob_user" → { "EmpJob": "*", "User_ref": "0..1" }
 * Note: <Association\s does NOT match <AssociationSet\s (S ≠ whitespace).
 */
function _buildAssocMap(xml) {
  const map = {};
  const re = /<Association\s([^>]+)>([\s\S]*?)<\/Association>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const name = m[1].match(/Name="([^"]+)"/)?.[1];
    if (!name) continue;
    const mults = {};
    const endRe = /<End\s([^>]+)>/g;
    let e;
    while ((e = endRe.exec(m[2])) !== null) {
      const a = e[1];
      const mult = a.match(/Multiplicity="([^"]+)"/)?.[1];
      const role = a.match(/Role="([^"]+)"/)?.[1];
      if (mult && role) mults[role] = mult;
    }
    map[name] = mults;
  }
  return map;
}

/**
 * Entity key map: entityName → [keyFieldNames]
 * e.g. "EmpJob" → ["seqNumber", "startDate", "userId"]
 */
function _buildEntityKeyMap(xml) {
  const map = {};
  const re = /<EntityType\s([^>]+)>([\s\S]*?)<\/EntityType>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const name = m[1].match(/Name="([^"]+)"/)?.[1];
    if (!name) continue;
    const keyBlock = m[2].match(/<Key>([\s\S]*?)<\/Key>/);
    if (!keyBlock) { map[name] = []; continue; }
    map[name] = [...keyBlock[1].matchAll(/PropertyRef[^>]+Name="([^"]+)"/g)].map(k => k[1]);
  }
  return map;
}

/**
 * Foundation Object set — entities tagged "EC - Foundation/Organization"
 * or "EC - Position Management" in the XML EntityContainer.
 */
function _buildFoundationObjectSet(xml) {
  const foSet = new Set();
  const containerRe = /<EntityContainer\s[^>]+>([\s\S]*?)<\/EntityContainer>/i;
  const container = xml.match(containerRe)?.[1];
  if (!container) return foSet;

  const entitySetRe = /<EntitySet\s([^>]+?)(?<!\/)>([\s\S]*?)<\/EntitySet>/g;
  let m;
  while ((m = entitySetRe.exec(container)) !== null) {
    const name = m[1].match(/Name="([^"]+)"/)?.[1];
    if (!name) continue;
    const tags = [...m[2].matchAll(/<sap:tag[^>]*>([^<]+)<\/sap:tag>/g)].map(t => t[1].trim());
    if (
      (tags[0] === 'Employee Central (EC)' && tags[1] === 'EC - Foundation/Organization') ||
      (tags[0] === 'Employee Central (EC)' && tags[1] === 'EC - Position Management')    ||
      (name === 'Bank' && tags[0] === 'Employee Central (EC)' && tags[1] === 'EC - Payment Information')
    ) {
      foSet.add(name);
    }
  }
  return foSet;
}

/**
 * Entity-level metadata from EntitySet blocks:
 * entityName, longName, description, creatable/updatable/upsertable/deletable, entityTags
 */
function _buildEntityMetaMap(xml) {
  const map = {};
  const containerRe = /<EntityContainer\s[^>]+>([\s\S]*?)<\/EntityContainer>/i;
  const container = xml.match(containerRe)?.[1];
  if (!container) return map;

  const entitySetRe = /<EntitySet\s([^>]+?)(?<!\/)>([\s\S]*?)<\/EntitySet>/g;
  let m;
  while ((m = entitySetRe.exec(container)) !== null) {
    const attrs = m[1];
    const body  = m[2];
    const ga = (n) => attrs.match(new RegExp(n.replace(':', '\\:') + '="([^"]+)"'))?.[1];
    const name = ga('Name');
    if (!name) continue;

    const label = ga('sap:label');
    const tags  = [...body.matchAll(/<sap:tag[^>]*>([^<]+)<\/sap:tag>/g)].map(t => t[1].trim());
    const desc  = body.match(/<LongDescription[^>]*>([\s\S]*?)<\/LongDescription>/)?.[1]?.trim() ?? '';

    map[name] = {
      entityName:  label?.length > 50 ? name : (label ?? name),
      longName:    label?.length > 50 ? label : undefined,
      description: desc || undefined,
      creatable:   ga('sap:creatable'),
      updatable:   ga('sap:updatable'),
      upsertable:  ga('sap:upsertable'),
      deletable:   ga('sap:deletable'),
      entityTags:  tags,
    };
  }
  return map;
}

// ── XML parser ────────────────────────────────────────────────────────────────

/**
 * Parse one EntityType from $metadata XML.
 *
 * Two-pass approach:
 *   Pass 1 — NavigationProperties → build navByLabel map for field linking
 *   Pass 2 — Properties → use navByLabel to compute isExternalCodeTranslation
 *             and relatedFoundationObject
 *
 * @param {string} xml        Full or per-entity $metadata XML
 * @param {string} entityName Entity set name to find
 * @param {object} [maps]     { assocSetMap, assocMap, entityKeyMap, foundationObjectSet }
 */
function _parseEntityFromXml(xml, entityName, maps = {}) {
  const { assocSetMap, assocMap, entityKeyMap, foundationObjectSet } = maps;

  const entityTypeRe = new RegExp(`<EntityType[^>]+Name="${entityName}"[\\s\\S]*?</EntityType>`, 'i');
  const entityMatch  = xml.match(entityTypeRe);
  if (!entityMatch) return null;
  const block = entityMatch[0];

  // Key fields
  const keyProps = new Set();
  const keyBlock = block.match(/<Key>([\s\S]*?)<\/Key>/);
  if (keyBlock) {
    for (const m of keyBlock[1].matchAll(/PropertyRef[^>]+Name="([^"]+)"/g)) {
      keyProps.add(m[1]);
    }
  }

  // ── Pass 1: NavigationProperties ──────────────────────────────────────────
  const navFields      = [];
  const navByLabel     = {};  // label → { nav, index } for picklist field linking
  const navByFieldName = {};  // fieldName → nav   (nav.name === fieldName + 'Nav')

  const navRe = /<NavigationProperty\s([^>]+?)(?:\/>|>[\s\S]*?<\/NavigationProperty>)/g;
  let n;
  while ((n = navRe.exec(block)) !== null) {
    const a    = n[1];
    const attr = (nm) => a.match(new RegExp(nm.replace(':', '\\:') + '="([^"]+)"'))?.[1];

    const name = attr('Name');
    if (!name) continue;

    const relationship = attr('Relationship');
    const fromRole     = attr('FromRole');
    const toRole       = attr('ToRole');

    const nav = { name, relationship, fromRole, toRole };

    // Resolve target entity + multiplicity + target keys from association maps
    if (assocSetMap && assocMap && relationship && toRole) {
      const setEnds   = assocSetMap[relationship];
      nav.targetEntity = setEnds?.[toRole] ?? null;

      const assocName  = relationship.replace(/^[^.]+\./, ''); // strip "SFOData."
      nav.multiplicity = assocMap[assocName]?.[toRole] ?? null;

      if (nav.targetEntity && entityKeyMap) {
        const keys = entityKeyMap[nav.targetEntity];
        if (keys?.length) nav.targetEntityKeys = keys;
      }
    }

    nav.hasAssociation = toRole?.startsWith('asso_') ?? false;

    const label = attr('sap:label');
    if (label) nav.label = label;

    if (attr('sap:upsertable') === 'false') nav.upsertable = false;
    if (attr('sap:creatable')  === 'false') nav.creatable  = false;
    if (attr('sap:updatable')  === 'false') nav.updatable  = false;
    if (attr('sap:filterable') === 'false') nav.filterable = false;
    if (attr('sap:sortable')   === 'false') nav.sortable   = false;
    if (attr('sap:visible')    === 'false') nav.visible    = false;
    if (attr('sap:required')   === 'true')  nav.required   = true;

    const picklist = attr('sap:picklist');
    if (picklist) nav.picklist = picklist;

    if (label) navByLabel[label] = { nav, index: navFields.length };
    // Convention: fieldName + 'Nav' → used for FO detection without picklist
    if (name.endsWith('Nav')) navByFieldName[name.slice(0, -3)] = nav;
    navFields.push(nav);
  }

  // ── Pass 2: Properties ─────────────────────────────────────────────────────
  const fields  = [];
  const propRe  = /<Property\s([^>]+)(?:\/>|>[^<]*<\/Property>)/g;
  let m;
  while ((m = propRe.exec(block)) !== null) {
    const a    = m[1];
    const attr = (nm) => a.match(new RegExp(nm.replace(':', '\\:') + '="([^"]+)"'))?.[1];

    const name = attr('Name');
    if (!name) continue;

    const field = {
      name,
      type:     attr('Type')?.replace('Edm.', '') ?? 'Unknown',
      key:      keyProps.has(name),
      required: attr('sap:required') === 'true',
      nullable: attr('Nullable') !== 'false',
    };

    const label = attr('sap:label');
    if (label) field.label = label;

    const maxLen = attr('MaxLength');
    if (maxLen) field.maxLength = parseInt(maxLen, 10);

    if (attr('sap:filterable') === 'false') field.filterable = false;
    if (attr('sap:sortable')   === 'false') field.sortable   = false;
    if (attr('sap:creatable')  === 'false') field.creatable  = false;
    if (attr('sap:updatable')  === 'false') field.updatable  = false;
    if (attr('sap:upsertable') === 'false') field.upsertable = false;
    if (attr('sap:visible')    === 'false') field.visible    = false;

    const picklist = attr('sap:picklist');
    if (picklist) field.picklist = picklist;

    const displayFormat = attr('sap:display-format');
    if (displayFormat) field.displayFormat = displayFormat;

    if (attr('sap:sensitive-personal-data') === 'true') field.sensitive = true;

    // Link field to its nav property via matching label + picklist
    if (picklist && label && navByLabel[label]) {
      const { nav, index: navIdx } = navByLabel[label];

      // Validate link: nav's fromRole should match entityName, nav's picklist should match field's
      if (nav.fromRole === entityName && nav.picklist === picklist) {
        // Old-style: ToRole is "picklistoption" → field value writes directly to SF
        // New-style: ToRole is something else  → must write via the nav property
        if (nav.toRole?.toLowerCase() === 'picklistoption') {
          field.isExternalCodeTranslation = true;
        } else {
          // If nav name follows the fieldCode+'Nav' convention → truly new-style
          const isConventionalName = nav.name === name + 'Nav';
          field.isExternalCodeTranslation = !isConventionalName;
        }
        // Mark the linked nav as read-only (upsert goes via field value)
        navFields[navIdx].upsertable = false;
      }

      // Foundation object detection: does this field's nav point to an FO?
      if (assocSetMap && foundationObjectSet && nav.relationship && nav.fromRole) {
        const setEnds = assocSetMap[nav.relationship];
        if (setEnds) {
          const targetEntitySet = Object.entries(setEnds)
            .find(([role]) => role !== nav.fromRole)?.[1];
          if (targetEntitySet && foundationObjectSet.has(targetEntitySet)) {
            field.relatedFoundationObject = targetEntitySet;
          }
        }
      }
    }

    // Foundation Object detection via name convention (independent of picklist)
    // e.g. field 'businessUnit' → nav 'businessUnitNav' → targetEntity 'FOBusinessUnit'
    if (!field.relatedFoundationObject && foundationObjectSet) {
      const linkedNav = navByFieldName[name];
      if (linkedNav?.targetEntity && foundationObjectSet.has(linkedNav.targetEntity)) {
        field.relatedFoundationObject = linkedNav.targetEntity;
      }
    }

    fields.push(field);
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
