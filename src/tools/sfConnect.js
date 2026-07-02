import { readFileSync } from 'node:fs';
import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { ODataSession } from '../auth/ODataSession.js';

import { z } from 'zod';

export const sfConnectSchema = {
  description: 'Manage SuccessFactors connection registry. Actions: list (show all saved connections), add (register a new SF system by alias), remove (delete a connection), set_default (change the default alias), test (verify credentials), add_user (register another userId for an alias), remove_user (deregister a userId), set_default_user (change which registered userId is used by default).',
  inputSchema: {
    action: z.enum(['list', 'add', 'remove', 'set_default', 'test', 'add_user', 'remove_user', 'set_default_user']).describe('Operation to perform'),
    alias: z.string().optional().describe('Short name for the connection (e.g. 1143, t1, prod)'),
    apiHost: z.string().optional().describe('OData API host (e.g. apisalesdemo2.successfactors.eu)'),
    companyId: z.string().optional().describe('SF company ID (e.g. SFCPART001143)'),
    clientId: z.string().optional().describe('OAuth API key (from SF Admin Center > OAuth Client Applications)'),
    pemPath: z.string().optional().describe('Path to X.509 PEM file downloaded from SF Admin Center'),
    userId: z.union([z.string(), z.array(z.string())]).optional().describe('SF userId(s) to authenticate as (used as JWT sub claim). For "add", a string or array of strings — the first element becomes the default. For add_user/remove_user/set_default_user/test, a single userId string.'),
    makeDefault: z.boolean().optional().describe('For add_user: also make this userId the default for the alias.'),
    uiHost: z.string().optional().describe('UI host for internal APIs (e.g. salesdemo.successfactors.eu)'),
  },
};


export async function sfConnectHandler({ action, alias, apiHost, companyId, clientId, pemPath, userId, makeDefault, uiHost }) {
  switch (action) {
    case 'list': {
      const { default: def, connections } = ConnectionRegistry.list();
      if (connections.length === 0) return { text: 'No connections saved. Use action: "add" to register one.' };
      const lines = connections.map(a => {
        const conn = ConnectionRegistry.get(a);
        const users = conn.userIds.map((u, i) => i === 0 ? `${u} (default)` : u).join(', ');
        return `- ${a}${a === def ? ' (default connection)' : ''} — userIds: ${users}`;
      });
      return { text: `Saved connections:\n${lines.join('\n')}` };
    }

    case 'add': {
      if (!alias || !apiHost || !companyId || !clientId || !pemPath || !userId) {
        return { error: 'Required for add: alias, apiHost, companyId, clientId, pemPath, userId' };
      }
      let privateKeyBase64;
      try {
        const raw = readFileSync(pemPath, 'utf8');
        const match = raw.match(/-----BEGIN ENCRYPTED PRIVATE KEY-----\r?\n([\s\S]+?)\r?\n-----END ENCRYPTED PRIVATE KEY-----/);
        if (!match) return { error: 'PEM file does not contain an ENCRYPTED PRIVATE KEY block' };
        privateKeyBase64 = match[1].replace(/\s/g, '');
      } catch (err) {
        return { error: `Cannot read PEM file at "${pemPath}": ${err.message}` };
      }
      const conn = { apiHost, companyId, clientId, userId, privateKeyBase64 };
      if (uiHost) conn.uiHost = uiHost;
      sessionCache.invalidateAlias(alias);
      ConnectionRegistry.add(alias, conn);
      return { text: `Connection "${alias}" saved.` };
    }

    case 'remove': {
      if (!alias) return { error: 'alias is required' };
      ConnectionRegistry.remove(alias);
      sessionCache.invalidateAlias(alias);
      return { text: `Connection "${alias}" removed.` };
    }

    case 'set_default': {
      if (!alias) return { error: 'alias is required' };
      ConnectionRegistry.setDefault(alias);
      return { text: `"${alias}" is now the default connection.` };
    }

    case 'test': {
      try {
        const { alias: resolvedAlias, conn, userId: resolvedUserId } = ConnectionRegistry.resolveUser(alias, typeof userId === 'string' ? userId : undefined);
        const session = new ODataSession({ ...conn, userId: resolvedUserId });
        await session.fetchCSRF();
        return { text: `Connection "${resolvedAlias}" (userId: ${resolvedUserId}) works. OData auth verified.` };
      } catch (err) {
        const detail = err.cause
          ? `${err.message} — ${err.cause.code ?? err.cause.message ?? String(err.cause)}`
          : err.message;
        return { error: `Test failed: ${detail}` };
      }
    }

    case 'add_user': {
      if (!alias || !userId || typeof userId !== 'string') return { error: 'alias and a single userId string are required for add_user' };
      const userIds = ConnectionRegistry.addUser(alias, userId, { makeDefault });
      return { text: `userId "${userId}" registered for connection "${alias}". userIds: ${userIds.join(', ')}` };
    }

    case 'remove_user': {
      if (!alias || !userId || typeof userId !== 'string') return { error: 'alias and a single userId string are required for remove_user' };
      const userIds = ConnectionRegistry.removeUser(alias, userId);
      sessionCache.invalidateAlias(alias);
      return { text: `userId "${userId}" removed from connection "${alias}". userIds: ${userIds.join(', ')}` };
    }

    case 'set_default_user': {
      if (!alias || !userId || typeof userId !== 'string') return { error: 'alias and a single userId string are required for set_default_user' };
      const userIds = ConnectionRegistry.setDefaultUser(alias, userId);
      return { text: `"${userId}" is now the default userId for connection "${alias}". userIds: ${userIds.join(', ')}` };
    }

    default:
      return { error: `Unknown action "${action}"` };
  }
}
