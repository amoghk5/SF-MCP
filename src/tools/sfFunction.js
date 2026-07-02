import { ConnectionRegistry } from '../ConnectionRegistry.js';
import { sessionCache } from '../auth/SessionCache.js';

import { z } from 'zod';
import { connOpt } from './shared.js';

export const sfFunctionSchema = {
  description: 'Call an SAP SuccessFactors OData v2 function import (custom function), e.g. RBP functions like getExpandedDynamicGroupById, getUserRolesByUserId, checkUserPermission, updateStaticGroup, upsert (Dynamic Group). GET-style functions take query params; POST-style functions (like upsert) take a JSON body.',
  inputSchema: {
    functionName: z.string().describe('Function import name (e.g. "getExpandedDynamicGroupById", "checkUserPermission", "upsert")'),
    params: z.object({}).passthrough().optional().describe('Query-string parameters. Strings are auto single-quoted and escaped for OData (e.g. "Carla Grant" -> \'Carla Grant\'). Numbers/booleans pass through unquoted. To pass a Long, a pre-quoted string, or any other exact literal, just pass a string that already looks like a valid OData literal (e.g. "1234L", "\'already quoted\'", "true") and it will be used as-is.'),
    body: z.object({}).passthrough().optional().describe('JSON payload for POST-body function imports (e.g. the DynamicGroup definition for "upsert"). Presence of body implies method=POST unless overridden.'),
    method: z.enum(['GET', 'POST']).optional().describe('HTTP method. Defaults to POST if body is provided, otherwise GET.'),
    connection: connOpt,
  },
};

const RAW_LITERAL_RE = /^(-?\d+(\.\d+)?L?|true|false)$/i;

function formatParamValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    if (RAW_LITERAL_RE.test(value)) return value;
    if (value.startsWith("'") && value.endsWith("'")) return value;
    return `'${value.replace(/'/g, "''")}'`;
  }
  return String(value);
}

export async function sfFunctionHandler({ functionName, params, body, method, connection }) {
  const { alias, conn } = ConnectionRegistry.resolve(connection);
  const session = sessionCache.odata(alias, conn);

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
