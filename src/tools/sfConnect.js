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
    uiHost: z.string().optional().describe('UI host for internal APIs (e.g. salesdemo.successfactors.eu)'),
    username: z.string().optional().describe('SF OData API username (usually user@COMPANYID)'),
    password: z.string().optional().describe('SF OData password'),
    uiUsername: z.string().optional().describe('SF UI login username (if different from OData username)'),
    uiPassword: z.string().optional().describe('SF UI login password (if different from OData password)'),
    companyId: z.string().optional().describe('SF company ID (e.g. SFCPART001143)'),
    conditionalAuthUrl: z.string().optional().describe('Optional: external IdP URL for SAML login'),
  },
};


export async function sfConnectHandler({ action, alias, apiHost, uiHost, username, password, uiUsername, uiPassword, companyId, conditionalAuthUrl }) {
  switch (action) {
    case 'list': {
      const { default: def, connections } = ConnectionRegistry.list();
      if (connections.length === 0) return { text: 'No connections saved. Use action: "add" to register one.' };
      const lines = connections.map(a => `- ${a}${a === def ? ' (default)' : ''}`);
      return { text: `Saved connections:\n${lines.join('\n')}` };
    }

    case 'add': {
      if (!alias || !apiHost || !username || !password || !companyId) {
        return { error: 'Required for add: alias, apiHost, username, password, companyId' };
      }
      const conn = { apiHost, username, password, companyId };
      if (uiHost) conn.uiHost = uiHost;
      if (uiUsername) conn.uiUsername = uiUsername;
      if (uiPassword) conn.uiPassword = uiPassword;
      if (conditionalAuthUrl) conn.conditionalAuthUrl = conditionalAuthUrl;
      sessionCache.invalidate(alias);
      ConnectionRegistry.add(alias, conn);
      return { text: `Connection "${alias}" saved.${uiUsername ? ' (UI credentials included)' : ''}` };
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
