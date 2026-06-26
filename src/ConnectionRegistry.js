import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.sf-mcp');
const CONFIG_FILE = join(CONFIG_DIR, 'connections.json');

function load() {
  if (!existsSync(CONFIG_FILE)) return { default: null, connections: {} };
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { default: null, connections: {} };
  }
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

  add(alias, conn) {
    const data = load();
    data.connections[alias] = conn;
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
