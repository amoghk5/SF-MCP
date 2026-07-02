import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';

import { z } from 'zod';
import { connOpt, userIdOpt } from './shared.js';

export const sfFunctionSchema = {
  description: 'Call an SAP SuccessFactors OData v2 function import (custom function), e.g. RBP functions like getExpandedDynamicGroupById, getUserRolesByUserId, checkUserPermission, updateStaticGroup, upsert (Dynamic Group). GET-style functions take query params; POST-style functions (like upsert) take a JSON body.',
  inputSchema: {
    functionName: z.string().describe('Function import name (e.g. "getExpandedDynamicGroupById", "checkUserPermission", "upsert")'),
    params: z.object({}).passthrough().optional().describe('Query-string parameters. Strings are auto single-quoted and escaped for OData (e.g. "Carla Grant" -> \'Carla Grant\', and "355750" -> \'355750\' since numeric-looking IDs like userId are usually Edm.String in SF). JS numbers/booleans pass through unquoted. To pass a Long, give it an explicit "L" suffix as a string (e.g. "1234L") — this is the only case treated as a raw literal instead of being quoted. A value already wrapped in single quotes is also passed through as-is.'),
    body: z.object({}).passthrough().optional().describe('JSON payload for POST-body function imports (e.g. the DynamicGroup definition for "upsert"). Presence of body implies method=POST unless overridden.'),
    method: z.enum(['GET', 'POST']).optional().describe('HTTP method. Defaults to POST if body is provided, otherwise GET.'),
    connection: connOpt,
    userId: userIdOpt,
  },
};

// Only an explicit Long suffix ("1234L") or a bare boolean is treated as a raw
// literal — plain digit strings (e.g. a numeric userId) are Edm.String in SF
// and must stay quoted, so we don't guess based on digits alone.
const RAW_LITERAL_RE = /^(-?\d+(\.\d+)?L|true|false)$/i;

function formatParamValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    if (RAW_LITERAL_RE.test(value)) return value;
    if (value.startsWith("'") && value.endsWith("'")) return value;
    return `'${value.replace(/'/g, "''")}'`;
  }
  return String(value);
}

export async function sfFunctionHandler({ functionName, params, body, method, connection, userId }) {
  const { alias, conn, userId: resolvedUserId } = ConnectionRegistry.resolveUser(connection, userId);
  const session = sessionCache.odata(`${alias}::${resolvedUserId}`, { ...conn, userId: resolvedUserId });

  const httpMethod = method ?? (body ? 'POST' : 'GET');

  const qs = new URLSearchParams();
  qs.set('$format', 'json');
  if (params) {
    for (const [k, v] of Object.entries(params)) qs.set(k, formatParamValue(v));
  }

  const path = `/${functionName}?${qs}`;
  const res = await session.request(httpMethod, path, body);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { error: `SF returned ${res.status}: ${errText.slice(0, 500)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: 'SF response was not valid JSON' };
  }

  const result = data.d?.results ?? data.d ?? data;

  return {
    connection: alias,
    function: functionName,
    method: httpMethod,
    result,
  };
}
