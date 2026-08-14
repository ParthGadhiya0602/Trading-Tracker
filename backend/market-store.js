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
 * tests and for spinning up an isolated keyspace (e.g. a separate derivatives store).
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

class MarketStore {
  constructor() {
    // { [indexName]: { level, advance, data:[…rows], marketStatus, timestamp, source } }
    this.snapshot = {};
    this.bySymbol = new Map(); // symbol -> latest row (deduped across indices)
    this.stampMs = 0;
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
module.exports = store;
