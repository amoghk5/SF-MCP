import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { ODataSession } from '../auth/ODataSession.js';

export const sfConnectTool = {
  name: 'sf_connect',
  description: 'Manage SuccessFactors connection registry. Actions: list (show all saved connections), add (register a new SF system by alias), remove (delete a connection), set_default (change which connection is used by default), test (verify credentials work).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'set_default', 'test'],
        description: 'Operation to perform',
      },
      alias: {
        type: 'string',
        description: 'Short name for the connection (e.g. "1143", "t1", "prod")',
      },
      apiHost: { type: 'string', description: 'OData API host (e.g. apisalesdemo2.successfactors.eu)' },
      uiHost: { type: 'string', description: 'UI host for internal APIs (e.g. salesdemo.successfactors.eu)' },
      username: { type: 'string', description: 'SF API username (usually user@COMPANYID)' },
      password: { type: 'string', description: 'SF password' },
      companyId: { type: 'string', description: 'SF company ID (e.g. SFCPART001143)' },
      conditionalAuthUrl: { type: 'string', description: 'Optional: external IdP URL for SAML login (leave blank for standard SSO)' },
    },
    required: ['action'],
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
