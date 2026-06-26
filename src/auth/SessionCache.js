import { ODataSession } from './ODataSession.js';
import { IASSession } from './IASSession.js';

/**
 * SessionCache — one ODataSession and/or one IASSession per connection alias.
 * Sessions are created lazily and reused across tool calls.
 */
export class SessionCache {
  constructor() {
    this._odata = {}; // alias -> ODataSession
    this._ias = {}; // alias -> IASSession
  }

  odata(alias, conn) {
    if (!this._odata[alias]) this._odata[alias] = new ODataSession(conn);
    return this._odata[alias];
  }

  ias(alias, ias) {
    if (!this._ias[alias]) this._ias[alias] = new IASSession(ias);
    return this._ias[alias];
  }

  invalidate(alias) {
    delete this._odata[alias];
    delete this._ias[alias];
  }

  invalidateIas(alias) {
    delete this._ias[alias];
  }

  status() {
    return {
      odataSessions: Object.keys(this._odata),
      iasSessions: Object.keys(this._ias),
    };
  }
}

export const sessionCache = new SessionCache();
