/**
 * MetadataDB — SQLite-backed persistent store for SF OData metadata.
 *
 * Single database at ~/.sf-mcp/metadata.db, scoped by connection alias.
 * Uses Node.js built-in node:sqlite (Node 22.5+) — no external dependencies.
 *
 * Tables:
 *   etag_cache      — full $metadata ETag + XML file path per alias
 *   entities        — one row per entity per alias (name, capabilities, tags, keys)
 *   fields          — one row per regular field per entity
 *   nav_fields      — one row per navigation property per entity
 *   picklist_defs   — one row per picklist definition per alias
 *   picklist_options — one row per picklist option per alias
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_DIR  = join(homedir(), '.sf-mcp');
const DB_PATH = join(DB_DIR, 'metadata.db');

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS etag_cache (
  alias       TEXT PRIMARY KEY,
  etag        TEXT NOT NULL,
  xml_path    TEXT NOT NULL,
  cached_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  alias                TEXT    NOT NULL,
  entity_code          TEXT    NOT NULL,
  entity_name          TEXT    NOT NULL,
  long_name            TEXT,
  description          TEXT,
  creatable            TEXT,
  updatable            TEXT,
  upsertable           TEXT,
  deletable            TEXT,
  is_foundation_entity INTEGER NOT NULL DEFAULT 0,
  is_custom            INTEGER NOT NULL DEFAULT 0,
  key_fields           TEXT    NOT NULL DEFAULT '[]',
  entity_tags          TEXT,
  fetched_at           INTEGER NOT NULL,
  PRIMARY KEY (alias, entity_code)
);

CREATE TABLE IF NOT EXISTS fields (
  alias                        TEXT    NOT NULL,
  entity_code                  TEXT    NOT NULL,
  name                         TEXT    NOT NULL,
  label                        TEXT,
  long_name                    TEXT,
  type                         TEXT    NOT NULL DEFAULT 'Unknown',
  is_key                       INTEGER NOT NULL DEFAULT 0,
  nullable                     INTEGER NOT NULL DEFAULT 1,
  max_length                   INTEGER,
  display_format               TEXT,
  required                     INTEGER,
  creatable                    INTEGER,
  updatable                    INTEGER,
  upsertable                   INTEGER,
  filterable                   INTEGER,
  sortable                     INTEGER,
  visible                      INTEGER,
  sensitive                    INTEGER NOT NULL DEFAULT 0,
  picklist_code                TEXT,
  is_external_code_translation INTEGER,
  related_foundation_object    TEXT,
  PRIMARY KEY (alias, entity_code, name),
  FOREIGN KEY (alias, entity_code) REFERENCES entities(alias, entity_code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nav_fields (
  alias               TEXT    NOT NULL,
  entity_code         TEXT    NOT NULL,
  name                TEXT    NOT NULL,
  label               TEXT,
  relationship        TEXT,
  from_role           TEXT,
  to_role             TEXT,
  target_entity       TEXT,
  target_entity_keys  TEXT,
  multiplicity        TEXT,
  has_association     INTEGER NOT NULL DEFAULT 0,
  required            INTEGER,
  creatable           INTEGER,
  updatable           INTEGER,
  upsertable          INTEGER,
  filterable          INTEGER,
  sortable            INTEGER,
  visible             INTEGER,
  picklist_code       TEXT,
  PRIMARY KEY (alias, entity_code, name),
  FOREIGN KEY (alias, entity_code) REFERENCES entities(alias, entity_code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS picklist_defs (
  alias                TEXT    NOT NULL,
  picklist_code        TEXT    NOT NULL,
  picklist_name        TEXT,
  parent_picklist_code TEXT,
  fetched_at           INTEGER NOT NULL,
  PRIMARY KEY (alias, picklist_code)
);

CREATE TABLE IF NOT EXISTS picklist_options (
  alias              TEXT    NOT NULL,
  picklist_code      TEXT    NOT NULL,
  external_code      TEXT    NOT NULL,
  label              TEXT,
  sort_order         INTEGER,
  is_active          INTEGER NOT NULL DEFAULT 1,
  parent_option_code TEXT,
  PRIMARY KEY (alias, picklist_code, external_code),
  FOREIGN KEY (alias, picklist_code) REFERENCES picklist_defs(alias, picklist_code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS function_imports (
  alias             TEXT    NOT NULL,
  function_name     TEXT    NOT NULL,
  return_type       TEXT,
  entity_set        TEXT,
  http_method       TEXT    NOT NULL DEFAULT 'GET',
  supports_payload  INTEGER NOT NULL DEFAULT 0,
  description       TEXT,
  tags              TEXT,
  fetched_at        INTEGER NOT NULL,
  PRIMARY KEY (alias, function_name)
);

CREATE TABLE IF NOT EXISTS function_import_params (
  alias         TEXT    NOT NULL,
  function_name TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  type          TEXT    NOT NULL DEFAULT 'String',
  PRIMARY KEY (alias, function_name, name),
  FOREIGN KEY (alias, function_name) REFERENCES function_imports(alias, function_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fields_entity     ON fields(alias, entity_code);
CREATE INDEX IF NOT EXISTS idx_fields_picklist   ON fields(alias, picklist_code) WHERE picklist_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nav_entity        ON nav_fields(alias, entity_code);
CREATE INDEX IF NOT EXISTS idx_nav_target        ON nav_fields(alias, target_entity) WHERE target_entity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_picklist_opts     ON picklist_options(alias, picklist_code);
CREATE INDEX IF NOT EXISTS idx_entities_fo       ON entities(alias, is_foundation_entity) WHERE is_foundation_entity = 1;
CREATE INDEX IF NOT EXISTS idx_fnimport_params   ON function_import_params(alias, function_name);
`;

// ── Singleton DB handle ───────────────────────────────────────────────────────

let _db = null;

function db() {
  if (_db) return _db;
  mkdirSync(DB_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(SCHEMA);
  return _db;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a field object to a DB row, mapping JS booleans to SQLite integers. */
