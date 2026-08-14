#!/usr/bin/env node
/**
 * Trading Tracker - market proxy, application APIs, and static server.
 *
 * Why this exists: the data source's API can't be called directly from a browser.
 * CORS forbids the required headers, and its anti-bot layer 403s/hangs any request
 * without a *warm session* - anti-bot cookies (ak_bmsc, _abck, ...) + browser-like
 * headers. A browser cannot set those cross-origin, so this is a tiny Node server:
 * it warms an upstream session, then re-serves the JSON to our page from the SAME
 * origin (localhost). No CORS, no public proxy, live data. Endpoints come from
 * the FEED_JSON env var (the `feed` block as one-line JSON).
 *
 * Feed transport uses the Node 24 LTS built-in fetch and a hand-rolled cookie jar.
 * Mongo-backed persistence uses the declared `mongodb` package when configured.
 *
 *   Run:   node server.js
 *   Open:  http://localhost:8787/
 *
 * Endpoints:  GET /  -> index.html   |   GET /api/indices -> live index JSON,
 *   keyed by index name.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const alerts = require("./alerts");
const auth = require("./auth");
const stream = require("./stream");
const telegram = require("./telegram");
const llm = require("./llm");
const trades = require("./trades");
const store = require("./market-store"); // single in-memory source of truth for market data
const { createNseDerivatives } = require("./nse-derivatives");
const { DerivativesError, DerivativesService } = require("./derivatives");
const { logInfo, logWarn } = require("./logger");
const { istNow, envFlag } = require("./utils");
const {
  ACTION,
  authorize,
  eligibleAlertCreators,
  resolveAlertCreator,
} = require("./alert-policy");

// Bind address: localhost by default (safe for tunnels / same-box reverse proxy).
// Set HOST=0.0.0.0 to accept external connections directly (e.g. an EC2 security group).
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const HERE = __dirname;

// Data-source endpoints come from the FEED_JSON env var (the feed block as one-line
// JSON) - not hardcoded, not in the repo. Shape: { base, indicesEndpoint,
// preopenEndpoint, referer, warmupPaths:[], stream? } (see .env.sample).
function loadFeedConfig() {
  if (!process.env.FEED_JSON) return null;
  try {
    const f = JSON.parse(process.env.FEED_JSON);
    if (f && f.base && f.indicesEndpoint) return f;
  } catch (_) {}
  return null;
}
const FEED = loadFeedConfig();
const BASE = FEED ? FEED.base : null;
const DERIVATIVES_ENABLED = envFlag(process.env.DERIVATIVES_ENABLED);
function requireFeed() {
  if (!FEED)
    throw new Error(
      "data source not configured - set the FEED_JSON env var (see .env.sample)",
    );
}
// Live WS feed is opt-in (STREAM_WS env). When the flag is set but `feed.stream` (or its
// required sub-keys) is missing, we warn and continue in pure-REST mode - never crash.
function requireStream() {
  if (!process.env.STREAM_WS) return null;
  const s = FEED && FEED.stream;
  if (!s || !s.wsBase || !s.constituents) {
    logWarn(
      "stream",
      "STREAM_WS is set but `feed.stream` is missing/incomplete in FEED_JSON " +
        "(see .env.sample) - continuing in pure-REST mode.",
    );
    return null;
  }
  return s;
}
// One call per index returns everything we need (index level + all constituents +
// advance-decline + marketStatus). endpoint/query come from FEED_JSON.
const INDEX_URL = (name) =>
  `${BASE}${FEED.indicesEndpoint}${encodeURIComponent(name)}`;
// Indices shown on the dashboard = the shared list from alerts.js (single source of
// truth; drives dashboard tabs, alert index picker, and the daily symbol cache).
const DASH_INDICES = alerts.INDICES;
const FEED_REF = FEED && FEED.referer ? `${BASE}${FEED.referer}` : null;
const SESSION_TTL = 600_000; // rewarm every 10 min

// Rotating UA pool: avoids trivially-cached deny rules tied to a single UA
// string. (Not a fingerprint bypass, just polite + helps.)
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];

function headers(uaIndex = 0) {
  return {
    "User-Agent": USER_AGENTS[uaIndex % USER_AGENTS.length],
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: BASE ? `${BASE}/` : undefined,
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "sec-ch-ua":
      '"Not.A/Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  };
}

// ---- minimal cookie jar (name -> value); we only need to echo cookies back ----
let jar = new Map();
let warmedAt = 0;
let warming = null; // in-flight warm promise, so concurrent requests share one warmup
let warmingKind = null;

class SourceTrafficCoordinator {
  constructor({ now = Date.now, random = Math.random, sleep = null } = {}) {
    this.now = now;
    this.random = random;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.closed = false;
    this.cashFlows = 0;
    this.cashPending = 0;
    this.cashInFlight = 0;
    this.derivativeInFlight = 0;
    this.sourceBlockedUntil = 0;
    this.derivativeBlockedUntil = 0;
    this.blockStreak = 0;
    this.counters = {
      total: 0,
      cash: 0,
      derivatives: 0,
      warmups: 0,
      blocks: 0,
      lastRequestAt: null,
      lastSuccessAt: null,
    };
  }

  async runCash(task, { warmup = false } = {}) {
    if (this.closed) throw new Error("source traffic coordinator is closed");
    let admitted = false;
    this.cashPending += 1;
    try {
      const waitMs = Math.max(0, this.sourceBlockedUntil - this.now());
      if (waitMs) await this.sleep(waitMs);
      if (this.closed) throw new Error("source traffic coordinator is closed");
      this.cashPending -= 1;
      admitted = true;
      this.cashInFlight += 1;
      this.#recordAttempt("cash", warmup);
      try {
        return await task();
      } finally {
        this.cashInFlight -= 1;
      }
    } finally {
      if (!admitted) this.cashPending -= 1;
    }
  }

  async withCashPriority(task) {
    if (this.closed) throw new Error("source traffic coordinator is closed");
    this.cashFlows += 1;
    try {
      return await task();
    } finally {
      this.cashFlows -= 1;
    }
  }

  async runDerivative(task, { warmup = false } = {}) {
    const now = this.now();
    if (this.closed) {
      throw new DerivativesError("SOURCE_CLOSED", "source traffic coordinator is closed");
    }
    if (this.cashFlows > 0 || this.cashPending > 0 || this.cashInFlight > 0) {
      throw new DerivativesError("SOURCE_BUSY", "cash market traffic has priority", {
        retryAfter: new Date(now + 1000).toUTCString(),
      });
    }
    const blockedUntil = Math.max(this.sourceBlockedUntil, this.derivativeBlockedUntil);
    if (blockedUntil > now) {
      throw new DerivativesError("SOURCE_BLOCKED", "upstream source is cooling down", {
        retryAfter: new Date(blockedUntil).toUTCString(),
      });
    }
    if (this.derivativeInFlight >= 2) {
      throw new DerivativesError("SOURCE_BUSY", "derivative request concurrency reached", {
        retryAfter: new Date(now + 1000).toUTCString(),
      });
    }
    this.derivativeInFlight += 1;
    this.#recordAttempt("derivative", warmup);
    try {
      return await task();
    } finally {
      this.derivativeInFlight -= 1;
    }
  }

  observeResponse(kind, response) {
    if (!response || typeof response.status !== "number") return response;
    const now = this.now();
    if (response.status === 401 || response.status === 403) {
      this.blockStreak += 1;
      this.counters.blocks += 1;
      this.sourceBlockedUntil = Math.max(this.sourceBlockedUntil, now + 1000);
      const derivativeBackoff = Math.min(300_000, 5000 * 2 ** (this.blockStreak - 1));
      const jitter = Math.floor(this.random() * Math.min(1000, derivativeBackoff * 0.1));
      this.derivativeBlockedUntil = Math.max(
        this.derivativeBlockedUntil,
        now + derivativeBackoff + jitter,
      );
    } else if (response.status >= 200 && response.status < 300) {
      this.blockStreak = 0;
      this.sourceBlockedUntil = 0;
      this.derivativeBlockedUntil = 0;
      this.counters.lastSuccessAt = new Date(now).toISOString();
    }
    return response;
  }

  status() {
    return {
      ...this.counters,
      cashFlows: this.cashFlows,
      cashPending: this.cashPending,
      cashInFlight: this.cashInFlight,
      derivativeInFlight: this.derivativeInFlight,
      blockedUntil: this.sourceBlockedUntil
        ? new Date(this.sourceBlockedUntil).toISOString()
        : null,
      derivativeCooldownUntil: this.derivativeBlockedUntil
        ? new Date(this.derivativeBlockedUntil).toISOString()
        : null,
    };
  }

  close() {
    this.closed = true;
  }

  #recordAttempt(kind, warmup) {
    this.counters.total += 1;
    this.counters[kind === "cash" ? "cash" : "derivatives"] += 1;
    if (warmup) this.counters.warmups += 1;
    this.counters.lastRequestAt = new Date(this.now()).toISOString();
  }
}

const sourceTraffic = new SourceTrafficCoordinator();

function storeCookies(res) {
  // Node 24 exposes getSetCookie(); retain the folded-header fallback for defensive parsing.
  const list =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
  for (const line of list) {
    const first = line.split(";", 1)[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}
function cookieHeader() {
  let value = "";
  for (const [name, cookie] of jar) {
    if (value) value += "; ";
    value += `${name}=${cookie}`;
  }
  return value;
}

async function srcGet(url, uaIndex, timeoutMs = 15000, referer = null) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const h = headers(uaIndex);
    if (referer) h.Referer = referer;
    const ck = cookieHeader();
    if (ck) h.Cookie = ck;
    const res = await fetch(url, {
      headers: h,
      redirect: "follow",
      signal: ac.signal,
    });
    storeCookies(res);
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function warm(uaIndex = 0, kind = "cash") {
  requireFeed();
  jar = new Map();
  // Hit each configured warmup path in order to accumulate the anti-bot cookies
  // (homepage first, then a page that sets the session cookies /api/* needs).
  const paths = Array.isArray(FEED.warmupPaths) ? FEED.warmupPaths : ["/"];
  for (const p of paths) {
    const response = await sourceTraffic[
      kind === "derivative" ? "runDerivative" : "runCash"
    ](() => srcGet(`${BASE}${p}`, uaIndex, 10000), { warmup: true });
    sourceTraffic.observeResponse(kind, response);
    await response.text();
    await new Promise((r) => setTimeout(r, 300));
  }
  warmedAt = Date.now();
}

async function ensureWarm(uaIndex, kind = "cash") {
  if (jar.size && Date.now() - warmedAt <= SESSION_TTL) return;
  if (!warming) {
    warmingKind = kind;
    warming = warm(uaIndex, kind).finally(() => {
      warming = null;
      warmingKind = null;
    });
  }
  const ownerKind = warmingKind;
  try {
    await warming;
  } catch (error) {
    // If a derivative-triggered warm yielded to newly pending cash traffic, let the
    // cash caller immediately own the shared warm mutex instead of spending one of
    // its JSON retry attempts on the derivative admission failure.
    if (kind !== "cash" || ownerKind !== "derivative") throw error;
    if (!warming) {
      warmingKind = "cash";
      warming = warm(uaIndex, "cash").finally(() => {
        warming = null;
        warmingKind = null;
      });
    }
    await warming;
  }
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

// GET one data-source path (with warm session, rewarm-on-block, backoff). Returns JSON.
async function srcJson(url, retries = 2) {
  return sourceTraffic.withCashPriority(() => srcJsonWithRetries(url, retries));
}

async function srcJsonWithRetries(url, retries) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt)
      await new Promise((r) => setTimeout(r, 2 ** (attempt - 1) * 1000));
    try {
      await ensureWarm(attempt, "cash");
      const res = sourceTraffic.observeResponse(
        "cash",
        await sourceTraffic.runCash(() => srcGet(url, attempt, 15000, FEED_REF)),
      );
      if (res.status === 401 || res.status === 403) {
        last = `HTTP ${res.status} (anti-bot block)`;
        jar = new Map();
        warmedAt = 0; // force fresh warm next attempt
        continue;
      }
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        jar = new Map();
        warmedAt = 0;
        continue;
      }
      return await res.json();
    } catch (e) {
      last =
        e && e.name === "AbortError"
          ? "timeout"
          : String((e && e.message) || e);
      jar = new Map();
      warmedAt = 0;
    }
  }
  throw new Error(`data fetch failed: ${last}`);
}

async function derivativeResponse(request) {
  await ensureWarm(0, "derivative");
  const referer = request && request.referer
    ? new URL(request.referer, BASE).toString()
    : FEED_REF;
  const response = sourceTraffic.observeResponse(
    "derivative",
    await sourceTraffic.runDerivative(() =>
      srcGet(request.url, 0, 15000, referer),
    ),
  );
  if (response.status === 401 || response.status === 403) {
    jar = new Map();
    warmedAt = 0;
  }
  return response;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istTradingDate(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function nextDerivativeOpenDelayMs(nowMs = Date.now()) {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = ist.getUTCDate();
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = Date.UTC(year, month, day + offset, 3, 45);
    const weekday = new Date(candidate + IST_OFFSET_MS).getUTCDay();
    if (weekday === 0 || weekday === 6 || candidate <= nowMs) continue;
    return Math.max(1000, candidate - nowMs);
  }
  return 24 * 60 * 60 * 1000;
}

let derivativesService = null;

function createDerivativesRuntime() {
  if (!DERIVATIVES_ENABLED) return null;
  if (!FEED || !FEED.derivatives) {
    throw new Error(
      "derivatives are enabled but FEED_JSON.derivatives is missing (see .env.sample)",
    );
  }
  const provider = createNseDerivatives({
    base: BASE,
    config: FEED.derivatives,
    fetchResponse: derivativeResponse,
  });
  return new DerivativesService({
    provider,
    store,
    isMarketOpen: () => marketState() === "open",
    nextOpenDelayMs: () => nextDerivativeOpenDelayMs(),
    tradingDate: () => istTradingDate(),
    sourceStatus: () => sourceTraffic.status(),
    onUpdate: (snapshot, type) => scheduleDerivativeFanout(snapshot.key, type),
    config: {
      refreshMs:
        Math.max(3, Number(process.env.DERIVATIVES_POLL_SECONDS) || 5) * 1000,
      graceMs:
        Math.max(0, Number(process.env.DERIVATIVES_IDLE_GRACE_SECONDS) || 60) *
        1000,
      chainBudget: Math.max(
        1,
        Number(process.env.DERIVATIVES_REQUEST_BUDGET_PER_MINUTE) || 24,
      ),
      metadataBudget: 4,
      maxActiveKeys: 2,
      maxCalls: 2,
    },
  });
}

// ---- index API: full constituents + open + level + advance/decline + status ----
function marketStatusStr(ms) {
  if (!ms) return null;
  if (typeof ms === "string") return ms;
  if (Array.isArray(ms)) return (ms[0] && ms[0].marketStatus) || null;
  return ms.marketStatus || ms.status || null;
}
function buildPayloadNext(rows, level, advance, stamp, status) {
  const data = rows.map((r) => ({
    symbol: r.symbol,
    companyName: r.companyName || null,
    open: num(r.open),
    dayHigh: num(r.dayHigh),
    dayLow: num(r.dayLow),
    lastPrice: num(r.lastPrice),
    prevClose: num(r.previousClose),
    change: num(r.change),
    pChange: num(r.pChange),
    totalTradedVolume: num(r.totalTradedVolume),
    totalTradedValue: num(r.totalTradedValue), // turnover (₹)
    yearHigh: num(r.yearHigh),
    yearLow: num(r.yearLow),
    nearWKH: num(r.nearWKH), // % from 52-week high
    nearWKL: num(r.nearWKL), // % from 52-week low
    perChange30d: num(r.perChange30d),
    perChange365d: num(r.perChange365d),
  }));
  return {
    source: "live",
    timestamp: stamp,
    marketStatus: status,
    marketDataLive: data.length > 0,
    level: level && level.last != null ? level : null,
    advance,
    data,
  };
}
async function fetchIndexNext(name) {
  requireFeed();
  const j = await srcJson(INDEX_URL(name));
  const d = (j && j.data) || {};
  const rows = Array.isArray(d.data) ? d.data : [];
  const idx = rows.find((r) => r.symbol === name) || {};
  const stocks = rows.filter((r) => r.symbol && r.symbol !== name);
  if (!stocks.length && !(num(idx.lastPrice) > 0))
    throw new Error(`no data for ${name}`);
  const level = {
    last: num(idx.lastPrice),
    variation: num(idx.change),
    pChange: num(idx.pChange),
    open: num(idx.open),
    high: num(idx.dayHigh),
    low: num(idx.dayLow),
    prevClose: num(idx.previousClose),
    yearHigh: num(idx.yearHigh),
    yearLow: num(idx.yearLow),
    perChange30d: num(idx.perChange30d),
    perChange365d: num(idx.perChange365d),
  };
  const a = d.aduCount || {};
  const advance = {
    advances: num(a.advances) || 0,
    declines: num(a.declines) || 0,
    unchanged: num(a.unchange) || 0,
  };
  const stamp = idx.lastUpdateTime || d.timestamp || null;
  return buildPayloadNext(
    stocks,
    level,
    advance,
    stamp,
    marketStatusStr(d.marketStatus),
  );
}
// Fetch all dashboard indices (one API call each, in parallel).
async function fetchAllIndices() {
  const payloads = await Promise.all(
    DASH_INDICES.map((n) => fetchIndexNext(n)),
  );
  const out = {};
  DASH_INDICES.forEach((name, i) => (out[name] = payloads[i]));
  return out;
}

// Pre-open session (09:00-09:15): ONE key=ALL fetch, filtered into each dashboard index by
// its cached symbol list. IEP (indicative equilibrium price) becomes open=high=low=lastPrice
// so the dashboard renders the pre-open indicative move vs prev close. Same payload shape as
// fetchAllIndices so /api/indices can serve it transparently.
async function fetchPreopen() {
  requireFeed();
  if (!FEED.preopenEndpoint)
    throw new Error("pre-open endpoint not configured");
  const j = await srcJson(`${BASE}${FEED.preopenEndpoint}ALL`);
  const rows = (j && j.data) || [];
  const bySym = new Map();
  for (const r of rows) {
    const m = r && r.metadata;
    if (m && m.symbol)
      bySym.set(m.symbol, {
        metadata: m,
        pom: (r.detail && r.detail.preOpenMarket) || null,
      });
  }
  const stamp = (j && j.timestamp) || null;
  const out = {};
  for (const index of DASH_INDICES) {
    const syms = alerts.symbols()[index] || [];
    const data = [];
    let advances = 0;
    let declines = 0;
    let unchanged = 0;
    for (const sym of syms) {
      const entry = bySym.get(sym);
      if (!entry) continue;
      const m = entry.metadata;
      const iep = num(m.iep);
      const change = num(m.change);
      if (change > 0) advances++;
      else if (change < 0) declines++;
      else unchanged++;
      const row = {
        symbol: sym,
        companyName: null,
        open: iep,
        dayHigh: iep,
        dayLow: iep,
        lastPrice: iep,
        prevClose: num(m.previousClose),
        change,
        pChange: num(m.pChange),
        totalTradedVolume: num(m.finalQuantity),
        totalTradedValue: num(m.totalTurnover),
        yearHigh: num(m.yearHigh),
        yearLow: num(m.yearLow),
        nearWKH: null,
        nearWKL: null,
        perChange30d: null,
        perChange365d: null,
      };
      const pom = entry.pom;
      if (pom && Array.isArray(pom.preopen)) {
        const ato = pom.ato || {};
        row.preOpen = {
          iep: num(pom.IEP) != null ? num(pom.IEP) : num(pom.finalPrice),
          ladder: pom.preopen.map((lvl) => ({
            price: num(lvl.price),
            buyQty: num(lvl.buyQty),
            sellQty: num(lvl.sellQty),
            iep: !!lvl.iep,
          })),
          totalBuyQty: num(pom.totalBuyQuantity),
          totalSellQty: num(pom.totalSellQuantity),
          ato: {
            buyQty:
              num(pom.atoBuyQty) != null
                ? num(pom.atoBuyQty)
                : num(ato.totalBuyQuantity),
            sellQty:
              num(pom.atoSellQty) != null
                ? num(pom.atoSellQty)
                : num(ato.totalSellQuantity),
          },
          finalQty: num(pom.finalQuantity),
          lastUpdateTime: pom.lastUpdateTime || null,
        };
      }
      data.push(row);
    }
    out[index] = {
      source: "live",
      timestamp: stamp,
      marketStatus: "Pre-open",
      marketDataLive: data.length > 0,
      level: null,
      advance: { advances, declines, unchanged },
      data,
    };
  }
  return out;
}
// dashboard/alert data for the current market state (pre-open uses the pre-open feed)
async function fetchMarketData() {
  return marketState() === "pre-open" ? fetchPreopen() : fetchAllIndices();
}

// ---------------- market-status capture (opt-in via MARKET_CAPTURE=1) ----------------
// Polls the raw upstream across the whole day (incl. post-close) and logs every
// marketStatus transition to logs/market-capture-<IST-date>.jsonl, saving a full
// raw sample the first time each status is seen. Purpose: document the post-market
// (15:30-16:15) structure so marketState() can gain a proper post-market bucket.
const MARKET_CAPTURE = envFlag(process.env.MARKET_CAPTURE);
const CAPTURE_DIR = path.join(HERE, "..", "logs");
const captureSeen = new Set(); // `${date}:${scope}:${status}` -> raw already saved
const lastStatusByScope = {}; // scope -> last logged status (transition detection)
function captureFile() {
  return path.join(CAPTURE_DIR, `market-capture-${istNow().slice(0, 10)}.jsonl`);
}
async function recordCapture(scope, marketStatus, timestamp, raw) {
  const prev = lastStatusByScope[scope];
  if (prev === marketStatus) return; // only write on a transition
  lastStatusByScope[scope] = marketStatus;
  const key = `${istNow().slice(0, 10)}:${scope}:${marketStatus}`;
  const first = !captureSeen.has(key);
  if (first) captureSeen.add(key);
  const line = { at: istNow(), scope, ourState: marketState(), marketStatus, timestamp };
  if (first) line.raw = raw; // full structure the first time this status appears
  try {
    // async fs so a large raw-sample write never blocks the event loop
    await fs.promises.mkdir(CAPTURE_DIR, { recursive: true });
    await fs.promises.appendFile(captureFile(), JSON.stringify(line) + "\n");
  } catch (e) {
    logWarn("capture.write", (e && e.message) || e);
  }
  logInfo("capture", `${scope}: ${prev || "(start)"} -> ${marketStatus} (ourState=${marketState()})${first ? " [raw saved]" : ""}`);
}
async function captureTick() {
  try {
    if (marketState() === "pre-open" && FEED.preopenEndpoint) {
      const j = await srcJson(`${BASE}${FEED.preopenEndpoint}ALL`);
      await recordCapture("preopen", "Pre-open", (j && j.timestamp) || null, j);
    }
    const j = await srcJson(INDEX_URL("NIFTY 50"));
    const d = (j && j.data) || {};
    await recordCapture("indices", marketStatusStr(d.marketStatus), d.timestamp || null, j);
  } catch (e) {
    logWarn("capture.tick", (e && e.message) || e);
  }
}

// ---------------- market state (IST, Mon-Fri): pre-open 09:00-09:15,
// open 09:15-15:30, otherwise closed ---------------------------------------
function marketState(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const o = {};
  f.formatToParts(d).forEach((p) => (o[p.type] = p.value));
  if (o.weekday === "Sat" || o.weekday === "Sun") return "closed";
  const mins = (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10);
  if (mins >= 9 * 60 && mins < 9 * 60 + 15) return "pre-open";
  if (mins >= 9 * 60 + 15 && mins < 15 * 60 + 30) return "open";
  return "closed";
}
// ---------------- live WS feed (opt-in via STREAM_WS; open session only) ----------------
// When unset, every path below is bypassed - getMarketData() delegates straight through to
// fetchMarketData(), byte-for-byte today's behaviour. This is the safety guarantee.
const STREAM_WS = envFlag(process.env.STREAM_WS);
const STALE_MAX_MS = 15_000; // store considered stale after this (WS reseed / fallback)
const SLOW_REFRESH_MS = 15_000; // REST reseed cadence while the WS feed is driving the store (covers fields not carried by a WS tick)
const FANOUT_MIN_MS = 150; // coalesce bursts of WS ticks into at most one SSE frame per this window
const STORE_REFRESH_MS = Math.max(1, Number(process.env.STORE_REFRESH_SECONDS) || 3) * 1000; // background REST refresh cadence (market hours)
// The market snapshot lives in the central store (backend/market-store.js).
// seedLiveCache/applyTick delegate to it so existing call sites keep working.
function seedLiveCache(payload) {
  store.ingestSnapshot(payload);
}
function applyTick(t) {
  store.applyTick(t);
}
// SSE fan-out for /api/stream (only ever populated when STREAM_WS is on - the endpoint
// itself 404s otherwise, so nothing subscribes).
const sseClients = new Set();
const derivativeSseClients = new Map(); // key -> Set<{ res, release, heartbeat }>
const stateSseClients = new Set(); // { res, userId }
const stateChanges = [];
let stateRevision = 0;
function sseWrite(res, chunk) {
  try {
    if (res.writableEnded) {
      sseClients.delete(res);
      return;
    }
    res.write(chunk);
  } catch (_) {
    sseClients.delete(res);
  }
}
// Event-driven SSE fan-out: relay the store snapshot to subscribers as soon as a tick
// (or REST reseed) changes it, coalescing bursts to one frame per FANOUT_MIN_MS so a
// flood of ticks can't spam the socket. Replaces the old fixed-interval push, which
// added up to its interval of latency to every update.
let fanoutTimer = null;
let lastFanoutMs = 0;
function fanoutNow() {
  fanoutTimer = null;
  lastFanoutMs = Date.now();
  if (!(STREAM_WS && marketState() === "open" && sseClients.size > 0)) return;
  const chunk = `event: patch\ndata: ${JSON.stringify(store.getSnapshot())}\n\n`;
  for (const client of sseClients) sseWrite(client, chunk);
}
function scheduleFanout() {
  if (fanoutTimer) return;
  const since = Date.now() - lastFanoutMs;
  const wait = since >= FANOUT_MIN_MS ? 0 : FANOUT_MIN_MS - since;
  fanoutTimer = setTimeout(fanoutNow, wait);
  if (fanoutTimer.unref) fanoutTimer.unref();
}

let derivativeFanoutTimer = null;
let derivativeLastFanoutMs = 0;
const derivativePendingUpdates = new Map();
function derivativeSseWrite(client, chunk) {
  try {
    if (client.res.writableEnded) return false;
    client.res.write(chunk);
    return true;
  } catch (_) {
    return false;
  }
}
function removeDerivativeClient(key, client) {
  const clients = derivativeSseClients.get(key);
  if (!clients || !clients.delete(client)) return;
  if (client.heartbeat) clearInterval(client.heartbeat);
  client.release();
  if (!clients.size) derivativeSseClients.delete(key);
}
function derivativeEvent(snapshot, type) {
  const event = type === "status" ? "status" : "snapshot";
  const id = Number.isFinite(snapshot && snapshot.sequence) ? `id: ${snapshot.sequence}\n` : "";
  return `event: ${event}\n${id}data: ${JSON.stringify(snapshot)}\n\n`;
}
function fanoutDerivativeNow() {
  derivativeFanoutTimer = null;
  derivativeLastFanoutMs = Date.now();
  for (const [key, type] of derivativePendingUpdates) {
    derivativePendingUpdates.delete(key);
    const clients = derivativeSseClients.get(key);
    const snapshot = store.derivatives.getSnapshot(key);
    if (!clients || !snapshot) continue;
    const chunk = derivativeEvent(snapshot, type);
    for (const client of [...clients]) {
      if (!derivativeSseWrite(client, chunk)) removeDerivativeClient(key, client);
    }
  }
}
function scheduleDerivativeFanout(key, type) {
  if (!DERIVATIVES_ENABLED || !derivativeSseClients.has(key)) return;
  derivativePendingUpdates.set(key, type);
  if (derivativeFanoutTimer) return;
  const since = Date.now() - derivativeLastFanoutMs;
  derivativeFanoutTimer = setTimeout(fanoutDerivativeNow, Math.max(0, FANOUT_MIN_MS - since));
  derivativeFanoutTimer.unref?.();
}
function stateSseWrite(client, chunk) {
  try {
    if (client.res.writableEnded) {
      stateSseClients.delete(client);
      return;
    }
    client.res.write(chunk);
  } catch (_) {
    stateSseClients.delete(client);
  }
}
function broadcastState(change) {
  const revisioned = { ...change, revision: ++stateRevision };
  stateChanges.push(revisioned);
  if (stateChanges.length > 500) stateChanges.shift();
  const chunk = `event: state\ndata: ${JSON.stringify(revisioned)}\n\n`;
  for (const client of stateSseClients) {
    if (revisioned.userId && revisioned.userId !== client.userId) continue;
    stateSseWrite(client, chunk);
  }
}
async function reseedLiveCache() {
  if (!(STREAM_WS && marketState() === "open")) return;
  try {
    store.ingestSnapshot(await fetchAllIndices());
    scheduleFanout(); // push the reseeded fields (esp. ones no WS tick carries)
  } catch (_) {
    /* transient - keep serving the existing store snapshot */
  }
}
// The store is the single source of truth; a background updater (startStoreUpdater)
// keeps it warm, so this just returns the current snapshot - fetching once only if the
// store is still empty (e.g. a request arrives before the first refresh).
async function getMarketData() {
  if (!store.hasData()) {
    try {
      store.ingestSnapshot(await fetchMarketData());
    } catch (_) {
      /* fall through - return whatever the store has (possibly {}) */
    }
  }
  return store.getSnapshot();
}
// Background refresh: keep the store warm without fetching per request.
let refreshingStore = false;
async function refreshStore() {
  if (refreshingStore) return;
  refreshingStore = true;
  try {
    store.ingestSnapshot(await fetchMarketData());
    if (STREAM_WS) scheduleFanout();
  } catch (_) {
    /* transient upstream error - keep the last good snapshot */
  } finally {
    refreshingStore = false;
  }
}
function startStoreUpdater() {
  refreshStore(); // initial warm
  // market-hours cadence (skip when a live WS stream is already driving the store)
  setInterval(() => {
    const st = marketState();
    if (STREAM_WS && st === "open") return; // ticks + reseedLiveCache drive it
    if (st === "pre-open" || st === "open") refreshStore();
  }, STORE_REFRESH_MS);
  // closed-hours: refresh slowly so last-close data stays present without hammering
  setInterval(() => {
    if (marketState() === "closed") refreshStore();
  }, 60_000);
}

