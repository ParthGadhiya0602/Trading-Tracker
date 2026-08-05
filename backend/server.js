#!/usr/bin/env node
/**
 * Trading Tracker - local data proxy + static server (Node, ZERO dependencies).
 *
 * Why this exists: the data source's API can't be called directly from a browser.
 * CORS forbids the required headers, and its anti-bot layer 403s/hangs any request
 * without a *warm session* - anti-bot cookies (ak_bmsc, _abck, ...) + browser-like
 * headers. A browser cannot set those cross-origin, so this is a tiny Node server:
 * it warms an upstream session, then re-serves the JSON to our page from the SAME
 * origin (localhost). No CORS, no public proxy, live data. Endpoints come from
 * config.json's `feed` block (not shipped in the code).
 *
 * Uses Node's built-in fetch (Node 18+) and a hand-rolled cookie jar - no npm install.
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

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const HERE = __dirname;

// Data-source endpoints are NOT hardcoded - they're read from config.json's `feed` block
// (gitignored), so the upstream source isn't exposed in the committed code. Shape:
//   { base, indicesEndpoint, referer, warmupPaths: [] }  (see config.example.json)
const CONFIG_FILE = path.join(HERE, "..", "config.json"); // config lives at repo root
function loadFeedConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const f = cfg && cfg.feed;
    if (f && f.base && f.indicesEndpoint) return f;
  } catch (_) {}
  return null;
}
const FEED = loadFeedConfig();
const BASE = FEED ? FEED.base : null;
function requireFeed() {
  if (!FEED)
    throw new Error(
      "data source not configured - add a `feed` block to config.json (see config.example.json)",
    );
}
// Live WS feed is opt-in (STREAM_WS env). When the flag is set but `feed.stream` (or its
// required sub-keys) is missing, we warn and continue in pure-REST mode - never crash.
function requireStream() {
  if (!process.env.STREAM_WS) return null;
  const s = FEED && FEED.stream;
  if (!s || !s.wsBase || !s.constituents) {
    console.log(
      "  WARNING - STREAM_WS is set but `feed.stream` is missing/incomplete in config.json " +
        "(see config.example.json) - continuing in pure-REST mode.",
    );
    return null;
  }
  return s;
}
// One call per index returns everything we need (index level + all constituents +
// advance-decline + marketStatus). endpoint/query come from config.json.
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

function storeCookies(res) {
  // Node 18.14+ exposes getSetCookie(); fall back to the folded header otherwise.
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

async function warm(uaIndex = 0) {
  requireFeed();
  jar = new Map();
  // Hit each configured warmup path in order to accumulate the anti-bot cookies
  // (homepage first, then a page that sets the session cookies /api/* needs).
  const paths = Array.isArray(FEED.warmupPaths) ? FEED.warmupPaths : ["/"];
  for (const p of paths) {
    await (await srcGet(`${BASE}${p}`, uaIndex, 10000)).text();
    await new Promise((r) => setTimeout(r, 300));
  }
  warmedAt = Date.now();
}

async function ensureWarm(uaIndex) {
  if (jar.size && Date.now() - warmedAt <= SESSION_TTL) return;
  if (!warming) warming = warm(uaIndex).finally(() => (warming = null));
  await warming;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

// GET one data-source path (with warm session, rewarm-on-block, backoff). Returns JSON.
async function srcJson(url, retries = 2) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt)
      await new Promise((r) => setTimeout(r, 2 ** (attempt - 1) * 1000));
    try {
      await ensureWarm(attempt);
      const res = await srcGet(url, attempt, 15000, FEED_REF);
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
  return buildPayloadNext(stocks, level, advance, stamp, marketStatusStr(d.marketStatus));
}
// Fetch all dashboard indices (one API call each, in parallel).
async function fetchAllIndices() {
  const payloads = await Promise.all(DASH_INDICES.map((n) => fetchIndexNext(n)));
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
  if (!FEED.preopenEndpoint) throw new Error("pre-open endpoint not configured");
  const j = await srcJson(`${BASE}${FEED.preopenEndpoint}ALL`);
  const rows = (j && j.data) || [];
  const bySym = new Map();
  for (const r of rows) {
    const m = r && r.metadata;
    if (m && m.symbol) bySym.set(m.symbol, { metadata: m, pom: (r.detail && r.detail.preOpenMarket) || null });
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
            buyQty: num(pom.atoBuyQty) != null ? num(pom.atoBuyQty) : num(ato.totalBuyQuantity),
            sellQty: num(pom.atoSellQty) != null ? num(pom.atoSellQty) : num(ato.totalSellQuantity),
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
const STREAM_WS = !!process.env.STREAM_WS;
const STALE_MAX_MS = 15_000; // liveCache older than this -> treat as stale, fall back to REST
const SLOW_REFRESH_MS = 45_000; // REST reseed cadence while the WS feed is driving the cache
// liveCache mirrors the exact buildPayloadNext envelope, keyed by DASH_INDICES.
let liveCache = {};
let liveCacheStampMs = 0;
// Full-fidelity reseed from a REST fetch (all fields, incl. enrichment-only ones).
function seedLiveCache(payload) {
  liveCache = payload;
  liveCacheStampMs = Date.now();
}
// Merge one normalized WS tick into liveCache, preserving REST-only enrichment fields.
function applyTick(t) {
  if (!t || !t.index || !liveCache[t.index]) return;
  const entry = liveCache[t.index];
  if (t.kind === "stock" && t.symbol) {
    const rows = entry.data || (entry.data = []);
    const row = rows.find((r) => r.symbol === t.symbol);
    if (!row) return; // unknown symbol - ignore (constituent list is REST-owned)
    Object.assign(row, t.patch);
    if (row.lastPrice > 0) latestPrices[t.symbol] = row.lastPrice;
  } else if (t.kind === "level") {
    entry.level = Object.assign(entry.level || {}, t.patch);
  } else {
    return;
  }
  entry.timestamp = Date.now();
  liveCacheStampMs = Date.now();
}
// SSE fan-out for /api/stream (only ever populated when STREAM_WS is on - the endpoint
// itself 404s otherwise, so nothing subscribes).
const sseClients = new Set();
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
async function reseedLiveCache() {
  if (!(STREAM_WS && marketState() === "open")) return;
  try {
    const payload = await fetchAllIndices();
    seedLiveCache(payload);
  } catch (_) {
    /* transient - keep serving the existing liveCache/REST fallback */
  }
}
// Wrapper the rest of the server calls instead of fetchMarketData() directly. Flag-off (or
// outside the open session) -> identical to calling fetchMarketData() today.
async function getMarketData() {
  if (!STREAM_WS) return fetchMarketData();
  const st = marketState();
  if (st === "open") {
    const fresh = liveCacheStampMs && Date.now() - liveCacheStampMs < STALE_MAX_MS;
    if (fresh && Object.keys(liveCache).length) return liveCache;
    const payload = await fetchAllIndices();
    seedLiveCache(payload);
    return liveCache;
  }
  return fetchMarketData(); // pre-open / closed: unchanged REST paths
}