function _boolCol(val) {
  if (val === true)  return 1;
  if (val === false) return 0;
  return null; // undefined/null → NULL (means "default / not specified")
}

/** Convert SQLite integer back to a JS boolean (null stays null). */
function _fromBool(val) {
  if (val === 1) return true;
  if (val === 0) return false;
  return undefined;
}

/** Reconstruct a lean field object from a DB row (omit undefined values). */
function _rowToField(row) {
  const f = {
    name:     row.name,
    type:     row.type,
    key:      row.is_key === 1,
    required: row.required === 1,
    nullable: row.nullable !== 0,
  };
  if (row.label)          f.label         = row.label;
  if (row.long_name)      f.longName      = row.long_name;
  if (row.max_length)     f.maxLength     = row.max_length;
  if (row.display_format) f.displayFormat = row.display_format;
  if (row.picklist_code)  f.picklist      = row.picklist_code;
  if (row.sensitive === 1) f.sensitive    = true;
  // capability flags — only include when explicitly false
  if (row.filterable === 0) f.filterable  = false;
  if (row.sortable   === 0) f.sortable    = false;
  if (row.creatable  === 0) f.creatable   = false;
  if (row.updatable  === 0) f.updatable   = false;
  if (row.upsertable === 0) f.upsertable  = false;
  if (row.visible    === 0) f.visible     = false;
  // new fields
  if (row.is_external_code_translation !== null && row.is_external_code_translation !== undefined)
    f.isExternalCodeTranslation = row.is_external_code_translation === 1;
  if (row.related_foundation_object)
    f.relatedFoundationObject = row.related_foundation_object;
  return f;
}

/** Reconstruct a lean nav field object from a DB row. */
function _rowToNavField(row) {
  const n = {
    name:         row.name,
    relationship: row.relationship,
    fromRole:     row.from_role,
    toRole:       row.to_role,
  };
  if (row.label)             n.label           = row.label;
  if (row.target_entity)     n.targetEntity    = row.target_entity;
  if (row.target_entity_keys) {
    try { n.targetEntityKeys = JSON.parse(row.target_entity_keys); } catch { n.targetEntityKeys = []; }
  }
  if (row.multiplicity)      n.multiplicity    = row.multiplicity;
  if (row.has_association)   n.hasAssociation  = true;
  if (row.picklist_code)     n.picklist        = row.picklist_code;
  // capability flags — only include when explicitly false
  if (row.required   === 1) n.required   = true;
  if (row.filterable === 0) n.filterable = false;
  if (row.sortable   === 0) n.sortable   = false;
  if (row.creatable  === 0) n.creatable  = false;
  if (row.updatable  === 0) n.updatable  = false;
  if (row.upsertable === 0) n.upsertable = false;
  if (row.visible    === 0) n.visible    = false;
  return n;
}

// ── Entity operations ─────────────────────────────────────────────────────────

