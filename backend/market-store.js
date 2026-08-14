"use strict";
/**
 * Central market store — the single in-memory source of truth for live/last market
 * data. Everything (the /api/indices response, /api/price, alert current-price
 * enrichment, the SSE fan-out, alert evaluation) reads/derives from here instead of
 * fetching upstream or recomputing per request.
 *
 * The server owns fetching; it feeds the store via ingestSnapshot() (a full REST
 * snapshot) or applyTick() (one WS patch). The store holds no timers and does no I/O.
 *
 * `snapshot` mirrors the exact buildPayloadNext envelope keyed by index name, so it's
 * a drop-in for /api/indices and the SSE payload.
 *
 * Exported as a ready-to-use singleton so `require(...)` returns the shared instance and
 * every `store.method()` call site is unchanged. The `MarketStore` class is attached for
 * tests and for spinning up an isolated keyspace. Derivatives use the owned nested
 * `store.derivatives` scope so option-chain state cannot affect cash-market reads.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function copy(value) {
  return value == null ? value : structuredClone(value);
}

const DERIVATIVE_KEY = /^index:(NIFTY|BANKNIFTY):(\d{4}-\d{2}-\d{2})$/;
const DERIVATIVE_STATES = new Set(["loading", "live", "partial", "closed", "stale", "blocked", "rate-limited", "error"]);
const STALE_DERIVATIVE_STATES = new Set(["closed", "stale", "blocked", "rate-limited", "error"]);

function derivativeIdentity(key) {
  const match = typeof key === "string" ? DERIVATIVE_KEY.exec(key) : null;
  return match ? { key, market: "index", symbol: match[1], expiry: match[2] } : null;
}

function sourceMs(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * An owned nested scope for normalized option-chain snapshots. It deliberately does
 * not share the cash snapshot/index, so a derivative refresh cannot affect alert
 * price enrichment or SSE cash payloads.
 */
class DerivativeScope {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.entries = new Map();
  }

  #validSnapshot(snapshot) {
    const identity = derivativeIdentity(snapshot && snapshot.key);
    if (!identity || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
    if (snapshot.kind !== "option-chain" || snapshot.market !== identity.market || snapshot.symbol !== identity.symbol || snapshot.expiry !== identity.expiry) return null;
    if (!DERIVATIVE_STATES.has(snapshot.state) || !snapshot.data || typeof snapshot.data !== "object" || !Array.isArray(snapshot.data.rows) || snapshot.data.rows.length === 0) return null;
    return identity;
  }

  ingestSnapshot(snapshot) {
    const identity = this.#validSnapshot(snapshot);
    if (!identity) return null;
    const previous = this.entries.get(identity.key);
    const incomingSource = sourceMs(snapshot.sourceTimestamp);
    const previousSource = previous && sourceMs(previous.sourceTimestamp);
    if (previous) {
      if (incomingSource != null && previousSource != null && incomingSource < previousSource) return null;
      const sourceOrdersSnapshot = incomingSource != null && previousSource != null && incomingSource > previousSource;
      if (!sourceOrdersSnapshot) {
        const incomingReceived = sourceMs(snapshot.receivedAt);
        const parsedPreviousReceived = sourceMs(previous.receivedAt);
        const previousReceived = parsedPreviousReceived == null ? previous.storedAt : parsedPreviousReceived;
        if (incomingReceived == null || !Number.isFinite(previousReceived) || incomingReceived <= previousReceived) return null;
      }
    }

    const next = copy(snapshot);
    // The provider has no authority over local ordering.
    next.sequence = previous ? previous.sequence + 1 : 1;
    if (incomingSource == null && previousSource != null) next.sourceTimestamp = previous.sourceTimestamp;
    next.receivedAt = typeof next.receivedAt === "string" ? next.receivedAt : new Date(this.now()).toISOString();
    next.storedAt = this.now();
    if (STALE_DERIVATIVE_STATES.has(next.state)) next.stale = true;
    this.entries.set(identity.key, next);
    return copy(next);
  }

  setStatus(key, status) {
    const identity = derivativeIdentity(key);
    if (!identity || !status || typeof status !== "object" || Array.isArray(status)) return null;
    const previous = this.entries.get(key);
    const requestedState = status.state;
    if (!DERIVATIVE_STATES.has(requestedState) || requestedState === "live" || requestedState === "partial") return null;

    const next = previous ? copy(previous) : {
      kind: "option-chain",
      ...identity,
      data: null,
      sourceTimestamp: null,
      receivedAt: null,
      sequence: 0,
      storedAt: this.now(),
    };
    // Status changes never replace market data or provider/local ordering fields.
    for (const [name, value] of Object.entries(status)) {
      if (!["key", "market", "symbol", "expiry", "kind", "data", "sequence", "sourceTimestamp", "receivedAt", "storedAt"].includes(name)) next[name] = copy(value);
    }
    next.state = requestedState;
    if (STALE_DERIVATIVE_STATES.has(requestedState)) next.stale = true;
    next.statusAt = this.now();
    this.entries.set(key, next);
    return copy(next);
  }

  getSnapshot(key) {
    if (typeof key === "undefined") {
      return Object.fromEntries([...this.entries].map(([entryKey, value]) => [entryKey, copy(value)]));
    }
    return this.entries.has(key) ? copy(this.entries.get(key)) : null;
  }

  hasData(key) {
    const entry = this.entries.get(key);
    return Boolean(entry && entry.data && Array.isArray(entry.data.rows) && entry.data.rows.length);
  }

  isFresh(key, maxMs) {
    const entry = this.entries.get(key);
    const storedAt = entry && entry.storedAt;
    return Number.isFinite(storedAt) && Number(maxMs) > 0 && this.now() - storedAt < Number(maxMs);
  }

  stamp(key) {
    const entry = this.entries.get(key);
    return entry && Number.isFinite(entry.storedAt) ? entry.storedAt : 0;
  }
}

