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
 */

let snapshot = {}; // { [indexName]: { level, advance, data:[…rows], marketStatus, timestamp, source } }
const bySymbol = new Map(); // symbol -> latest row (deduped across indices)
let stampMs = 0;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rebuildIndex() {
  bySymbol.clear();
  for (const name of Object.keys(snapshot)) {
    for (const row of (snapshot[name] && snapshot[name].data) || []) {
      if (row && row.symbol) bySymbol.set(row.symbol, row);
    }
  }
}

// Full snapshot from a REST fetch (all indices). Replaces the previous state.
function ingestSnapshot(payload) {
  if (!payload || typeof payload !== "object") return;
  snapshot = payload;
  rebuildIndex();
  stampMs = Date.now();
}

// One normalized WS tick: { index, kind:'stock'|'level', symbol?, patch }.
// Merges into the existing snapshot, preserving REST-only enrichment fields.
function applyTick(t) {
  if (!t || !t.index || !snapshot[t.index]) return;
  const entry = snapshot[t.index];
  if (t.kind === "stock" && t.symbol) {
    const rows = entry.data || (entry.data = []);
    const row = rows.find((r) => r.symbol === t.symbol);
    if (!row) return; // unknown symbol - constituent list is REST-owned
    Object.assign(row, t.patch);
    bySymbol.set(t.symbol, row);
  } else if (t.kind === "level") {
    entry.level = Object.assign(entry.level || {}, t.patch);
  } else {
    return;
  }
  entry.timestamp = Date.now();
  stampMs = Date.now();
}

// ---- reads ----
function getSnapshot() {
  return snapshot;
}
function hasData() {
  return Object.keys(snapshot).length > 0;
}
function getIndex(name) {
  return snapshot[name] || null;
}
function getStock(symbol) {
  return bySymbol.get(symbol) || null;
}
function getPrice(symbol) {
  const row = bySymbol.get(symbol);
  return row && row.lastPrice != null ? row.lastPrice : null;
}
function isFresh(maxMs) {
  return stampMs > 0 && Date.now() - stampMs < maxMs;
}
function stamp() {
  return stampMs;
}

// ---- derive (computed on read) ----
// Add the live price to a list of alerts (or any {symbol} objects).
function enrichAlerts(list) {
  return (list || []).map((a) => ({ ...a, currentPrice: getPrice(a.symbol) }));
}
function topBy(index, key, dir, n) {
  const idx = snapshot[index];
  if (!idx) return [];
  return (idx.data || [])
    .filter((r) => r && r.symbol)
    .slice()
    .sort((a, b) => dir * ((num(b[key]) || 0) - (num(a[key]) || 0)))
    .slice(0, n);
}
function gainers(index, n = 5) {
  return topBy(index, "pChange", 1, n).filter((r) => (num(r.pChange) || 0) > 0);
}
function losers(index, n = 5) {
  return topBy(index, "pChange", -1, n).filter((r) => (num(r.pChange) || 0) < 0);
}
function mostActive(index, n = 5) {
  return topBy(index, "totalTradedVolume", 1, n);
}

module.exports = {
  ingestSnapshot,
  applyTick,
  getSnapshot,
  hasData,
  getIndex,
  getStock,
  getPrice,
  isFresh,
  stamp,
  enrichAlerts,
  gainers,
  losers,
  mostActive,
};
