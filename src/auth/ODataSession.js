import { randomUUID, createPrivateKey } from 'node:crypto';
import crypto from 'node:crypto';
import https from 'node:https';
import zlib from 'node:zlib';
import { URL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SignedXml } = require('xml-crypto');

const SAML2_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const SF_ISSUER = 'www.successfactors.com/oauth/idp';
const SF_AUDIENCE = 'www.successfactors.com';

const REQUEST_TIMEOUT_MS = 120_000; // 2 min; SF complex ops can take longer but this covers most calls
const MAX_429_RETRIES = 2;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);
const TOKEN_EXPIRY_BUFFER_MS = 60_000; // refresh 60s before actual expiry

/**
 * ODataSession — manages OAuth 2.0 Bearer token + CSRF token for the OData v2 API host.
 *
 * Auth flow: JWT Bearer (urn:ietf:params:oauth:grant-type:jwt-bearer)
 * SF PEM format: outer base64 encodes (base64(PKCS8_key_DER) + "###" + metadata).
 * After stripping the outer layer the inner base64 is a standard unencrypted PKCS8 key.
 *
 * Uses node:https (HTTP/1.1) directly — avoids undici's HTTP/2 ALPN negotiation
 * which breaks on some SF preview/sandbox servers.
 */
export class ODataSession {
  constructor(conn) {
    this.conn = conn; // { apiHost, companyId, clientId, userId, pemContent }
    this.jsessionid = null;
    this.csrfToken = null;
    this.csrfFetchedAt = 0;
    this.CSRF_TTL_MS = 9 * 60 * 1000; // 9 min — API session timeout is 10 min
    this._accessToken = null;
    this._tokenExpiresAt = 0;
    this._privateKey = null; // cached KeyObject, parsed once from pemContent
  }

  get _baseUrl() {
    return `https://${this.conn.apiHost}/odata/v2`;
  }

  _isCSRFExpired() {
    return Date.now() - this.csrfFetchedAt > this.CSRF_TTL_MS;
  }

  _isTokenExpired() {
    return Date.now() > this._tokenExpiresAt;
  }

  // conn.privateKeyBase64 is the outer base64 from the SF PEM key block.
  // SF double-encodes: outer decode → "innerBase64###metadata"; inner base64 is unencrypted PKCS8.
  _loadPrivateKey() {
    if (this._privateKey) return this._privateKey;
    const innerContent = Buffer.from(this.conn.privateKeyBase64, 'base64').toString('utf8');
    const innerBase64 = innerContent.split('###')[0].trim();
    const pem = `-----BEGIN PRIVATE KEY-----\n${innerBase64}\n-----END PRIVATE KEY-----`;
    this._privateKey = createPrivateKey({ key: pem, format: 'pem' });
    return this._privateKey;
  }

