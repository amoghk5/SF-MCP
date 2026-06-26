import https from 'node:https';
import zlib from 'node:zlib';
import { URL } from 'node:url';

const REQUEST_TIMEOUT_MS = 60_000;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

/**
 * IASSession — HTTP requests against the SAP Cloud Identity Services (IAS)
 * User Management / Invitation REST APIs.
 *
 * Auth: Basic Auth using the client ID and secret directly as username/password
 * (configured under an Application's Trust > Client Authentication > Secrets,
 * scope "Application Users"). There is no separate OAuth2 token exchange for
 * these first-party REST APIs.
 */
export class IASSession {
  constructor(ias) {
    this.ias = ias; // { tenantUrl, clientId, clientSecret }
  }

  get _baseUrl() {
    return this.ias.tenantUrl.replace(/\/$/, '');
  }

  get _authHeader() {
    const basic = Buffer.from(`${this.ias.clientId}:${this.ias.clientSecret}`).toString('base64');
    return `Basic ${basic}`;
  }

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

        if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: { get: (name) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? v[0] : (v ?? null);
            } },
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

  /** path is relative to the tenant root, e.g. "/service/users" or "/cps/invite/" */
  async request(method, path, { contentType, body } = {}) {
    const url = `${this._baseUrl}${path}`;
    const headers = { Authorization: this._authHeader };
    if (contentType) headers['Content-Type'] = contentType;

    return await this._requestWithRetry(url, {
      method: method.toUpperCase(),
      headers,
      body,
    });
  }
}
