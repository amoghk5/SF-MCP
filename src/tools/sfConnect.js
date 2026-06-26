import { readFileSync } from 'node:fs';
import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { ODataSession } from '../auth/ODataSession.js';

import { z } from 'zod';

export const sfConnectSchema = {
  description: 'Manage SuccessFactors connection registry. Actions: list (show all saved connections), add (register a new SF system by alias), remove (delete a connection), set_default (change the default), test (verify credentials).',
  inputSchema: {
    action: z.enum(['list', 'add', 'remove', 'set_default', 'test']).describe('Operation to perform'),
    alias: z.string().optional().describe('Short name for the connection (e.g. 1143, t1, prod)'),
    apiHost: z.string().optional().describe('OData API host (e.g. apisalesdemo2.successfactors.eu)'),
    companyId: z.string().optional().describe('SF company ID (e.g. SFCPART001143)'),
    clientId: z.string().optional().describe('OAuth API key (from SF Admin Center > OAuth Client Applications)'),
    pemPath: z.string().optional().describe('Path to X.509 PEM file downloaded from SF Admin Center'),
    userId: z.string().optional().describe('SF userId to authenticate as (used as JWT sub claim)'),
    uiHost: z.string().optional().describe('UI host for internal APIs (e.g. salesdemo.successfactors.eu)'),
  },
};


export async function sfConnectHandler({ action, alias, apiHost, companyId, clientId, pemPath, userId, uiHost }) {
  switch (action) {
    case 'list': {
      const { default: def, connections } = ConnectionRegistry.list();
      if (connections.length === 0) return { text: 'No connections saved. Use action: "add" to register one.' };
      const lines = connections.map(a => `- ${a}${a === def ? ' (default)' : ''}`);
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
      sessionCache.invalidate(alias);
      ConnectionRegistry.add(alias, conn);
      return { text: `Connection "${alias}" saved.` };
    }

    case 'remove': {
      if (!alias) return { error: 'alias is required' };
      ConnectionRegistry.remove(alias);
      sessionCache.invalidate(alias);
      return { text: `Connection "${alias}" removed.` };
    }

    case 'set_default': {
      if (!alias) return { error: 'alias is required' };
      ConnectionRegistry.setDefault(alias);
      return { text: `"${alias}" is now the default connection.` };
    }

    case 'test': {
      try {
        const { alias: resolvedAlias, conn } = ConnectionRegistry.resolve(alias);
        const session = new ODataSession(conn);
        await session.fetchCSRF();
        return { text: `Connection "${resolvedAlias}" works. OData auth verified.` };
      } catch (err) {
        const detail = err.cause
          ? `${err.message} — ${err.cause.code ?? err.cause.message ?? String(err.cause)}`
          : err.message;
        return { error: `Test failed: ${detail}` };
      }
    }

    default:
      return { error: `Unknown action "${action}"` };
  }
}