// ---------------- alert evaluation loop (server-side; fires with no tab open) ----------------
const ALERT_POLL_MS =
  Math.max(2, Number(process.env.ALERT_POLL_SECONDS) || 5) * 1000;
// Safety switch for local testing/screenshots: when ALERTS_NO_TICK is set the server
// serves the UI + APIs but never evaluates alerts (no fires, no Telegram, no state writes
// from the engine). Use it to inspect the live UI without mutating real data.
const NO_TICK = envFlag(process.env.ALERTS_NO_TICK);
let evaluating = false;
// live price per symbol now comes from the central store (store.getPrice) — used to
// re-anchor a trigger at create/edit time.
async function alertTick() {
  const st = marketState(); // fire during pre-open (IEP) and the regular session
  if (evaluating || NO_TICK || (st !== "open" && st !== "pre-open")) return;
  evaluating = true;
  try {
    const payload = await getMarketData();
    if (st === "open") alerts.updateSymbols(payload); // refresh symbol cache from real constituents only
    alerts.evaluate(payload);
    if (st === "pre-open" && llm.configured())
      llm.analyze(payload).catch(() => {}); // fire-and-forget; errors logged inside
  } catch (_) {
    /* transient network error - try again next tick */
  } finally {
    evaluating = false;
  }
}