  _buildSamlAssertion(privateKey) {
    const assertionId = `_${crypto.randomUUID()}`;
    const sessionIndex = crypto.randomUUID();
    const now = new Date();
    const issueInstant = now.toISOString();
    const validFrom = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const validUntil = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const recipientUrl = `https://${this.conn.apiHost}/oauth/token`;

    const escXml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const unsignedXml = `<?xml version="1.0" encoding="UTF-8"?>
<saml2:Assertion xmlns:saml2="${SAML2_NS}" ID="${assertionId}" IssueInstant="${issueInstant}" Version="2.0" xmlns:xs="${XS_NS}" xmlns:xsi="${XSI_NS}">
<saml2:Issuer>${SF_ISSUER}</saml2:Issuer>
<saml2:Subject>
<saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${escXml(this.conn.userId)}</saml2:NameID>
<saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
<saml2:SubjectConfirmationData NotOnOrAfter="${validUntil}" Recipient="${escXml(recipientUrl)}"/>
</saml2:SubjectConfirmation>
</saml2:Subject>
<saml2:Conditions NotBefore="${validFrom}" NotOnOrAfter="${validUntil}">
<saml2:AudienceRestriction>
<saml2:Audience>${SF_AUDIENCE}</saml2:Audience>
</saml2:AudienceRestriction>
</saml2:Conditions>
<saml2:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${sessionIndex}">
<saml2:AuthnContext>
<saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml2:AuthnContextClassRef>
</saml2:AuthnContext>
</saml2:AuthnStatement>
<saml2:AttributeStatement>
<saml2:Attribute Name="api_key">
<saml2:AttributeValue xsi:type="xs:string">${escXml(this.conn.clientId)}</saml2:AttributeValue>
</saml2:Attribute>
</saml2:AttributeStatement>
</saml2:Assertion>`;

    const sxml = new SignedXml({
      privateKey,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sxml.addReference({
      xpath: `//*[@ID='${assertionId}']`,
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      inclusiveNamespacesPrefixList: ['xs'],
      digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    });
    sxml.computeSignature(unsignedXml, {
      prefix: 'ds',
      location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
    });
    return Buffer.from(sxml.getSignedXml(), 'utf8').toString('base64');
  }

  async _fetchOAuthToken() {
    const privateKey = this._loadPrivateKey();
    const assertion = this._buildSamlAssertion(privateKey);
    const tokenEndpoint = `https://${this.conn.apiHost}/oauth/token`;

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:saml2-bearer',
      assertion,
      company_id: this.conn.companyId,
      client_id: this.conn.clientId,
    }).toString();

    const res = await this._requestWithRetry(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`[AUTH] OAuth token fetch failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    if (!data.access_token) throw new Error('[AUTH] No access_token in OAuth response');

    this._accessToken = data.access_token;
    this._tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) * 1000) - TOKEN_EXPIRY_BUFFER_MS;
    return this._accessToken;
  }

  async _getAccessToken() {
    if (!this._accessToken || this._isTokenExpired()) await this._fetchOAuthToken();
    return this._accessToken;
  }

  /**
   * Core HTTP/1.1 request using node:https.
   * Returns a fetch-compatible response-like object: { status, ok, headers, text(), json() }
   */
  _request(urlStr, opts = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const reqOpts = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = https.request(reqOpts, (res) => {
        const chunks = [];
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;

        if (encoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        } else if (encoding === 'br') {
          stream = res.pipe(zlib.createBrotliDecompress());
        }

        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const body = Buffer.concat(chunks);
          const rawHeaders = res.headers;

          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (name) => {
                const v = rawHeaders[name.toLowerCase()];
                return Array.isArray(v) ? v[0] : (v ?? null);
              },
              getSetCookie: () => {
                const v = rawHeaders['set-cookie'];
                if (!v) return [];
                return Array.isArray(v) ? v : [v];
              },
            },
            text: () => Promise.resolve(body.toString('utf8')),
            json: () => {
              try { return Promise.resolve(JSON.parse(body.toString('utf8'))); }
              catch (e) { return Promise.reject(e); }
            },
          });
        });
        stream.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        const err = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });

      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  /** Retry once after a short back-off on transient network errors. */
  async _requestWithRetry(urlStr, opts) {
    try {
      return await this._request(urlStr, opts);
    } catch (err) {
      if (TRANSIENT_CODES.has(err.code)) {
        await new Promise(r => setTimeout(r, 2000));
        return await this._request(urlStr, opts);
      }
      throw err;
    }
  }

  async fetchCSRF() {
    const url = `${this._baseUrl}/User?$top=1&$select=userId`;
    const token = await this._getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'x-csrf-token': 'Fetch',
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
    };
    if (this.jsessionid) headers.cookie = `JSESSIONID=${this.jsessionid}`;

    const res = await this._requestWithRetry(url, { method: 'GET', headers });

    if (res.status === 401) {
      throw new Error(`[AUTH] Bearer token rejected (401) during CSRF fetch`);
    }
    if (res.status === 403) {
      throw new Error(`[AUTH] Access denied (403) during CSRF fetch`);
    }

    const csrfToken = res.headers.get('x-csrf-token');
    if (!csrfToken) throw new Error('[AUTH] No CSRF token in response');

    const setCookies = res.headers.getSetCookie();
    for (const h of setCookies) {
      const m = h.match(/^JSESSIONID=([^;]+)/);
      if (m) this.jsessionid = m[1];
    }

    this.csrfToken = csrfToken;
    this.csrfFetchedAt = Date.now();
    return csrfToken;
  }

  async getCSRF() {
    if (!this.csrfToken || this._isCSRFExpired()) await this.fetchCSRF();
    return this.csrfToken;
  }

  async request(method, path, body, extraHeaders = {}) {
    const url = `${this._baseUrl}${path}`;
    const correlationId = randomUUID();
    const token = await this._getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'x-correlation-id': correlationId,
      ...extraHeaders,
    };

    if (this.jsessionid) headers.cookie = `JSESSIONID=${this.jsessionid}`;

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
      headers['x-csrf-token'] = await this.getCSRF();
      headers['Content-Type'] = 'application/json';
    }

    const opts = {
      method: method.toUpperCase(),
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };

    let res = await this._requestWithRetry(url, opts);

    // OAuth token rejected mid-session — refresh and retry once
    if (res.status === 401) {
      this._accessToken = null;
      const freshToken = await this._getAccessToken();
      headers.Authorization = `Bearer ${freshToken}`;
      res = await this._requestWithRetry(url, { ...opts, headers });
    }

    // CSRF expired mid-session — refresh and retry once
    if (res.status === 403) {
      const errText = await res.text();
      if (errText.includes('CSRF')) {
        this.csrfToken = null;
        headers['x-csrf-token'] = await this.getCSRF();
        res = await this._requestWithRetry(url, { ...opts, headers });
      } else {
        return res;
      }
    }

    // Rate limited — wait and retry
    if (res.status === 429) {
      res = await this._retryAfter429(res, url, opts);
    }

    return res;
  }

  async _retryAfter429(lastRes, url, opts) {
    let res = lastRes;
    for (let attempt = 0; attempt < MAX_429_RETRIES; attempt++) {
      const retryAfter = res.headers.get('retry-after');
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : 5;
      const waitMs = Math.min((isNaN(waitSec) ? 5 : waitSec) * 1000, 60_000);
      await new Promise(r => setTimeout(r, waitMs));
      res = await this._request(url, opts);
      if (res.status !== 429) return res;
    }
    return res;
  }
}