class MarketStore {
  constructor(options = {}) {
    // { [indexName]: { level, advance, data:[…rows], marketStatus, timestamp, source } }
    this.snapshot = {};
    this.bySymbol = new Map(); // symbol -> latest row (deduped across indices)
    this.stampMs = 0;
    this.derivatives = new DerivativeScope({ now: options.now || Date.now });
  }

  #rebuildIndex() {
    this.bySymbol.clear();
    for (const name of Object.keys(this.snapshot)) {
      for (const row of (this.snapshot[name] && this.snapshot[name].data) || []) {
        if (row && row.symbol) this.bySymbol.set(row.symbol, row);
      }
    }
  }

  // Full snapshot from a REST fetch (all indices). Replaces the previous state.
  ingestSnapshot(payload) {
    if (!payload || typeof payload !== "object") return;
    this.snapshot = payload;
    this.#rebuildIndex();
    this.stampMs = Date.now();
  }

  // One normalized WS tick: { index, kind:'stock'|'level', symbol?, patch }.
  // Merges into the existing snapshot, preserving REST-only enrichment fields.
  applyTick(t) {
    if (!t || !t.index || !this.snapshot[t.index]) return;
    const entry = this.snapshot[t.index];
    if (t.kind === "stock" && t.symbol) {
      const rows = entry.data || (entry.data = []);
      const row = rows.find((r) => r.symbol === t.symbol);
      if (!row) return; // unknown symbol - constituent list is REST-owned
      Object.assign(row, t.patch);
      this.bySymbol.set(t.symbol, row);
    } else if (t.kind === "level") {
      entry.level = Object.assign(entry.level || {}, t.patch);
    } else {
      return;
    }
    entry.timestamp = Date.now();
    this.stampMs = Date.now();
  }

  // ---- reads ----
  getSnapshot() {
    return this.snapshot;
  }
  hasData() {
    return Object.keys(this.snapshot).length > 0;
  }
  getIndex(name) {
    return this.snapshot[name] || null;
  }
  getStock(symbol) {
    return this.bySymbol.get(symbol) || null;
  }
  getPrice(symbol) {
    const row = this.bySymbol.get(symbol);
    return row && row.lastPrice != null ? row.lastPrice : null;
  }
  isFresh(maxMs) {
    return this.stampMs > 0 && Date.now() - this.stampMs < maxMs;
  }
  stamp() {
    return this.stampMs;
  }

  // ---- derive (computed on read) ----
  // Add the live price to a list of alerts (or any {symbol} objects).
  enrichAlerts(list) {
    return (list || []).map((a) => ({ ...a, currentPrice: this.getPrice(a.symbol) }));
  }
  #topBy(index, key, dir, n) {
    const idx = this.snapshot[index];
    if (!idx) return [];
    return (idx.data || [])
      .filter((r) => r && r.symbol)
      .slice()
      .sort((a, b) => dir * ((num(b[key]) || 0) - (num(a[key]) || 0)))
      .slice(0, n);
  }
  gainers(index, n = 5) {
    return this.#topBy(index, "pChange", 1, n).filter((r) => (num(r.pChange) || 0) > 0);
  }
  losers(index, n = 5) {
    return this.#topBy(index, "pChange", -1, n).filter((r) => (num(r.pChange) || 0) < 0);
  }
  mostActive(index, n = 5) {
    return this.#topBy(index, "totalTradedVolume", 1, n);
  }
}

// Shared singleton (drop-in for the old function-module API) + the class for tests/isolated stores.
const store = new MarketStore();
store.MarketStore = MarketStore;
store.DerivativeScope = DerivativeScope;
module.exports = store;
