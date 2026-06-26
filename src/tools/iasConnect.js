import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';
import { IASSession } from '../auth/IASSession.js';

import { z } from 'zod';

export const iasConnectSchema = {
  description: 'Manage SAP Cloud Identity Services (IAS) credentials for an existing sf_connect alias. Actions: list (show which aliases have IAS configured), add (attach IAS client credentials to an alias), remove (detach), test (verify credentials).',
  inputSchema: {
    action: z.enum(['list', 'add', 'remove', 'test']).describe('Operation to perform'),
    alias: z.string().optional().describe('Existing sf_connect alias to attach IAS credentials to. Omit to use default.'),
    tenantUrl: z.string().optional().describe('IAS tenant base URL, e.g. https://<tenant>.accounts.ondemand.com'),
    clientId: z.string().optional().describe('Client ID created under the application\'s Trust > Client Authentication > Secrets (scope: Application Users)'),
    clientSecret: z.string().optional().describe('Client secret for the above client ID — used as HTTP Basic Auth password directly on each API call'),
  },
};

export async function iasConnectHandler({ action, alias, tenantUrl, clientId, clientSecret }) {
  switch (action) {
    case 'list': {
      const { connections } = ConnectionRegistry.list();
      const withIas = connections.filter(a => ConnectionRegistry.get(a)?.ias);
      if (withIas.length === 0) return { text: 'No aliases have IAS credentials configured. Use action: "add" to attach one.' };
      return { text: `Aliases with IAS configured:\n${withIas.map(a => `- ${a}`).join('\n')}` };
    }

    case 'add': {
      const { alias: resolvedAlias } = ConnectionRegistry.resolve(alias);
      if (!tenantUrl || !clientId || !clientSecret) {
        return { error: 'Required for add: tenantUrl, clientId, clientSecret' };
      }
      ConnectionRegistry.setIas(resolvedAlias, { tenantUrl, clientId, clientSecret });
      sessionCache.invalidateIas(resolvedAlias);
      return { text: `IAS credentials saved for alias "${resolvedAlias}".` };
    }

    case 'remove': {
      const { alias: resolvedAlias } = ConnectionRegistry.resolve(alias);
      ConnectionRegistry.removeIas(resolvedAlias);
      sessionCache.invalidateIas(resolvedAlias);
      return { text: `IAS credentials removed for alias "${resolvedAlias}".` };
    }

    case 'test': {
      try {
        const { alias: resolvedAlias, ias } = ConnectionRegistry.getIas(alias);
        const session = new IASSession(ias);
        // A lookup for a name_id that doesn't exist returns 404 if auth succeeded,
        // or 401 if the credentials are invalid/wrong scope.
        const res = await session.request('GET', '/service/users?name_id=__ias_connect_test_probe__', {
          contentType: 'application/vnd.sap-id-service.sp-user-id+xml',
        });
        if (res.status === 401) {
          const errText = await res.text().catch(() => '');
          return { error: `Test failed (401 Unauthorized): ${errText.slice(0, 300)}` };
        }
        return { text: `IAS connection for "${resolvedAlias}" works. Basic Auth against the User Management REST API verified (status ${res.status}).` };
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
