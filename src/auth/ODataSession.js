import { randomUUID } from 'crypto';

const REQUEST_TIMEOUT_MS = 120_000; // 2 min — SF docs say complex ops can take up to 10 min; 2 min is a safe default for most calls
const MAX_429_RETRIES = 2;

/**
 * ODataSession — manages Basic Auth + CSRF token for the OData v2 API host.
 * One instance per connection alias.
 */
export class ODataSession {
  constructor(conn) {
    this.conn = conn; // { apiHost, username, password, companyId }
    this.jsessionid = null;
    this.csrfToken = null;
    this.csrfFetchedAt = 0;
    this.CSRF_TTL_MS = 9 * 60 * 1000; // 9 min — API server session timeout is 10 min; refresh before it expires
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

  /** Create an AbortSignal that times out after REQUEST_TIMEOUT_MS */
  _timeoutSignal() {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }

  async fetchCSRF() {
    const url = `${this._baseUrl}/User?$top=1&$select=userId`;
    const res = await fetch(url, {
      headers: {
        Authorization: this._authHeader,
        'x-csrf-token': 'Fetch',
        Accept: 'application/json',
        cookie: this.jsessionid ? `JSESSIONID=${this.jsessionid}` : '',
      },
      signal: this._timeoutSignal(),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(`[AUTH] Failed to authenticate: ${res.status}`);
    }

    const token = res.headers.get('x-csrf-token');
    if (!token) throw new Error('[AUTH] No CSRF token in response');

    // Capture JSESSIONID if present
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const h of setCookie) {
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

    const fetchOpts = {
      method: method.toUpperCase(),
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: this._timeoutSignal(),
    };

    let res = await fetch(url, fetchOpts);

    // CSRF expired mid-session — refresh and retry once
    if (res.status === 403) {
      const errText = await res.text();
      if (errText.includes('CSRF')) {
        this.csrfToken = null;
        headers['x-csrf-token'] = await this.getCSRF();
        res = await fetch(url, { ...fetchOpts, headers, signal: this._timeoutSignal() });
      } else {
        return res;
      }
    }

    // Rate limited — wait and retry
    if (res.status === 429) {
      res = await this._retryAfter429(res, url, fetchOpts);
    }

    return res;
  }

  async _retryAfter429(lastRes, url, fetchOpts) {
    let res = lastRes;
    for (let attempt = 0; attempt < MAX_429_RETRIES; attempt++) {
      const retryAfter = res.headers.get('retry-after');
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : 5;
      const waitMs = Math.min((isNaN(waitSec) ? 5 : waitSec) * 1000, 60_000);
      await new Promise(r => setTimeout(r, waitMs));
      res = await fetch(url, { ...fetchOpts, signal: this._timeoutSignal() });
      if (res.status !== 429) return res;
    }
    return res; // return last 429 if still rate-limited
  }
}