// ---------------- HTTP server ----------------
function send(res, code, body, ctype) {
  res.writeHead(code, {
    "Content-Type": ctype,
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}
function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
function finishAlert(res, r) {
  if (r.error)
    return sendJson(res, r.status || (r.error === "not found" ? 404 : 400), {
      error: r.error,
      ...(r.currentVersion == null ? {} : { currentVersion: r.currentVersion }),
    });
  return sendJson(res, 200, {
    alert: r.alert,
    syncStatus: alerts.syncStatus(),
  });
}
function permit(res, user, action, alert) {
  const denied = authorize(user, action, alert);
  if (!denied) return true;
  sendJson(res, denied.status, { error: denied.error });
  return false;
}

function derivativeErrorResponse(res, error) {
  const code = error instanceof DerivativesError ? error.code : "SOURCE_ERROR";
  const status = code === "INVALID_QUERY" || code === "INVALID_KEY" ? 400
    : code === "SNAPSHOT_UNAVAILABLE" ? 404
    : code === "REQUEST_BUDGET" || code === "CAPACITY" ? 429
      : code === "UPSTREAM_BLOCK" || code === "SOURCE_BUSY" || code === "CLOSED" ? 503
        : 502;
  const retryAfterMs = error && Number.isFinite(Number(error.retryAfterMs))
    ? Math.max(0, Number(error.retryAfterMs)) : null;
  sendJson(res, status, {
    error: error instanceof DerivativesError ? error.message : "derivatives source request failed",
    code,
    ...(retryAfterMs == null ? {} : { retryAfterMs }),
  });
}

function derivativeQuery(req, fields) {
  if ((req.url || "").length > 512) throw new DerivativesError("INVALID_QUERY", "query is too long");
  const query = new URL(req.url, `http://${HOST}`).searchParams;
  for (const name of query.keys()) {
    if (!fields.includes(name) || query.getAll(name).length !== 1) {
      throw new DerivativesError("INVALID_QUERY", "invalid query parameters");
    }
  }
  const result = {};
  for (const field of fields) {
    const value = query.get(field);
    if (typeof value !== "string" || !value || value.length > (field === "symbol" ? 12 : 10)) {
      throw new DerivativesError("INVALID_QUERY", `invalid ${field}`);
    }
    result[field] = value;
  }
  if (result.symbol !== "NIFTY" && result.symbol !== "BANKNIFTY") {
    throw new DerivativesError("INVALID_QUERY", "symbol must be NIFTY or BANKNIFTY");
  }
  if (result.expiry && !validDerivativeDate(result.expiry)) {
    throw new DerivativesError("INVALID_QUERY", "expiry must be an ISO calendar date");
  }
  return result;
}

function validDerivativeDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function derivativeExpiryIsValid(contracts, expiry) {
  return Boolean(contracts && Array.isArray(contracts.expiries) && contracts.expiries.some((entry) => entry && entry.expiry === expiry));
}

async function handleDerivativesApi(req, res, url, method) {
  let requestClosed = false;
  if (!DERIVATIVES_ENABLED) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  if (!derivativesService) {
    sendJson(res, 503, { error: "derivatives service unavailable" });
    return true;
  }
  try {
    if (url === "/api/derivatives/analysis" && method === "GET") {
      const { symbol, expiry } = derivativeQuery(req, ["symbol", "expiry"]);
      sendJson(res, 200, derivativesService.getAnalysis({ market: "index", symbol, expiry }));
      return true;
    }
    if (url === "/api/derivatives/contracts" && method === "GET") {
      const { symbol } = derivativeQuery(req, ["symbol"]);
      sendJson(res, 200, await derivativesService.getContracts({ market: "index", symbol }));
      return true;
    }
    if (url === "/api/derivatives/options" && method === "GET") {
      const { symbol, expiry } = derivativeQuery(req, ["symbol", "expiry"]);
      const snapshot = store.derivatives.getSnapshot(`index:${symbol}:${expiry}`);
      if (!snapshot) sendJson(res, 404, { error: "option chain snapshot unavailable" });
      else sendJson(res, 200, snapshot);
      return true;
    }
    if (url === "/api/derivatives/status" && method === "GET") {
      if (new URL(req.url, `http://${HOST}`).search) throw new DerivativesError("INVALID_QUERY", "status accepts no query parameters");
      sendJson(res, 200, derivativesService.getStatus());
      return true;
    }
    if (url === "/api/derivatives/stream" && method === "GET") {
      const { symbol, expiry } = derivativeQuery(req, ["symbol", "expiry"]);
      let streamClosed = false;
      let demand = null;
      let key = null;
      let client = null;
      let clientRegistered = false;
      let streamStarted = false;
      const closeStream = () => {
        requestClosed = true;
        streamClosed = true;
        if (clientRegistered && client && key) removeDerivativeClient(key, client);
        else if (demand) demand.release();
      };
      // Register before metadata I/O so an abandoned request can never acquire demand.
      req.once("close", closeStream);
      const contracts = await derivativesService.getContracts({ market: "index", symbol });
      if (streamClosed || req.destroyed || res.destroyed || res.writableEnded) return true;
      if (!derivativeExpiryIsValid(contracts, expiry)) {
        throw new DerivativesError("INVALID_QUERY", "expiry is not available for this symbol");
      }
      demand = derivativesService.addDemand({ market: "index", symbol, expiry });
      key = demand.key;
      if (streamClosed || req.destroyed || res.destroyed || res.writableEnded) {
        demand.release();
        return true;
      }
      try {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        streamStarted = true;
        res.write("retry: 3000\n\n");
        client = { res, release: demand.release, heartbeat: null };
        const clients = derivativeSseClients.get(key) || new Set();
        clients.add(client);
        derivativeSseClients.set(key, clients);
        clientRegistered = true;
        if (streamClosed || req.destroyed || res.destroyed || res.writableEnded) {
          removeDerivativeClient(key, client);
          return true;
        }
        // The first application event is always a complete snapshot envelope,
        // including the normalized loading envelope created by addDemand().
        const current = store.derivatives.getSnapshot(key);
        if (!current || !derivativeSseWrite(client, derivativeEvent(current, "snapshot"))) {
          removeDerivativeClient(key, client);
          return true;
        }
        client.heartbeat = setInterval(() => {
          if (!derivativeSseWrite(client, ": heartbeat\n\n")) removeDerivativeClient(key, client);
        }, 15_000);
        client.heartbeat.unref?.();
      } catch (error) {
        if (clientRegistered && client) removeDerivativeClient(key, client);
        else if (demand) demand.release();
        if (streamStarted || streamClosed || req.destroyed || res.destroyed || res.writableEnded) {
          if (streamStarted && !res.destroyed && !res.writableEnded) {
            try { res.end(); } catch (_) {}
          }
          return true;
        }
        throw error;
      }
      return true;
    }
  } catch (error) {
    if (requestClosed || req.destroyed || res.destroyed || res.writableEnded) return true;
    derivativeErrorResponse(res, error);
    return true;
  }
  return false;
}

// ---------------- auth: cookies + session ----------------
const SID = "sid";
const SESSION_MAX_AGE = 12 * 60 * 60; // seconds (matches auth.js idle TTL)
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0)
      out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function getToken(req) {
  return parseCookies(req)[SID] || null;
}
function sessionCookie(token) {
  return `${SID}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}
function clearCookie() {
  return `${SID}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
// JSON response with an optional Set-Cookie (same-origin, so no CORS header)
function sendJsonCookie(res, code, obj, setCookie) {
  const body = JSON.stringify(obj);
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  };
  if (setCookie) h["Set-Cookie"] = setCookie;
  res.writeHead(code, h);
  res.end(body);
}

// Open auth endpoints (no existing session required). Returns true if handled.
async function handleAuthApi(req, res, url, method, token) {
  if (url === "/api/auth/status" && method === "GET") {
    sendJson(res, 200, {
      needsSetup: auth.needsSetup(),
      user: auth.sessionUser(token),
    });
    return true;
  }
  if (url === "/api/auth/users-public" && method === "GET") {
    sendJson(res, 200, { users: auth.needsSetup() ? [] : auth.pickerUsers() });
    return true;
  }
  if (url === "/api/auth/setup" && method === "POST") {
    const body = await readJson(req);
    const r = auth.setupAdmin(body);
    if (r.error) return (sendJson(res, 400, { error: r.error }), true);
    const li = auth.login(body.username, body.password); // auto-login the new admin
    return (
      sendJsonCookie(
        res,
        201,
        { user: r.user },
        li.token ? sessionCookie(li.token) : undefined,
      ),
      true
    );
  }
  if (url === "/api/auth/login" && method === "POST") {
    const body = await readJson(req);
    const r = auth.login(body.username, body.password);
    if (r.error) return (sendJson(res, 401, { error: r.error }), true);
    return (
      sendJsonCookie(res, 200, { user: r.user }, sessionCookie(r.token)),
      true
    );
  }
  if (url === "/api/auth/logout" && method === "POST") {
    auth.logout(token);
    return (sendJsonCookie(res, 200, { ok: true }, clearCookie()), true);
  }
  return false;
}

// Admin-only user management. Returns true if handled.
async function handleUsersApi(req, res, url, method, actor) {
  if (url === "/api/users" && method === "GET") {
    sendJson(res, 200, { users: auth.listUsers() });
    return true;
  }
  if (url === "/api/users" && method === "POST") {
    const r = auth.createUser(await readJson(req), actor.id);
    if (r.error) sendJson(res, 400, { error: r.error });
    else sendJson(res, 201, { user: r.user });
    return true;
  }
  const telegramMatch = url.match(
    /^\/api\/users\/([^/]+)\/telegram\/(link-code|link)$/,
  );
  if (telegramMatch) {
    const id = decodeURIComponent(telegramMatch[1]);
    const action = telegramMatch[2];
    if (action === "link-code" && method === "POST") {
      if (!telegram.configured()) {
        sendJson(res, 503, { error: "Telegram bot is not configured" });
        return true;
      }
      const result = auth.createTelegramLinkCode(id);
      sendJson(
        res,
        result.error ? (result.error === "not found" ? 404 : 400) : 201,
        {
          ...result,
          botUsername: telegram.publicConfig().botUsername,
        },
      );
      return true;
    }
    if (action === "link" && method === "DELETE") {
      const result = auth.unlinkTelegram(id);
      if (!result.error) {
        broadcastState({ kind: "telegram", userId: id });
        broadcastState({ kind: "users" });
      }
      sendJson(
        res,
        result.error ? (result.error === "not found" ? 404 : 400) : 200,
        result,
      );
      return true;
    }
  }
  const m = url.match(/^\/api\/users\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === "PATCH") {
      const r = auth.updateUser(id, await readJson(req));
      sendJson(res, r.error ? (r.error === "not found" ? 404 : 400) : 200, r);
      return true;
    }
    if (method === "DELETE") {
      const r = auth.deleteUser(id);
      sendJson(res, r.error ? (r.error === "not found" ? 404 : 400) : 200, r);
      return true;
    }
  }
  return false;
}

