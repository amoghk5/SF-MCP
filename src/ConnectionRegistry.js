import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.sf-mcp');
const CONFIG_FILE = join(CONFIG_DIR, 'connections.json');

/** Migrates a legacy single-userId conn shape to the userIds array shape, in place. */
function migrateConn(conn) {
  if (conn.userIds) return conn;
  if (conn.userId) {
    conn.userIds = [conn.userId];
    delete conn.userId;
  }
  return conn;
}

function load() {
  if (!existsSync(CONFIG_FILE)) return { default: null, connections: {} };
  let data;
  try {
    data = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { default: null, connections: {} };
  }
  for (const conn of Object.values(data.connections ?? {})) migrateConn(conn);
  return data;
}

function save(data) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export const ConnectionRegistry = {
  list() {
    const data = load();
    return { default: data.default, connections: Object.keys(data.connections) };
  },

  get(alias) {
    const data = load();
    return data.connections[alias] ?? null;
  },

  getDefault() {
    const data = load();
    if (!data.default) return null;
    return { alias: data.default, conn: data.connections[data.default] ?? null };
  },

  /** conn.userId may be a single string or an array; normalized to conn.userIds. */
  add(alias, conn) {
    const data = load();
    const { userId, ...rest } = conn;
    const userIds = Array.isArray(userId) ? userId : [userId];
    data.connections[alias] = { ...rest, userIds };
    if (!data.default) data.default = alias;
    save(data);
  },

  remove(alias) {
    const data = load();
    delete data.connections[alias];
    if (data.default === alias) {
      const remaining = Object.keys(data.connections);
      data.default = remaining[0] ?? null;
    }
    save(data);
  },

  setDefault(alias) {
    const data = load();
    if (!data.connections[alias]) throw new Error(`Connection "${alias}" not found`);
    data.default = alias;
    save(data);
  },

  /**
   * Resolve alias: if alias is given use it, otherwise use the default.
   * Returns { alias, conn } or throws.
   */
  resolve(alias) {
    const data = load();
    const key = alias || data.default;
    if (!key) throw new Error('No connection specified and no default set. Use sf_connect to add one.');
    const conn = data.connections[key];
    if (!conn) throw new Error(`Connection "${key}" not found`);
    return { alias: key, conn };
  },

  /**
   * Resolve alias plus which userId to act as.
   * requestedUserId omitted -> conn.userIds[0] (default).
   * requestedUserId given but not registered -> throws, telling the caller to add_user it first.
   * Returns { alias, conn, userId }.
   */
  resolveUser(alias, requestedUserId) {
    const { alias: key, conn } = this.resolve(alias);
    if (!requestedUserId) return { alias: key, conn, userId: conn.userIds[0] };
    if (!conn.userIds.includes(requestedUserId)) {
      throw new Error(
        `userId "${requestedUserId}" is not registered for connection "${key}". ` +
        `Registered userIds: ${conn.userIds.join(', ')}. ` +
        `To use it, call sf_connect with action:"add_user", alias:"${key}", userId:"${requestedUserId}".`
      );
    }
    return { alias: key, conn, userId: requestedUserId };
  },

  /** Adds a userId to an alias's registered list. makeDefault moves it to the front. */
  addUser(alias, userId, { makeDefault = false } = {}) {
    const data = load();
    const conn = data.connections[alias];
    if (!conn) throw new Error(`Connection "${alias}" not found`);
    if (!conn.userIds.includes(userId)) conn.userIds.push(userId);
    if (makeDefault) conn.userIds = [userId, ...conn.userIds.filter(u => u !== userId)];
    save(data);
    return conn.userIds;
  },

  /** Removes a userId from an alias's registered list. Refuses to remove the last one. */
  removeUser(alias, userId) {
    const data = load();
    const conn = data.connections[alias];
    if (!conn) throw new Error(`Connection "${alias}" not found`);
    if (!conn.userIds.includes(userId)) throw new Error(`userId "${userId}" is not registered for connection "${alias}"`);
    if (conn.userIds.length === 1) throw new Error(`Cannot remove the last userId for connection "${alias}"`);
    conn.userIds = conn.userIds.filter(u => u !== userId);
    save(data);
    return conn.userIds;
  },

  /** Reorders an alias's userIds so the given one is first (the default). */
  setDefaultUser(alias, userId) {
    const data = load();
    const conn = data.connections[alias];
    if (!conn) throw new Error(`Connection "${alias}" not found`);
    if (!conn.userIds.includes(userId)) throw new Error(`userId "${userId}" is not registered for connection "${alias}"`);
    conn.userIds = [userId, ...conn.userIds.filter(u => u !== userId)];
    save(data);
    return conn.userIds;
  },

  setIas(alias, { tenantUrl, clientId, clientSecret }) {
    const data = load();
    if (!data.connections[alias]) throw new Error(`Connection "${alias}" not found. Add it with sf_connect first.`);
    data.connections[alias].ias = { tenantUrl, clientId, clientSecret };
    save(data);
  },

  removeIas(alias) {
    const data = load();
    if (!data.connections[alias]) throw new Error(`Connection "${alias}" not found`);
    delete data.connections[alias].ias;
    save(data);
  },

  /** Returns { alias, ias } or throws if alias or its IAS sub-config is missing. */
  getIas(alias) {
    const { alias: key, conn } = this.resolve(alias);
    if (!conn.ias) throw new Error(`No IAS credentials configured for alias "${key}" — use ias_connect to add them.`);
    return { alias: key, ias: conn.ias };
  },
};
