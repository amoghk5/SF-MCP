import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';

import { z } from 'zod';
import { connOpt } from './shared.js';

const SP_USER_ID_CONTENT_TYPE = 'application/vnd.sap-id-service.sp-user-id+xml';

export const iasUserSchema = {
  description: 'Manage SSO users in SAP Cloud Identity Services (IAS) via its User Management REST API (SP user registration, retrieval, deactivation/activation, deletion). Actions: create, get (by spUserId), search (by nameId), update (activate/deactivate), delete.',
  inputSchema: {
    action: z.enum(['create', 'get', 'search', 'update', 'delete']).describe('Operation to perform'),
    alias: connOpt,
    applicationId: z.string().optional().describe('ID of the subscribed application to scope the operation to. Omit to operate tenant-wide.'),
    spUserId: z.string().optional().describe('SP user ID — required for get, update, delete'),
    nameId: z.string().optional().describe('Name ID to look up — required for search (can be a User ID, login name, etc.)'),
    status: z.enum(['active', 'inactive']).optional().describe('Required for update: set to "inactive" to deactivate, "active" to reactivate'),
    email: z.string().optional().describe('Required for create: unique email of the user to register'),
    lastName: z.string().optional().describe('Required for create: max 64 chars'),
    firstName: z.string().optional().describe('Optional for create: max 32 chars'),
    loginName: z.string().optional().describe('Optional for create: logon name of the user'),
    userProfileId: z.string().optional().describe('Optional for create: the user ID'),
    language: z.string().optional().describe('Optional for create: two/four-letter language code for the activation email'),
    sourceUrl: z.string().optional().describe('Optional for create: public page URL with Identity Authentication overlays integrated'),
    targetUrl: z.string().optional().describe('Optional for create: page the user is redirected to after activation'),
    sendEmail: z.boolean().optional().describe('Optional for create: send activation email (default true). If false, an activationLink is returned in the response.'),
    spCustomAttributes: z.array(z.string()).max(5).optional().describe('Optional for create: up to 5 custom attribute strings, mapped to spCustomAttribute1..5'),
  },
};

async function iasRequest(alias, method, path, opts) {
  const { alias: resolvedAlias, ias } = ConnectionRegistry.getIas(alias);
  const session = sessionCache.ias(resolvedAlias, ias);
  const res = await session.request(method, path, opts);
  const text = await res.text();
  // Some lookups (e.g. SP User ID Retrieval) signal success via a 3xx + Location header
  // rather than a 2xx body, so only treat 4xx/5xx as failure.
  if (res.status >= 400) {
    throw new Error(`[IAS] ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text || null; }
  return { data, location: res.headers.get('location') };
}

function withAppId(path, applicationId) {
  if (!applicationId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}applicationId=${encodeURIComponent(applicationId)}`;
}

export async function iasUserHandler({ action, alias, applicationId, spUserId, nameId, status, email, lastName, firstName, loginName, userProfileId, language, sourceUrl, targetUrl, sendEmail, spCustomAttributes }) {
  switch (action) {
    case 'create': {
      if (!email || !lastName) return { error: 'Required for create: email, lastName' };
      const params = new URLSearchParams({ email, last_name: lastName });
      if (firstName) params.set('first_name', firstName);
      if (loginName) params.set('login_name', loginName);
      if (userProfileId) params.set('user_profile_id', userProfileId);
      if (language) params.set('language', language);
      if (sourceUrl) params.set('source_url', sourceUrl);
      if (targetUrl) params.set('target_url', targetUrl);
      if (sendEmail !== undefined) params.set('send_email', String(sendEmail));
      (spCustomAttributes ?? []).forEach((v, i) => params.set(`spCustomAttribute${i + 1}`, v));

      const { data, location } = await iasRequest(alias, 'POST', withAppId('/service/users', applicationId), {
        contentType: 'application/x-www-form-urlencoded',
        body: params.toString(),
      });
      return { text: `User registered.`, location, data };
    }

    case 'get': {
      if (!spUserId) return { error: 'spUserId is required for get' };
      const { data } = await iasRequest(alias, 'GET', withAppId(`/service/users/${encodeURIComponent(spUserId)}`, applicationId), {
        contentType: SP_USER_ID_CONTENT_TYPE,
      });
      return data;
    }

    case 'search': {
      if (!nameId) return { error: 'nameId is required for search' };
      const { location } = await iasRequest(alias, 'GET', withAppId(`/service/users?name_id=${encodeURIComponent(nameId)}`, applicationId), {
        contentType: SP_USER_ID_CONTENT_TYPE,
      });
      if (!location) return { error: 'User not found' };
      return { text: `Found SP user.`, spUserId: location.split('/').pop(), location };
    }

    case 'update': {
      if (!spUserId || !status) return { error: 'Required for update: spUserId, status ("active" or "inactive")' };
      await iasRequest(alias, 'PUT', withAppId(`/service/users/${encodeURIComponent(spUserId)}`, applicationId), {
        contentType: `${SP_USER_ID_CONTENT_TYPE}; version=1.0`,
        body: `<user><status>${status}</status></user>`,
      });
      return { text: `User "${spUserId}" set to ${status}.` };
    }

    case 'delete': {
      if (!spUserId) return { error: 'spUserId is required for delete' };
      await iasRequest(alias, 'DELETE', withAppId(`/service/users/${encodeURIComponent(spUserId)}`, applicationId), {});
      return { text: `User "${spUserId}" deleted.` };
    }

    default:
      return { error: `Unknown action "${action}"` };
  }
}