// Alert + symbol API. Returns true if it handled the request.
async function handleAlertsApi(req, res, url, method, user) {
  if (url === "/api/alert-creators" && method === "GET") {
    if (!permit(res, user, ACTION.CREATE)) return true;
    sendJson(res, 200, { users: eligibleAlertCreators(auth.listUsers()) });
    return true;
  }
  if (url === "/api/symbols" && method === "GET") {
    sendJson(res, 200, alerts.symbols());
    return true;
  }
  if (url === "/api/alert-config" && method === "GET") {
    sendJson(res, 200, alerts.config());
    return true;
  }
  if (url === "/api/price" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    const sym = (q.searchParams.get("symbol") || "").toUpperCase();
    sendJson(res, 200, { symbol: sym, price: store.getPrice(sym) ?? null });
    return true;
  }
  if (url === "/api/alerts/active" && method === "GET") {
    sendJson(res, 200, { alerts: store.enrichAlerts(alerts.active(user.id)) });
    return true;
  }
  // active + archived together (used by the notification center so archived events survive)
  if (url === "/api/alerts/all" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    const index = q.searchParams.get("index") || undefined;
    sendJson(res, 200, {
      alerts: store.enrichAlerts(alerts.list(index)),
      archived: store.enrichAlerts(alerts.listArchived(index)),
    });
    return true;
  }
  // archived (closed) alerts only - same { alerts } shape for easy reuse
  if (url === "/api/alerts/archived" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    sendJson(res, 200, {
      alerts: store.enrichAlerts(alerts.listArchived(q.searchParams.get("index") || undefined)),
    });
    return true;
  }
  if (url === "/api/alerts" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    sendJson(res, 200, {
      alerts: store.enrichAlerts(alerts.list(q.searchParams.get("index") || undefined)),
    });
    return true;
  }
  if (url === "/api/alerts" && method === "POST") {
    if (!permit(res, user, ACTION.CREATE)) return true;
    const body = await readJson(req);
    const creator = resolveAlertCreator(
      auth.listUsers(),
      body.creatorUserId,
      user,
    );
    delete body.creatorUserId;
    if (!creator) {
      sendJson(res, 400, { error: "select an enabled editor or admin as creator" });
      return true;
    }
    body.zoneCreator = creator.username;
    // Prefer the price the create form captured (once side+entry+time frame were set) so
    // the saved Alert price matches the preview; fall back to the server's latest tick.
    const formCp = num(body.formPrice);
    delete body.formPrice; // transport-only; never persisted on the alert
    const cp =
      formCp > 0
        ? formCp
        : store.getPrice(String(body.symbol || "").toUpperCase());
    const r = alerts.create(body, cp, creator, user);
    if (r.error) sendJson(res, 400, { error: r.error });
    else
      sendJson(res, 201, { alert: r.alert, syncStatus: alerts.syncStatus() });
    return true;
  }
  const eventsMatch = url.match(/^\/api\/alerts\/([^/]+)\/events$/);
  if (eventsMatch && method === "GET") {
    const id = decodeURIComponent(eventsMatch[1]);
    if (!alerts.find(id)) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    sendJson(res, 200, { events: alerts.listEvents(id) });
    return true;
  }
  const detailMatch = url.match(/^\/api\/alerts\/([^/]+)$/);
  if (detailMatch && method === "GET") {
    const alert = alerts.find(decodeURIComponent(detailMatch[1]));
    sendJson(
      res,
      alert ? 200 : 404,
      alert ? { alert } : { error: "not found" },
    );
    return true;
  }
  const m = url.match(
    /^\/api\/alerts\/([^/]+)(?:\/(snooze|close|approve|reject|rearm))?$/,
  );
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    if (action === "snooze" && method === "POST") {
      const body = await readJson(req);
      finishAlert(res, alerts.snooze(id, user.id, body.minutes));
      return true;
    }
    if (action === "close" && method === "POST") {
      const alert = alerts.find(id);
      if (!alert) {
        finishAlert(res, { error: "not found" });
        return true;
      }
      if (!permit(res, user, ACTION.CLOSE, alert)) return true;
      const body = await readJson(req);
      finishAlert(res, alerts.close(id, user, body.expectedVersion));
      return true;
    }
    if (action === "rearm" && method === "POST") {
      // re-anchor against the current live price, exactly like creation
      const a = alerts.find(id);
      if (!a) {
        finishAlert(res, { error: "not found" });
        return true;
      }
      if (!permit(res, user, ACTION.REARM, a)) return true;
      const body = await readJson(req);
      const cp = a ? store.getPrice(a.symbol) : undefined;
      finishAlert(res, alerts.rearm(id, cp, user, body.expectedVersion));
      return true;
    }
    if ((action === "approve" || action === "reject") && method === "POST") {
      const alert = alerts.find(id);
      if (!alert) {
        finishAlert(res, { error: "not found" });
        return true;
      }
      if (!permit(res, user, ACTION.REVIEW, alert)) return true;
      const body = await readJson(req);
      finishAlert(
        res,
        alerts.review(id, action, body.reason, user, body.expectedVersion),
      );
      return true;
    }
    if (!action && method === "PATCH") {
      const alert = alerts.find(id);
      if (!alert) {
        finishAlert(res, { error: "not found" });
        return true;
      }
      if (!permit(res, user, ACTION.ALERT_EDIT, alert)) return true;
      const body = await readJson(req);
      delete body.zoneCreator; // creator is fixed at create time; edits never reassign it
      delete body.creatorUserId;
      const formCp = num(body.formPrice);
      delete body.formPrice; // transport-only; never persisted on the alert
      const cp =
        formCp > 0
          ? formCp
          : store.getPrice(String(body.symbol || "").toUpperCase());
      finishAlert(res, alerts.update(id, body, cp, user, body.expectedVersion));
      return true;
    }
    if (!action && method === "DELETE") {
      const alert = alerts.find(id);
      if (!alert) {
        finishAlert(res, { error: "not found" });
        return true;
      }
      if (!permit(res, user, ACTION.DELETE, alert)) return true;
      const body = await readJson(req);
      const r = alerts.remove(id, user, body.expectedVersion);
      if (r.error) finishAlert(res, r);
      else sendJson(res, 200, { ok: true, syncStatus: alerts.syncStatus() });
      return true;
    }
  }
  return false;
}

