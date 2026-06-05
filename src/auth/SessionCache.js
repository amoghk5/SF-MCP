import { ODataSession } from './ODataSession.js';

/**
 * SessionCache — one ODataSession per connection alias.
 * Sessions are created lazily and reused across tool calls.
 */
export class SessionCache {
  constructor() {
    this._odata = {}; // alias -> ODataSession
  }

  odata(alias, conn) {
    if (!this._odata[alias]) this._odata[alias] = new ODataSession(conn);
    return this._odata[alias];
  }

  invalidate(alias) {
    delete this._odata[alias];
  }

  status() {
    return {
      odataSessions: Object.keys(this._odata),
    };
  }
}

export const sessionCache = new SessionCache();