const _stmts = {};
function stmt(sql) {
  if (!_stmts[sql]) _stmts[sql] = db().prepare(sql);
  return _stmts[sql];
}

/**
 * Retrieve a cached entity schema.
 * @returns {{ fields, navFields, keyFields, fetchedAt, entityMeta }|null}
 */
export function getEntity(alias, entityCode) {
  const entity = stmt(
    'SELECT * FROM entities WHERE alias = ? AND entity_code = ?'
  ).get(alias, entityCode);
  if (!entity) return null;

  const fieldRows = stmt(
    'SELECT * FROM fields WHERE alias = ? AND entity_code = ? ORDER BY rowid'
  ).all(alias, entityCode);

  const navRows = stmt(
    'SELECT * FROM nav_fields WHERE alias = ? AND entity_code = ? ORDER BY rowid'
  ).all(alias, entityCode);

  const fields    = fieldRows.map(_rowToField);
  const navFields = navRows.map(_rowToNavField);
  const keyFields = fields.filter(f => f.key);

  const entityMeta = {
    entityName:        entity.entity_name,
    longName:          entity.long_name ?? undefined,
    description:       entity.description ?? undefined,
    creatable:         entity.creatable ?? undefined,
    updatable:         entity.updatable ?? undefined,
    upsertable:        entity.upsertable ?? undefined,
    deletable:         entity.deletable ?? undefined,
    isFoundationEntity: entity.is_foundation_entity === 1,
    isCustom:          entity.is_custom === 1,
    entityTags:        entity.entity_tags ? JSON.parse(entity.entity_tags) : [],
  };

  return { fields, navFields, keyFields, fetchedAt: entity.fetched_at, entityMeta };
}

/**
 * Persist a parsed entity schema atomically.
 * Replaces any existing data for (alias, entityCode).
 *
 * @param {string} alias
 * @param {string} entityCode
 * @param {object} entityMeta   — entity-level attributes
 * @param {object[]} fields     — parsed field objects
 * @param {object[]} navFields  — parsed nav field objects
 */