async function handleNotificationsApi(req, res, url, method, user) {
  if (url === "/api/notifications" && method === "GET") {
    sendJson(res, 200, { notifications: alerts.listNotifications(user.id) });
    return true;
  }
  const match = url.match(
    /^\/api\/notifications\/([^/]+)\/(read|dismiss|snooze)$/,
  );
  if (!match || method !== "POST") return false;
  const eventId = decodeURIComponent(match[1]);
  const action = match[2];
  const body = await readJson(req);
  const result = alerts.updateNotification(user.id, eventId, action, body);
  if (result.error)
    sendJson(res, result.error === "not found" ? 404 : 400, {
      error: result.error,
    });
  else sendJson(res, 200, { ...result, syncStatus: alerts.syncStatus() });
  return true;
}

async function handleTelegramApi(req, res, url, method, user) {
  if (url === "/api/telegram/status" && method === "GET") {
    const liveUser = auth.sessionUser(getToken(req)) || user;
    sendJson(res, 200, {
      telegram: liveUser.telegram,
      config: telegram.publicConfig(),
      deliveries: telegram.deliveryStatus(user.id),
    });
    return true;
  }
  if (url === "/api/telegram/link-code" && method === "POST") {
    if (!telegram.configured()) {
      sendJson(res, 503, { error: "Telegram bot is not configured" });
      return true;
    }
    const result = auth.createTelegramLinkCode(user.id);
    sendJson(res, result.error ? 400 : 201, result);
    return true;
  }
  if (url === "/api/telegram/link" && method === "DELETE") {
    const result = auth.unlinkTelegram(user.id);
    if (!result.error) broadcastState({ kind: "telegram", userId: user.id });
    sendJson(res, result.error ? 400 : 200, result);
    return true;
  }
  if (url === "/api/telegram/enabled" && method === "POST") {
    const body = await readJson(req);
    const result = auth.setTelegramEnabled(user.id, body.enabled);
    if (!result.error) broadcastState({ kind: "telegram", userId: user.id });
    sendJson(res, result.error ? 400 : 200, result);
    return true;
  }
  return false;
}

