import { randomUUID } from 'node:crypto';
import https from 'node:https';
import zlib from 'node:zlib';
import { URL } from 'node:url';

const REQUEST_TIMEOUT_MS = 120_000; // 2 min; SF complex ops can take longer but this covers most calls
const MAX_429_RETRIES = 2;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

/**
 * ODataSession — manages Basic Auth + CSRF token for the OData v2 API host.
 * Uses node:https (HTTP/1.1) directly — avoids undici's HTTP/2 ALPN negotiation
 * which breaks on some SF preview/sandbox servers.
 */
export class ODataSession {
  constructor(conn) {
    this.conn = conn; // { apiHost, username, password, companyId }
    this.jsessionid = null;
    this.csrfToken = null;
    this.csrfFetchedAt = 0;
    this.CSRF_TTL_MS = 9 * 60 * 1000; // 9 min — API session timeout is 10 min
  }

  get _baseUrl() {
    return `https://${this.conn.apiHost}/odata/v2`;
  }

  get _authHeader() {
    const creds = Buffer.from(`${this.conn.username}:${this.conn.password}`).toString('base64');
    return `Basic ${creds}`;
  }

  _isCSRFExpired() {
    return Date.now() - this.csrfFetchedAt > this.CSRF_TTL_MS;
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
    const headers = {
      Authorization: this._authHeader,
      'x-csrf-token': 'Fetch',
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
    };
    if (this.jsessionid) headers.cookie = `JSESSIONID=${this.jsessionid}`;

    const res = await this._requestWithRetry(url, { method: 'GET', headers });

    if (res.status === 401 || res.status === 403) {
      throw new Error(`[AUTH] Failed to authenticate: ${res.status}`);
    }

    const token = res.headers.get('x-csrf-token');
    if (!token) throw new Error('[AUTH] No CSRF token in response');

    const setCookies = res.headers.getSetCookie();
    for (const h of setCookies) {
      const m = h.match(/^JSESSIONID=([^;]+)/);
      if (m) this.jsessionid = m[1];
    }

    this.csrfToken = token;
    this.csrfFetchedAt = Date.now();
    return token;
  }

  async getCSRF() {
    if (!this.csrfToken || this._isCSRFExpired()) await this.fetchCSRF();
    return this.csrfToken;
  }

  async request(method, path, body, extraHeaders = {}) {
    const url = `${this._baseUrl}${path}`;
    const correlationId = randomUUID();
    const headers = {
      Authorization: this._authHeader,
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
