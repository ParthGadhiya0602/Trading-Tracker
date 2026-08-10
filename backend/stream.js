"use strict";
/**
 * Live WS feed (Approach A, open-session only). Zero dependencies - uses Node's built-in
 * `WebSocket` global (Node 22+). Sources come ONLY from `feed.stream` (FEED_JSON env,
 * never read here directly - the caller passes the already-loaded `feed` block).
 *
 * Exposes start({feed, onTick, isOpen, log, userAgent}) / stop(). Opens one socket per
 * configured constituent stream + the NIFTY 50 level stream, with per-socket exponential
 * backoff (1s -> 2s -> 4s -> ... capped at 30s, reset on a successful open). Connects only
 * while isOpen() is true; stop() (or a transition away from "open") tears everything down.
 *
 * Tick schema this module normalizes into (see CLAUDE.md for the confirmed upstream shape):
 *   stock:  { index, kind:'stock', symbol, patch:{ lastPrice, open, dayHigh, dayLow,
 *             prevClose, change, pChange, totalTradedVolume, totalTradedValue, timestamp } }
 *   level:  { index, kind:'level', patch:{ last, variation, pChange, open, high, low,
 *             prevClose } }
 * Enrichment-only fields (yearHigh/yearLow/nearWKH/nearWKL/perChange30d/perChange365d/
 * companyName/totalTradedValue for level) are NOT part of the tick - callers must preserve
 * whatever REST already put there.
 */

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1000;

let sockets = []; // [{ key, ws, backoffMs, timer, closedByUs }]
let running = false;
let opts = null;

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

function buildUrl(feedStream, entry) {
  const q = `${encodeURIComponent(feedStream.indexParam || "index")}=${encodeURIComponent(entry.index)}`;
  return `${feedStream.wsBase}/${entry.path}?${q}`;
}

// Normalize one raw upstream message into { index, kind, symbol?, patch } or null if it
// doesn't look like a tick we understand (never throw - callers must never crash a socket
// on a bad/unknown message).
// Drop null/undefined keys so a partial tick (e.g. price only) never overwrites
// existing OHLC/volume fields with blanks when merged via Object.assign.
function prune(patch) {
  for (const k of Object.keys(patch)) {
    if (patch[k] === null || patch[k] === undefined) delete patch[k];
  }
  return patch;
}
function normalize(raw, index, kind) {
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!j || typeof j !== "object") return null;
    if (kind === "stock") {
      const symbol = j.symbol || j.sym;
      if (!symbol) return null;
      return {
        index,
        kind: "stock",
        symbol,
        patch: prune({
          lastPrice: num(j.ltp),
          open: num(j.open),
          dayHigh: num(j.high),
          dayLow: num(j.low),
          prevClose: num(j.close),
          change: num(j.change),
          pChange: num(j.pchange),
          totalTradedVolume: num(j.volume),
          totalTradedValue: num(j.value),
          timestamp: j.timestamp || undefined,
        }),
      };
    }
    // level tick (NIFTY 50 index-level stream)
    return {
      index,
      kind: "level",
      patch: prune({
        last: num(j.currentPrice),
        variation: num(j.change),
        pChange: num(j.perChange),
        open: num(j.open),
        high: num(j.high),
        low: num(j.low),
        prevClose: num(j.previousClose),
      }),
    };
  } catch (_) {
    return null;
  }
}

function scheduleReconnect(entry) {
  if (!running || entry.closedByUs) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    connect(entry);
  }, entry.backoffMs);
  entry.backoffMs = Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);
}

function connect(entry) {
  if (!running || !opts.isOpen()) return; // only connect while the session is "open"
  let ws;
  try {
    ws = new WebSocket(entry.url, {
      headers: { Origin: entry.origin, "User-Agent": opts.userAgent },
    });
  } catch (e) {
    logErr(entry, e);
    scheduleReconnect(entry);
    return;
  }
  entry.ws = ws;
  ws.addEventListener("open", () => {
    entry.backoffMs = BASE_BACKOFF_MS; // reset on successful open
  });
  ws.addEventListener("message", (ev) => {
    try {
      const tick = normalize(ev.data, entry.index, entry.kind);
      if (tick && opts && opts.onTick) opts.onTick(tick);
    } catch (_) {
      /* defensive: never let a bad message kill the socket */
    }
  });
  ws.addEventListener("error", (ev) => {
    logErr(entry, (ev && ev.error) || ev);
  });
  ws.addEventListener("close", () => {
    entry.ws = null;
    scheduleReconnect(entry);
  });
}

function logErr(entry, e) {
  if (opts && typeof opts.log === "function") {
    opts.log(`stream[${entry.key}] ${(e && e.message) || e}`);
  }
}

function teardown() {
  for (const entry of sockets) {
    entry.closedByUs = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.ws) {
      try {
        entry.ws.close();
      } catch (_) {}
      entry.ws = null;
    }
  }
  sockets = [];
}

// start({ feed, onTick, isOpen, log, userAgent }) - feed is the whole `feed` config block
// (feed.stream holds wsBase/origin/constituents/levels). Safe to call when feed.stream is
// missing/incomplete: it simply connects nothing.
function start(o) {
  if (running) stop();
  const input = o || {};
  const stream = input.feed && input.feed.stream;
  opts = {
    onTick: input.onTick,
    isOpen: typeof input.isOpen === "function" ? input.isOpen : () => false,
    log: input.log,
    userAgent: input.userAgent,
  };
  running = true;
  if (!stream || !stream.wsBase || !stream.constituents) return;
  const entries = [];
  for (const [dashIndex, cfg] of Object.entries(stream.constituents)) {
    if (!cfg || !cfg.path || !cfg.index) continue;
    entries.push({
      key: `${dashIndex}/constituents`,
      index: dashIndex,
      kind: "stock",
      url: buildUrl(stream, cfg),
      origin: stream.origin,
    });
  }
  if (stream.levels) {
    for (const [dashIndex, cfg] of Object.entries(stream.levels)) {
      if (!cfg || !cfg.path || !cfg.index) continue;
      entries.push({
        key: `${dashIndex}/level`,
        index: dashIndex,
        kind: "level",
        url: buildUrl(stream, cfg),
        origin: stream.origin,
      });
    }
  }
  sockets = entries.map((e) => ({
    ...e,
    ws: null,
    backoffMs: BASE_BACKOFF_MS,
    timer: null,
    closedByUs: false,
  }));
  for (const entry of sockets) connect(entry);
}

function stop() {
  running = false;
  teardown();
  opts = null;
}

module.exports = { start, stop };