async function handleAnalysisApi(req, res, url, method, user) {
  if (url === "/api/analysis" && method === "GET") {
    if (!llm.configured()) {
      sendJson(res, 200, { status: "unavailable" });
      return true;
    }
    const q = new URL(req.url, `http://${HOST}`);
    const symbol = (q.searchParams.get("symbol") || "").toUpperCase().trim();
    if (!symbol) {
      sendJson(res, 400, { error: "symbol parameter required" });
      return true;
    }
    const analysis = llm.getAnalysis(symbol);
    if (analysis) {
      sendJson(res, 200, { status: "ready", date: llm.cacheDate(), analysis });
    } else {
      const status = llm.getStatus();
      sendJson(res, 200, {
        status: status === "ready" ? "pending" : status, // ready-but-missing-symbol -> pending for this stock
        date: llm.cacheDate(),
        error: status === "error" ? llm.lastErrorMessage() : undefined,
      });
    }
    return true;
  }
  if (url === "/api/analysis/refresh" && method === "POST") {
    if (!permit(res, user, ACTION.CREATE)) return true; // editor/admin only (billable LLM call)
    if (!llm.configured()) {
      sendJson(res, 200, { status: "unavailable" });
      return true;
    }
    llm.clearCache();
    const payload = await getMarketData();
    llm.analyze(payload).catch(() => {});
    sendJson(res, 200, { status: "queued" });
    return true;
  }
  return false;
}