// ---------------- alert evaluation loop (server-side; fires with no tab open) ----------------
const ALERT_POLL_MS =
  Math.max(2, Number(process.env.ALERT_POLL_SECONDS) || 5) * 1000;
// Safety switch for local testing/screenshots: when ALERTS_NO_TICK is set the server
// serves the UI + APIs but never evaluates alerts (no fires, no Telegram, no state writes
// from the engine). Use it to inspect the live UI without mutating real data.
const NO_TICK = !!process.env.ALERTS_NO_TICK;
let evaluating = false;
// latest live price per symbol - used to re-anchor a trigger at create/edit time
const latestPrices = Object.create(null);
function cachePrices(payload) {
  for (const idx of DASH_INDICES) {
    for (const r of (payload[idx] && payload[idx].data) || []) {
      if (r.symbol && r.lastPrice > 0) latestPrices[r.symbol] = r.lastPrice;
    }
  }
}
async function alertTick() {
  const st = marketState(); // fire during pre-open (IEP) and the regular session
  if (evaluating || NO_TICK || (st !== "open" && st !== "pre-open")) return;
  evaluating = true;
  try {
    const payload = await getMarketData();
    cachePrices(payload);
    if (st === "open") alerts.updateSymbols(payload); // refresh symbol cache from real constituents only
    alerts.evaluate(payload);
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
    return sendJson(res, r.error === "not found" ? 404 : 400, { error: r.error });
  return sendJson(res, 200, { alert: r.alert });
}

// ---------------- auth: cookies + session ----------------
const SID = "sid";
const SESSION_MAX_AGE = 12 * 60 * 60; // seconds (matches auth.js idle TTL)
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
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
    sendJson(res, 200, { needsSetup: auth.needsSetup(), user: auth.sessionUser(token) });
    return true;
  }
  if (url === "/api/auth/users-public" && method === "GET") {
    sendJson(res, 200, { users: auth.needsSetup() ? [] : auth.pickerUsers() });
    return true;
  }
  if (url === "/api/auth/setup" && method === "POST") {
    const body = await readJson(req);
    const r = auth.setupAdmin(body);
    if (r.error) return sendJson(res, 400, { error: r.error }), true;
    const li = auth.login(body.username, body.password); // auto-login the new admin
    return sendJsonCookie(res, 201, { user: r.user }, li.token ? sessionCookie(li.token) : undefined), true;
  }
  if (url === "/api/auth/login" && method === "POST") {
    const body = await readJson(req);
    const r = auth.login(body.username, body.password);
    if (r.error) return sendJson(res, 401, { error: r.error }), true;
    return sendJsonCookie(res, 200, { user: r.user }, sessionCookie(r.token)), true;
  }
  if (url === "/api/auth/logout" && method === "POST") {
    auth.logout(token);
    return sendJsonCookie(res, 200, { ok: true }, clearCookie()), true;
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
    sendJson(res, 200, { symbol: sym, price: latestPrices[sym] ?? null });
    return true;
  }
  if (url === "/api/alerts/active" && method === "GET") {
    sendJson(res, 200, { alerts: alerts.active() });
    return true;
  }
  // active + archived together (used by the notification center so archived events survive)
  if (url === "/api/alerts/all" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    const index = q.searchParams.get("index") || undefined;
    sendJson(res, 200, {
      alerts: alerts.list(index),
      archived: alerts.listArchived(index),
    });
    return true;
  }
  // archived (closed) alerts only - same { alerts } shape for easy reuse
  if (url === "/api/alerts/archived" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    sendJson(res, 200, {
      alerts: alerts.listArchived(q.searchParams.get("index") || undefined),
    });
    return true;
  }
  if (url === "/api/alerts" && method === "GET") {
    const q = new URL(req.url, `http://${HOST}`);
    sendJson(res, 200, { alerts: alerts.list(q.searchParams.get("index") || undefined) });
    return true;
  }
  if (url === "/api/alerts" && method === "POST") {
    const body = await readJson(req);
    body.zoneCreator = (user && user.username) || ""; // authoritative: the signed-in user
    // Prefer the price the create form captured (once side+entry+time frame were set) so
    // the saved Alert price matches the preview; fall back to the server's latest tick.
    const formCp = num(body.formPrice);
    delete body.formPrice; // transport-only; never persisted on the alert
    const cp =
      formCp > 0 ? formCp : latestPrices[String(body.symbol || "").toUpperCase()];
    const r = alerts.create(body, cp);
    if (r.error) sendJson(res, 400, { error: r.error });
    else sendJson(res, 201, { alert: r.alert });
    return true;
  }
  const m = url.match(
    /^\/api\/alerts\/([^/]+)(?:\/(snooze|close|approve|reject|rearm))?$/,
  );
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    if (action === "snooze" && method === "POST") return finishAlert(res, alerts.snooze(id)), true;
    if (action === "close" && method === "POST") return finishAlert(res, alerts.close(id)), true;
    if (action === "rearm" && method === "POST") {
      // re-anchor against the current live price, exactly like creation
      const a =
        alerts.list().find((x) => x.id === id) ||
        alerts.listArchived().find((x) => x.id === id);
      const cp = a ? latestPrices[a.symbol] : undefined;
      return finishAlert(res, alerts.rearm(id, cp)), true;
    }
    if ((action === "approve" || action === "reject") && method === "POST") {
      const body = await readJson(req);
      const reviewer = (user && user.username) || ""; // server-authoritative, like zoneCreator
      return (
        finishAlert(res, alerts.review(id, action, body.reason, reviewer)),
        true
      );
    }
    if (!action && method === "PATCH") {
      const body = await readJson(req);
      delete body.zoneCreator; // creator is fixed at create time; edits never reassign it
      const formCp = num(body.formPrice);
      delete body.formPrice; // transport-only; never persisted on the alert
      const cp =
        formCp > 0 ? formCp : latestPrices[String(body.symbol || "").toUpperCase()];
      return finishAlert(res, alerts.update(id, body, cp)), true;
    }
    if (!action && method === "DELETE") {
      const r = alerts.remove(id);
      if (r.error) sendJson(res, 404, { error: r.error });
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
    else send(res, 200, buf, MIME[path.extname(full)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const method = req.method || "GET";
  if (url.startsWith("/api/")) {
    try {
      // CSRF: state-changing requests must carry our XHR header (cross-site forms can't)
      if (method !== "GET" && method !== "HEAD" &&
          req.headers["x-requested-with"] !== "XMLHttpRequest") {
        sendJson(res, 403, { error: "missing X-Requested-With header" });
        return;
      }
      const token = getToken(req);
      // open auth endpoints (status/setup/login/logout/users-public) need no session
      if (await handleAuthApi(req, res, url, method, token)) return;
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
      // Only editors may change alerts; admins and viewers are read-only.
      if (url.startsWith("/api/alerts") && method !== "GET" &&
          user.role !== "editor") {
        sendJson(res, 403, { error: "editor role required for alert actions" });
        return;
      }
      // data + alert endpoints (any authenticated user for reads)
      if (
        url === "/api/symbols" ||
        url === "/api/alert-config" ||
        url === "/api/price" ||
        url.startsWith("/api/alerts")
      ) {
        if (await handleAlertsApi(req, res, url, method, user)) return;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (url === "/api/indices") {
        const data = await getMarketData(); // pre-open feed during 09:00-09:15, else live (WS-backed when STREAM_WS is on)
        cachePrices(data);
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
        res.write(`event: snapshot\ndata: ${JSON.stringify(await getMarketData())}\n\n`);
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

async function main() {
  console.log(
    "\n  Trading Tracker - NIFTY 50 / NIFTY NEXT 50 dashboard (Node)",
  );
  console.log(
    FEED
      ? "  Data source: configured from config.json (feed)"
      : "  Data source: NOT configured - add a `feed` block to config.json (see config.example.json)",
  );
  await alerts.load();
  console.log(
    `  Alerts: ${alerts.list().length} saved · store: ${alerts.backendName()} · Telegram ${
      alerts.telegramConfigured() ? "configured" : "not configured (in-page only)"
    } · eval every ${ALERT_POLL_MS / 1000}s in market hours`,
  );
  await auth.load();
  console.log(
    `  Auth: ${auth.listUsers().length} user(s) · store: ${auth.backendName()}` +
      ` · password pepper: ${auth.passwordPepperConfigured() ? "configured" : "NOT configured"}` +
      (auth.needsSetup() ? " · NEEDS SETUP (create admin on first open)" : ""),
  );
  const streamCfg = requireStream(); // null when STREAM_WS unset, or on WARNING+continue
  console.log(
    STREAM_WS
      ? `  Live WS feed: STREAM_WS on · ${streamCfg ? "feed.stream configured" : "feed.stream NOT configured - pure-REST fallback"} · SSE ${streamCfg ? "available at /api/stream" : "disabled (404)"}`
      : "  Live WS feed: STREAM_WS off - pure REST (today's behaviour), /api/stream disabled (404)",
  );
  console.log("  Self-test: fetching indices from the data source ...");
  try {
    const j = await fetchAllIndices();
    cachePrices(j); // seed live prices so create/edit can re-anchor immediately
    alerts.updateSymbols(j); // seed the create-form dropdown when started in market hours
    if (STREAM_WS) seedLiveCache(j); // seed liveCache from the startup self-test fetch
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
  server.listen(PORT, HOST, () => {
    console.log(`\n  Serving on http://${HOST}:${PORT}/`);
    console.log("  Open that URL in your browser. Ctrl-C to stop.\n");
    if (NO_TICK)
      console.log("  ALERTS_NO_TICK set - alert engine PAUSED (read-only, no fires).\n");
    else setInterval(alertTick, ALERT_POLL_MS); // server-side alert engine
    if (STREAM_WS && streamCfg) {
      stream.start({
        feed: FEED,
        onTick: applyTick,
        isOpen: () => marketState() === "open",
        log: (msg) => console.log(`  ${msg}`),
        userAgent: USER_AGENTS[0],
      });
      setInterval(reseedLiveCache, SLOW_REFRESH_MS); // 45s REST reseed cadence
      setInterval(() => {
        // 1/s SSE fan-out: only while the session is open and someone is listening
        if (!(STREAM_WS && marketState() === "open" && sseClients.size > 0)) return;
        const chunk = `event: patch\ndata: ${JSON.stringify(liveCache)}\n\n`;
        for (const client of sseClients) sseWrite(client, chunk);
      }, 1000);
      setInterval(() => {
        for (const client of sseClients) sseWrite(client, ":\n\n"); // heartbeat comment
      }, 15_000);
    }
  });
}
main();
