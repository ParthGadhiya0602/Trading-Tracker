"use strict";
/**
 * Live option-chain WSS transport (one socket per active chain). Zero dependencies — uses
 * Node's built-in `WebSocket` global. It is a pure transport: it opens/closes sockets by key,
 * applies per-key exponential backoff, and hands each raw parsed frame to `onTick`. All domain
 * knowledge (normalization, store merge, SSE emit) lives in the DerivativesService.
 *
 * Endpoint + headers come ONLY from the injected `config` block assembled from MARKET_* env;
 * nothing is hardcoded here. `config` = { wsBase, origin, path, symbolParam?, expiryParam? }.
 *   url = `${wsBase}/${path}?${symbolParam}=<symbol>&${expiryParam}=<providerExpiry>`
 */

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1000;

class DerivativesOptionStream {
  constructor({ config, userAgent, log } = {}) {
    this.config = config || null;
    this.userAgent = userAgent;
    this.log = typeof log === "function" ? log : () => {};
    this.sockets = new Map(); // key -> { key, url, ws, backoffMs, timer, closedByUs, onTick }
  }

  configured() {
    const c = this.config;
    return Boolean(c && c.wsBase && c.path && c.origin);
  }

  has(key) {
    return this.sockets.has(key);
  }

  #buildUrl(sub) {
    const c = this.config;
    const sp = encodeURIComponent(c.symbolParam || "symbol");
    const ep = encodeURIComponent(c.expiryParam || "expiry");
    return `${String(c.wsBase).replace(/\/$/, "")}/${c.path}?${sp}=${encodeURIComponent(sub.symbol)}&${ep}=${encodeURIComponent(sub.providerExpiry)}`;
  }

  // Open a socket for `key`. `sub` = { symbol, providerExpiry }. `onTick(rawFrame)` gets each
  // parsed JSON frame. No-op if unconfigured or already open for this key.
  open(key, sub, onTick) {
    if (!this.configured() || this.sockets.has(key)) return;
    const entry = { key, url: this.#buildUrl(sub), ws: null, backoffMs: BASE_BACKOFF_MS, timer: null, closedByUs: false, onTick };
    this.sockets.set(key, entry);
    this.#connect(entry);
  }

  #connect(entry) {
    if (entry.closedByUs || !this.sockets.has(entry.key)) return;
    let ws;
    try {
      ws = new WebSocket(entry.url, { headers: { Origin: this.config.origin, "User-Agent": this.userAgent } });
    } catch (error) {
      this.log(`optstream[${entry.key}] ${(error && error.message) || error}`);
      this.#scheduleReconnect(entry);
      return;
    }
    entry.ws = ws;
    ws.addEventListener("open", () => { entry.backoffMs = BASE_BACKOFF_MS; });
    ws.addEventListener("message", (event) => {
      try {
        let frame;
        try { frame = JSON.parse(event.data); } catch (_) { return; } // ignore non-JSON frames
        if (entry.onTick) entry.onTick(frame);
      } catch (_) {
        /* defensive: never let a bad frame kill the socket */
      }
    });
    ws.addEventListener("error", (event) => {
      this.log(`optstream[${entry.key}] ${(event && event.error && event.error.message) || "socket error"}`);
    });
    ws.addEventListener("close", () => {
      entry.ws = null;
      this.#scheduleReconnect(entry);
    });
  }

  #scheduleReconnect(entry) {
    if (entry.closedByUs || !this.sockets.has(entry.key)) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.#connect(entry);
    }, entry.backoffMs);
    entry.backoffMs = Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);
    if (entry.timer.unref) entry.timer.unref();
  }

  close(key) {
    const entry = this.sockets.get(key);
    if (!entry) return;
    entry.closedByUs = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.ws) {
      try { entry.ws.close(); } catch (_) {}
      entry.ws = null;
    }
    this.sockets.delete(key);
  }

  stop() {
    for (const key of [...this.sockets.keys()]) this.close(key);
  }
}

module.exports = { DerivativesOptionStream };