async function handleTradesApi(req, res, url, method, user) {
  if (url === "/api/trades/summary" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    sendJson(res, 200, {
      summary: trades.summary({
        tradeType: q.searchParams.get("tradeType") || undefined,
        from: q.searchParams.get("from") || undefined,
        to: q.searchParams.get("to") || undefined,
      }),
    });
    return true;
  }
  if (url === "/api/trades" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    sendJson(res, 200, {
      trades: trades.list({
        tradeType: q.searchParams.get("tradeType") || undefined,
        status: q.searchParams.get("status") || undefined,
        symbol: q.searchParams.get("symbol") || undefined,
        side: q.searchParams.get("side") || undefined,
        from: q.searchParams.get("from") || undefined,
        to: q.searchParams.get("to") || undefined,
        strategy: q.searchParams.get("strategy") || undefined,
      }),
    });
    return true;
  }
  if (url === "/api/trades" && method === "POST") {
    if (!permit(res, user, ACTION.CREATE)) return true;
    const body = await readJson(req);
    const r = trades.create(body, user);
    if (r.error) sendJson(res, 400, { error: r.error });
    else sendJson(res, 201, { trade: r.trade });
    return true;
  }
  const detail = url.match(/^\/api\/trades\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    if (method === "GET") {
      const trade = trades.get(id);
      sendJson(res, trade ? 200 : 404, trade ? { trade } : { error: "not found" });
      return true;
    }
    if (method === "PATCH") {
      const existing = trades.find(id);
      if (!existing) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      if (!permit(res, user, ACTION.EDIT, existing)) return true;
      const body = await readJson(req);
      const r = trades.update(id, body, user);
      if (r.error) sendJson(res, r.status || 400, { error: r.error });
      else sendJson(res, 200, { trade: r.trade });
      return true;
    }
    if (method === "DELETE") {
      const existing = trades.find(id);
      if (!existing) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      if (!permit(res, user, ACTION.DELETE, existing)) return true;
      const r = trades.remove(id);
      if (r.error) sendJson(res, r.status || 400, { error: r.error });
      else sendJson(res, 200, { ok: true });
      return true;
    }
  }
  return false;
}