export function setEntity(alias, entityCode, entityMeta, fields, navFields) {
  const now = Date.now();
  const d = db();

  d.exec('BEGIN');
  try {
    // Entity row
    stmt(`INSERT OR REPLACE INTO entities
      (alias, entity_code, entity_name, long_name, description,
       creatable, updatable, upsertable, deletable,
       is_foundation_entity, is_custom, key_fields, entity_tags, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      alias, entityCode,
      entityMeta.entityName ?? entityCode,
      entityMeta.longName ?? null,
      entityMeta.description ?? null,
      entityMeta.creatable ?? null,
      entityMeta.updatable ?? null,
      entityMeta.upsertable ?? null,
      entityMeta.deletable ?? null,
      entityMeta.isFoundationEntity ? 1 : 0,
      entityCode.startsWith('cust_') ? 1 : 0,
      JSON.stringify(fields.filter(f => f.key).map(f => f.name)),
      entityMeta.entityTags?.length ? JSON.stringify(entityMeta.entityTags) : null,
      now
    );

    // Clear existing fields + nav_fields (CASCADE handles this via FK, but explicit is clearer)
    stmt('DELETE FROM fields WHERE alias = ? AND entity_code = ?').run(alias, entityCode);
    stmt('DELETE FROM nav_fields WHERE alias = ? AND entity_code = ?').run(alias, entityCode);

    // Insert fields
    const insField = stmt(`INSERT INTO fields
      (alias, entity_code, name, label, long_name, type, is_key, nullable, max_length,
       display_format, required, creatable, updatable, upsertable, filterable, sortable,
       visible, sensitive, picklist_code, is_external_code_translation, related_foundation_object)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    for (const f of fields) {
      insField.run(
        alias, entityCode, f.name,
        f.label ?? null,
        f.longName ?? null,
        f.type ?? 'Unknown',
        f.key ? 1 : 0,
        f.nullable === false ? 0 : 1,
        f.maxLength ?? null,
        f.displayFormat ?? null,
        _boolCol(f.required),
        _boolCol(f.creatable),
        _boolCol(f.updatable),
        _boolCol(f.upsertable),
        _boolCol(f.filterable),
        _boolCol(f.sortable),
        _boolCol(f.visible),
        f.sensitive ? 1 : 0,
        f.picklist ?? null,
        f.isExternalCodeTranslation != null ? _boolCol(f.isExternalCodeTranslation) : null,
        f.relatedFoundationObject ?? null
      );
    }

    // Insert nav fields
    const insNav = stmt(`INSERT INTO nav_fields
      (alias, entity_code, name, label, relationship, from_role, to_role,
       target_entity, target_entity_keys, multiplicity, has_association,
       required, creatable, updatable, upsertable, filterable, sortable, visible, picklist_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    for (const n of navFields) {
      insNav.run(
        alias, entityCode, n.name,
        n.label ?? null,
        n.relationship ?? null,
        n.fromRole ?? null,
        n.toRole ?? null,
        n.targetEntity ?? null,
        n.targetEntityKeys?.length ? JSON.stringify(n.targetEntityKeys) : null,
        n.multiplicity ?? null,
        n.hasAssociation ? 1 : 0,
        _boolCol(n.required),
        _boolCol(n.creatable),
        _boolCol(n.updatable),
        _boolCol(n.upsertable),
        _boolCol(n.filterable),
        _boolCol(n.sortable),
        _boolCol(n.visible),
        n.picklist ?? null
      );
    }

    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** Remove one entity and its fields/nav_fields from the DB. */
export function deleteEntity(alias, entityCode) {
  db().exec('BEGIN');
  try {
    stmt('DELETE FROM fields WHERE alias = ? AND entity_code = ?').run(alias, entityCode);
    stmt('DELETE FROM nav_fields WHERE alias = ? AND entity_code = ?').run(alias, entityCode);
    stmt('DELETE FROM entities WHERE alias = ? AND entity_code = ?').run(alias, entityCode);
    db().exec('COMMIT');
  } catch (err) {
    db().exec('ROLLBACK');
    throw err;
  }
}

/** Remove all cached data for a connection alias. */
export function deleteAlias(alias) {
  db().exec('BEGIN');
  try {
    stmt('DELETE FROM fields WHERE alias = ?').run(alias);
    stmt('DELETE FROM nav_fields WHERE alias = ?').run(alias);
    stmt('DELETE FROM entities WHERE alias = ?').run(alias);
    stmt('DELETE FROM picklist_options WHERE alias = ?').run(alias);
    stmt('DELETE FROM picklist_defs WHERE alias = ?').run(alias);
    stmt('DELETE FROM function_import_params WHERE alias = ?').run(alias);
    stmt('DELETE FROM function_imports WHERE alias = ?').run(alias);
    stmt('DELETE FROM etag_cache WHERE alias = ?').run(alias);
    db().exec('COMMIT');
  } catch (err) {
    db().exec('ROLLBACK');
    throw err;
  }
}

/** List all entity_codes cached for an alias. */
export function listEntities(alias) {
  return stmt('SELECT entity_code, fetched_at FROM entities WHERE alias = ?')
    .all(alias)
    .map(r => ({ entityCode: r.entity_code, fetchedAt: r.fetched_at }));
}

// ── Function import operations ─────────────────────────────────────────────────

/**
 * Retrieve one cached function import, with its parameters.
 * @returns {{ name, returnType, entitySet, httpMethod, supportsPayload, description, tags, params, fetchedAt }|null}
 */
export function getFunctionImport(alias, functionName) {
  const row = stmt(
    'SELECT * FROM function_imports WHERE alias = ? AND function_name = ?'
  ).get(alias, functionName);
  if (!row) return null;

  const params = stmt(
    'SELECT name, type FROM function_import_params WHERE alias = ? AND function_name = ? ORDER BY rowid'
  ).all(alias, functionName);

  return {
    name: row.function_name,
    returnType: row.return_type ?? null,
    entitySet: row.entity_set ?? null,
    httpMethod: row.http_method,
    supportsPayload: row.supports_payload === 1,
    description: row.description ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    params,
    fetchedAt: row.fetched_at,
  };
}

/** Persist one function import + its parameters atomically. Replaces any existing row. */
export function setFunctionImport(alias, functionName, def) {
  const d = db();
  d.exec('BEGIN');
  try {
    stmt(`INSERT OR REPLACE INTO function_imports
      (alias, function_name, return_type, entity_set, http_method, supports_payload, description, tags, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      alias, functionName,
      def.returnType ?? null,
      def.entitySet ?? null,
      def.httpMethod ?? 'GET',
      def.supportsPayload ? 1 : 0,
      def.description ?? null,
      def.tags?.length ? JSON.stringify(def.tags) : null,
      Date.now()
    );

    stmt('DELETE FROM function_import_params WHERE alias = ? AND function_name = ?').run(alias, functionName);

    const insParam = stmt(
      'INSERT INTO function_import_params (alias, function_name, name, type) VALUES (?,?,?,?)'
    );
    for (const p of def.params ?? []) {
      insParam.run(alias, functionName, p.name, p.type ?? 'String');
    }

    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** Remove one function import and its parameters from the DB. */
export function deleteFunctionImport(alias, functionName) {
  db().exec('BEGIN');
  try {
    stmt('DELETE FROM function_import_params WHERE alias = ? AND function_name = ?').run(alias, functionName);
    stmt('DELETE FROM function_imports WHERE alias = ? AND function_name = ?').run(alias, functionName);
    db().exec('COMMIT');
  } catch (err) {
    db().exec('ROLLBACK');
    throw err;
  }
}

/** List all function imports cached for an alias (summary only — no params). */
export function listFunctionImports(alias) {
  return stmt(
    'SELECT function_name, return_type, http_method, fetched_at FROM function_imports WHERE alias = ?'
  ).all(alias).map(r => ({
    name: r.function_name,
    returnType: r.return_type ?? null,
    httpMethod: r.http_method,
    fetchedAt: r.fetched_at,
  }));
}

// ── ETag operations ───────────────────────────────────────────────────────────

export function getEtag(alias) {
  return stmt('SELECT etag, xml_path FROM etag_cache WHERE alias = ?').get(alias) ?? null;
}

export function setEtag(alias, etag, xmlPath) {
  stmt(`INSERT OR REPLACE INTO etag_cache (alias, etag, xml_path, cached_at) VALUES (?,?,?,?)`)
    .run(alias, etag, xmlPath, Date.now());
}

export function deleteEtag(alias) {
  stmt('DELETE FROM etag_cache WHERE alias = ?').run(alias);
}

// ── Picklist operations ───────────────────────────────────────────────────────

/**
 * Retrieve cached picklist options.
 * @returns {{ fetchedAt, options: {externalCode, label, sortOrder, active, parentOptionCode}[] }|null}
 */
export function getPicklist(alias, picklistCode) {
  const def = stmt(
    'SELECT * FROM picklist_defs WHERE alias = ? AND picklist_code = ?'
  ).get(alias, picklistCode);
  if (!def) return null;

  const options = stmt(
    'SELECT * FROM picklist_options WHERE alias = ? AND picklist_code = ? ORDER BY sort_order'
  ).all(alias, picklistCode).map(r => ({
    externalCode:     r.external_code,
    label:            r.label ?? undefined,
    sortOrder:        r.sort_order ?? undefined,
    active:           r.is_active === 1,
    parentOptionCode: r.parent_option_code ?? undefined,
  }));

  return { fetchedAt: def.fetched_at, picklistName: def.picklist_name, options };
}

/**
 * Persist a picklist definition + all its options atomically.
 *
 * @param {string}   alias
 * @param {string}   picklistCode
 * @param {string}   [picklistName]
 * @param {object[]} options         — { externalCode, label, sortOrder, active, parentOptionCode }
 * @param {string}   [parentPicklistCode]
 */
export function setPicklist(alias, picklistCode, picklistName, options, parentPicklistCode) {
  const d = db();
  d.exec('BEGIN');
  try {
    stmt(`INSERT OR REPLACE INTO picklist_defs
      (alias, picklist_code, picklist_name, parent_picklist_code, fetched_at)
      VALUES (?,?,?,?,?)`).run(alias, picklistCode, picklistName ?? null, parentPicklistCode ?? null, Date.now());

    stmt('DELETE FROM picklist_options WHERE alias = ? AND picklist_code = ?').run(alias, picklistCode);

    const insOpt = stmt(`INSERT INTO picklist_options
      (alias, picklist_code, external_code, label, sort_order, is_active, parent_option_code)
      VALUES (?,?,?,?,?,?,?)`);

    for (const o of options) {
      insOpt.run(
        alias, picklistCode,
        o.externalCode,
        o.label ?? null,
        o.sortOrder ?? null,
        o.active !== false ? 1 : 0,
        o.parentOptionCode ?? null
      );
    }

    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function deletePicklist(alias, picklistCode) {
  db().exec('BEGIN');
  try {
    stmt('DELETE FROM picklist_options WHERE alias = ? AND picklist_code = ?').run(alias, picklistCode);
    stmt('DELETE FROM picklist_defs WHERE alias = ? AND picklist_code = ?').run(alias, picklistCode);
    db().exec('COMMIT');
  } catch (err) {
    db().exec('ROLLBACK');
    throw err;
  }
}
