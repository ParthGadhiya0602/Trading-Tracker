"use strict";
/**
 * Live WS feed (Approach A, open-session only). Zero dependencies - uses Node's built-in
 * `WebSocket` global provided by the required Node 24 LTS runtime. Sources come ONLY from
 * `feed.stream` (assembled from MARKET_* env variables; never read here directly -
 * the caller passes the already-loaded `feed` block).
 *
 * Exposes a StreamClient with start({feed, onTick, isOpen, log, userAgent}) / stop(),
 * exported as a shared singleton (drop-in for the old function-module API). Opens one socket
 * per configured constituent stream + the NIFTY 50 level stream, with per-socket exponential
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
// STREAM_CAPTURE=1: log the first raw frames per socket (to reveal the actual upstream
// shape) + any frame arriving while the market is closed (post-market detection).
const STREAM_CAPTURE = require("../core/utils").envFlag(process.env.STREAM_CAPTURE);

// ---- pure helpers (no instance state) ----
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

function buildUrl(feedStream, entry) {
  const q = `${encodeURIComponent(feedStream.indexParam || "index")}=${encodeURIComponent(entry.index)}`;
  return `${feedStream.wsBase}/${entry.path}?${q}`;
}

// Drop null/undefined keys so a partial tick (e.g. price only) never overwrites
// existing OHLC/volume fields with blanks when merged via Object.assign.
function prune(patch) {
  for (const k of Object.keys(patch)) {
    if (patch[k] === null || patch[k] === undefined) delete patch[k];
  }
  return patch;
}

// Normalize one raw upstream message into { index, kind, symbol?, patch } or null if it
// doesn't look like a tick we understand (never throw - callers must never crash a socket
// on a bad/unknown message).
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

// Live WS ingest: owns the socket set, reconnect backoff, and lifecycle.
class StreamClient {
  constructor() {
    this.sockets = []; // [{ key, ws, backoffMs, timer, closedByUs }]
    this.running = false;
    this.opts = null;
  }

  #scheduleReconnect(entry) {
    if (!this.running || entry.closedByUs) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.#connect(entry);
    }, entry.backoffMs);
    entry.backoffMs = Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);
  }

  #connect(entry) {
    if (!this.running || !this.opts.isOpen()) return; // only connect while the session is "open"
    let ws;
    try {
      ws = new WebSocket(entry.url, {
        headers: { Origin: entry.origin, "User-Agent": this.opts.userAgent },
      });
    } catch (e) {
      this.#logErr(entry, e);
      this.#scheduleReconnect(entry);
      return;
    }
    entry.ws = ws;
    ws.addEventListener("open", () => {
      entry.backoffMs = BASE_BACKOFF_MS; // reset on successful open
    });
    ws.addEventListener("message", (ev) => {
      try {
        if (STREAM_CAPTURE && this.opts && this.opts.log) {
          const openNow = this.opts.isOpen && this.opts.isOpen();
          if ((entry._cap = (entry._cap || 0) + 1) <= 6) {
            this.opts.log(`[stream ${entry.kind}/${entry.index}] ${String(ev.data).slice(0, 600)}`);
          } else if (!openNow && (entry._capPost = (entry._capPost || 0) + 1) <= 10) {
            this.opts.log(`[stream POST-CLOSE ${entry.kind}/${entry.index}] ${String(ev.data).slice(0, 300)}`);
          }
        }
        const tick = normalize(ev.data, entry.index, entry.kind);
        if (tick && this.opts && this.opts.onTick) this.opts.onTick(tick);
      } catch (_) {
        /* defensive: never let a bad message kill the socket */
      }
    });
    ws.addEventListener("error", (ev) => {
      this.#logErr(entry, (ev && ev.error) || ev);
    });
    ws.addEventListener("close", () => {
      entry.ws = null;
      this.#scheduleReconnect(entry);
    });
  }

  #logErr(entry, e) {
    if (this.opts && typeof this.opts.log === "function") {
      this.opts.log(`stream[${entry.key}] ${(e && e.message) || e}`);
    }
  }

  #teardown() {
    for (const entry of this.sockets) {
      entry.closedByUs = true;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.ws) {
        try {
          entry.ws.close();
        } catch (_) {}
        entry.ws = null;
      }
    }
    this.sockets = [];
  }

  // start({ feed, onTick, isOpen, log, userAgent }) - feed is the assembled market config
  // (feed.stream holds wsBase/origin/constituents/levels). Safe to call when feed.stream is
  // missing/incomplete: it simply connects nothing.
  start(o) {
    if (this.running) this.stop();
    const input = o || {};
    const stream = input.feed && input.feed.stream;
    this.opts = {
      onTick: input.onTick,
      isOpen: typeof input.isOpen === "function" ? input.isOpen : () => false,
      log: input.log,
      userAgent: input.userAgent,
    };
    this.running = true;
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
    this.sockets = entries.map((e) => ({
      ...e,
      ws: null,
      backoffMs: BASE_BACKOFF_MS,
      timer: null,
      closedByUs: false,
    }));
    for (const entry of this.sockets) this.#connect(entry);
  }

  stop() {
    this.running = false;
    this.#teardown();
    this.opts = null;
  }
}

// Shared singleton (drop-in for the old function-module API) + the class for tests/isolated instances.
const stream = new StreamClient();
stream.StreamClient = StreamClient;
module.exports = stream;