// ---- static file serving (the app shell in ../frontend; public, app self-gates via auth) ----
const FRONTEND_DIR = path.join(HERE, "..", "frontend");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", // mandatory type or browsers reject ES modules
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};
function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = path.normalize(path.join(FRONTEND_DIR, rel));
  // path-traversal guard: must resolve inside FRONTEND_DIR
  if (full !== FRONTEND_DIR && !full.startsWith(FRONTEND_DIR + path.sep)) {
    send(res, 404, "Not found", "text/plain");
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) send(res, 404, "Not found", "text/plain");
    else
      send(
        res,
        200,
        buf,
        MIME[path.extname(full)] || "application/octet-stream",
      );
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const method = req.method || "GET";
  if (url.startsWith("/api/")) {
    try {
      // CSRF: state-changing requests must carry our XHR header (cross-site forms can't)
      if (
        method !== "GET" &&
        method !== "HEAD" &&
        req.headers["x-requested-with"] !== "XMLHttpRequest"
      ) {
        sendJson(res, 403, { error: "missing X-Requested-With header" });
        return;
      }
      const token = getToken(req);
      // open auth endpoints (status/setup/login/logout/users-public) need no session
      if (await handleAuthApi(req, res, url, method, token)) return;
      // A disabled feature must be indistinguishable from an unimplemented route,
      // including to callers without a session.
      if (!DERIVATIVES_ENABLED && url.startsWith("/api/derivatives")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      // everything else requires a valid session
      const user = auth.sessionUser(token);
      if (!user) {
        sendJson(res, 401, { error: "authentication required" });
        return;
      }
      // admin-only user management
      if (url.startsWith("/api/users")) {
        if (user.role !== "admin") {
          sendJson(res, 403, { error: "admin only" });
          return;
        }
        if (await handleUsersApi(req, res, url, method, user)) return;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (url.startsWith("/api/notifications")) {
        if (await handleNotificationsApi(req, res, url, method, user)) return;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (url.startsWith("/api/telegram")) {
        if (await handleTelegramApi(req, res, url, method, user)) return;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (url.startsWith("/api/derivatives")) {
        if (await handleDerivativesApi(req, res, url, method)) return;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (url.startsWith("/api/analysis")) {
        if (await handleAnalysisApi(req, res, url, method, user)) return;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (url === "/api/changes" && method === "GET") {
        const requestUrl = new URL(req.url, `http://${HOST}`);
        const since = Math.max(
          0,
          Number(requestUrl.searchParams.get("since")) || 0,
        );
        const oldestRevision = stateChanges.length
          ? stateChanges[0].revision
          : stateRevision + 1;
        const resetRequired =
          since > stateRevision || (since > 0 && since < oldestRevision - 1);
        const changes = resetRequired
          ? []
          : stateChanges.filter(
              (change) =>
                change.revision > since &&
                (!change.userId || change.userId === user.id),
            );
        sendJson(res, 200, {
          revision: stateRevision,
          resetRequired,
          changes,
        });
        return;
      }
      if (url === "/api/events" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 3000\n\n");
        res.write(
          `event: state\ndata: ${JSON.stringify({ kind: "ready", revision: stateRevision, syncStatus: alerts.syncStatus() })}\n\n`,
        );
        const client = { res, userId: user.id };
        stateSseClients.add(client);
        req.on("close", () => stateSseClients.delete(client));
        return;
      }
      if (url === "/api/sync-status" && method === "GET") {
        sendJson(res, 200, alerts.syncStatus());
        return;
      }
      // data + alert endpoints (any authenticated user for reads)
      if (
        url === "/api/symbols" ||
        url === "/api/alert-config" ||
        url === "/api/alert-creators" ||
        url === "/api/price" ||
        url.startsWith("/api/alerts")
      ) {
        if (await handleAlertsApi(req, res, url, method, user)) return;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (url.startsWith("/api/trades")) {
        if (await handleTradesApi(req, res, url, method, user)) return;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (url === "/api/indices") {
        const data = await getMarketData(); // served from the central store (kept warm by startStoreUpdater)
        send(res, 200, JSON.stringify(data), "application/json; charset=utf-8");
        return;
      }
      if (url === "/api/stream") {
        // flag-off -> no SSE at all (clean 404), so parity holds when STREAM_WS is unset
        if (!STREAM_WS) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 3000\n\n");
        res.write(
          `event: snapshot\ndata: ${JSON.stringify(await getMarketData())}\n\n`,
        );
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      sendJson(res, 400, { error: String((e && e.message) || e) });
    }
    return;
  }
  // everything else -> static assets from ../frontend (index.html, css/*, js/*)
  serveStatic(res, url);
});

server.on("close", () => {
  if (derivativeFanoutTimer) clearTimeout(derivativeFanoutTimer);
  derivativeFanoutTimer = null;
  derivativePendingUpdates.clear();
  for (const [key, clients] of derivativeSseClients) {
    for (const client of [...clients]) removeDerivativeClient(key, client);
  }
  if (derivativesService) derivativesService.close();
  sourceTraffic.close();
});

async function main() {
  console.log(
    "\n  Trading Tracker - NSE market dashboard and journal (Node)",
  );
  console.log(
    FEED
      ? "  Data source: configured from FEED_JSON"
      : "  Data source: NOT configured - set FEED_JSON (see .env.sample)",
  );
  derivativesService = createDerivativesRuntime();
  console.log(
    derivativesService
      ? "  Derivatives: enabled · Phase 2 polling ready (idle until demand)"
      : "  Derivatives: disabled",
  );
  await auth.load();
  console.log(
    `  Auth: ${auth.listUsers().length} user(s) · store: ${auth.backendName()}` +
      ` · password pepper: ${auth.passwordPepperConfigured() ? "configured" : "NOT configured"}` +
      (auth.needsSetup() ? " · NEEDS SETUP (create admin on first open)" : ""),
  );
  // Load the remaining stores in PARALLEL (trades is independent; alerts &
  // telegram only need auth, already loaded). Collapses three sequential Mongo
  // connects into one wave - the main startup-time win.
  const [, , telegramBackend] = await Promise.all([
    alerts.load({
      users: auth.listUsers(),
      usersProvider: () => auth.listUsers(),
    }),
    trades.load(),
    telegram.load({
      auth,
      logError: alerts.logError,
      // poll Telegram for inbound updates only during market hours (pre-open + open)
      isMarketOpen: () => {
        const s = marketState();
        return s === "open" || s === "pre-open";
      },
      onUserChange: (userId) => {
        broadcastState({ kind: "telegram", userId });
        broadcastState({ kind: "users" });
      },
    }),
  ]);
  alerts.setEventSink((event) => telegram.enqueue(event));
  alerts.setChangeSink((change) => broadcastState(change));
  console.log(
    `  Alerts: ${alerts.list().length} saved · store: ${alerts.backendName()} · eval every ${ALERT_POLL_MS / 1000}s in market hours`,
  );
  console.log(`  Trades: ${trades.list().length} saved · store: ${trades.backendName()}`);
  console.log(
    `  Telegram: ${telegram.configured() ? `configured · store: ${telegramBackend}` : "not configured (in-page only)"}`,
  );
  llm.load({ logError: alerts.logError });
  console.log(`  LLM: ${llm.configured() ? "configured" : "not configured"}`);
  const streamCfg = requireStream(); // null when STREAM_WS unset, or on WARNING+continue
  console.log(
    STREAM_WS
      ? `  Live WS feed: STREAM_WS on · ${streamCfg ? "feed.stream configured" : "feed.stream NOT configured - pure-REST fallback"} · SSE ${streamCfg ? "available at /api/stream" : "disabled (404)"}`
      : "  Live WS feed: STREAM_WS off - pure REST (today's behaviour), /api/stream disabled (404)",
  );
  // Self-test runs in the BACKGROUND so it never delays the HTTP listen - it only
  // prints reachability + seeds caches (the poll/stream refresh these anyway).
  void (async () => {
  console.log("  Self-test: fetching indices from the data source ...");
  try {
    const j = await fetchAllIndices();
    store.ingestSnapshot(j); // warm the central store from the startup self-test fetch
    alerts.updateSymbols(j); // seed the create-form dropdown when started in market hours
    for (const key of DASH_INDICES) {
      const n = (j[key].data || []).length;
      const lv = j[key].level;
      if (lv && lv.last != null) {
        console.log(
          `  [${key}] level ${lv.last} (${lv.variation >= 0 ? "+" : ""}${lv.variation}, ${lv.pChange >= 0 ? "+" : ""}${lv.pChange}%)`,
        );
      }
      if (n > 0) {
        const r = j[key].data[0];
        console.log(
          `  OK [${key}] - got ${n} constituents (stamp: ${j[key].timestamp})`,
        );
        console.log(
          `    sample: ${r.symbol} open=${r.open} high=${r.dayHigh} low=${r.dayLow} ltp=${r.lastPrice} pChg=${r.pChange}%`,
        );
        const noOpen = j[key].data.filter((x) => x.open == null).length;
        if (noOpen)
          console.log(
            `    note: ${noOpen}/${n} rows missing open (pre-open not merged) - O→High/Low show - for those.`,
          );
      } else {
        console.log(
          `  OK [${key}] - data source reachable, but constituents list is EMPTY (market closed).`,
        );
      }
    }
    console.log(
      "  Live data flows Mon–Fri 09:15–15:30 IST; the dashboard fills automatically then.",
    );
  } catch (e) {
    console.log(`  WARNING - fetch failed: ${(e && e.message) || e}`);
    console.log(
      "  If HTTP 401/403, the data source's anti-bot blocked this network (VPN/datacentre).",
    );
  }
  })();
  server.listen(PORT, HOST, () => {
    logInfo("server", `serving on http://${HOST}:${PORT}/ (stream ${STREAM_WS ? "on" : "off"})`);
    console.log("  Open that URL in your browser. Ctrl-C to stop.\n");
    if (NO_TICK)
      console.log(
        "  ALERTS_NO_TICK set - alert engine PAUSED (read-only, no fires).\n",
      );
    else setInterval(alertTick, ALERT_POLL_MS); // server-side alert engine
    startStoreUpdater(); // keep the central market store warm (background refresh)
    if (MARKET_CAPTURE) {
      console.log("  Market capture: ON - transitions + raw samples -> logs/market-capture-<date>.jsonl");
      // fire-and-forget; captureTick has its own try/catch, .catch is a belt-and-braces
      // guard so a rejection can never bubble to an unhandledRejection / stop the process
      captureTick().catch(() => {});
      const capTimer = setInterval(() => captureTick().catch(() => {}), 30_000);
      if (capTimer.unref) capTimer.unref();
    }
    if (STREAM_WS && streamCfg) {
      stream.start({
        feed: FEED,
        onTick: (t) => {
          applyTick(t);
          scheduleFanout(); // relay each tick immediately (coalesced), not on a timer
        },
        isOpen: () => marketState() === "open",
        log: (msg) => console.log(`  ${msg}`),
        userAgent: USER_AGENTS[0],
      });
      setInterval(reseedLiveCache, SLOW_REFRESH_MS); // REST reseed cadence
      setInterval(() => {
        for (const client of sseClients) sseWrite(client, ":\n\n"); // heartbeat comment
      }, 15_000);
    }
    setInterval(() => {
      for (const client of stateSseClients) stateSseWrite(client, ":\n\n");
    }, 15_000);
  });
}
main();
