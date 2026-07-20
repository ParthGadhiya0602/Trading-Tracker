#!/usr/bin/env node
/**
 * Trading Tracker - local NSE proxy + static server (Node, ZERO dependencies).
 *
 * Why this exists: NSE's API (nseindia.com/api/*) can't be called from a browser.
 * CORS forbids the required headers, and behind Akamai NSE hangs/403s any request
 * without a *warm session* - anti-bot cookies (ak_bmsc, _abck, ...) + browser-like
 * headers. A browser cannot set those cross-origin, and Axios-in-a-browser can't
 * either. So this is a tiny Node server (same role as the finance repo's nse.py):
 * it warms an NSE session, then re-serves NIFTY 50 JSON to our page from the SAME
 * origin (localhost). No CORS, no public proxy, live data.
 *
 * Uses Node's built-in fetch (Node 18+) and a hand-rolled cookie jar - no npm install.
 *
 *   Run:   node server.js
 *   Open:  http://localhost:8787/
 *
 * Endpoints:  GET /  -> index.html   |   GET /api/indices -> live NSE JSON for
 *   NIFTY 50 and NIFTY NEXT 50 (both, keyed by index name).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const HERE = __dirname;

const BASE = "https://www.nseindia.com";
// NSE moved /api/equity-stockIndices (404s since 2026-05, confirmed by the finance repo).
// We reconstruct the same data from two LIVE endpoints (verified 2026-07-06):
//  - heatmap-symbols?indices=<name>    -> all constituents with high/low/lastPrice/
//    pChange/change/totalTradedVolume/VWAP (live during market hours; empty array when
//    market is closed). It has NO 'open' field.
//  - market-data-pre-open?key=ALL      -> the pre-open auction price for EVERY listed
//    symbol (2200+ rows), which IS the official day open (frozen at 09:15). Verified
//    2026-07-13 it covers NIFTY 50 + NIFTY NEXT 50 symbols with the same iep values as
//    the narrower key=NIFTY. Merged in by symbol to supply 'open' for both indices
//    from a single call.
const HEATMAP_URL = (indexName) =>
  `${BASE}/api/heatmap-symbols?indices=${encodeURIComponent(indexName)}`;
const PREOPEN_ALL_URL = `${BASE}/api/market-data-pre-open?key=ALL`;
// allIndices gives the INDEX LEVEL itself (points) for every NSE index in one call:
// last (level), variation (± points), percentChange, open/high/low/previousClose.
// Live during market hours; holds last close when the market is shut (so the index
// headline still renders even when heatmap-symbols returns an empty constituent list).
const ALL_INDICES_URL = `${BASE}/api/allIndices`;
const NSE_REF = `${BASE}/market-data/live-equity-market`;
const SESSION_TTL = 600_000; // rewarm every 10 min

// Rotating UA pool - same idea as nse.py: avoids trivially-cached deny rules
// tied to a single UA string. (Not a fingerprint bypass, just polite + helps.)
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
    Referer: `${BASE}/`,
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
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function nseGet(url, uaIndex, timeoutMs = 15000, referer = null) {
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
  jar = new Map();
  // 1. Homepage -> AKA_A2 + ak_bmsc
  await (await nseGet(BASE, uaIndex, 10000)).text();
  await new Promise((r) => setTimeout(r, 400));
  // 2. A quote page -> _abck + nsit (required before /api/* responds)
  await (
    await nseGet(`${BASE}/get-quotes/equity?symbol=RELIANCE`, uaIndex, 10000)
  ).text();
  await new Promise((r) => setTimeout(r, 200));
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

// GET one NSE api path (with warm session, rewarm-on-block, backoff). Returns parsed JSON.
async function nseJson(url, retries = 2) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt)
      await new Promise((r) => setTimeout(r, 2 ** (attempt - 1) * 1000));
    try {
      await ensureWarm(attempt);
      const res = await nseGet(url, attempt, 15000, NSE_REF);
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
  throw new Error(`NSE fetch failed: ${last}`);
}

// Build symbol -> day-open map from the pre-open auction (iep == official open).
function openMapFrom(preopen) {
  const map = {};
  for (const d of (preopen && preopen.data) || []) {
    const m = d.metadata || {};
    if (m.symbol) map[m.symbol] = num(m.iep) ?? num(m.lastPrice);
  }
  return map;
}

// Build indexName -> index-level headline {last, variation, pChange, open, high,
// low, prevClose} from allIndices. This is the index's own points value.
function levelMapFrom(allIndices) {
  const map = {};
  for (const r of (allIndices && allIndices.data) || []) {
    if (!r || !r.index) continue;
    map[r.index] = {
      last: num(r.last),
      variation: num(r.variation),
      pChange: num(r.percentChange),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      prevClose: num(r.previousClose),
    };
  }
  return map;
}

// Fetch one index's live constituents from heatmap-symbols, stripping the
// index's own pseudo-row (e.g. a "NIFTY 50" row inside the NIFTY 50 response).
async function fetchHeatmapRows(indexName) {
  const j = await nseJson(HEATMAP_URL(indexName));
  const arr = Array.isArray(j) ? j : (j && j.data) || [];
  return arr.filter((r) => r.symbol && r.symbol !== indexName);
}

// Merge live heatmap-symbols rows with the pre-open open map into the shape
// index.html expects. Empty heatmap-symbols (market closed) => empty data[] (a success).
function buildPayload(rows, opens, level) {
  const data = [];
  let adv = 0,
    dec = 0,
    unch = 0,
    stamp = null;
  for (const r of rows) {
    const pChange = num(r.pChange);
    const change = num(r.change); // ₹ change vs previous close
    const lastPrice = num(r.lastPrice);
    // Previous close = last - change (heatmap-symbols has no explicit prevClose field).
    const prevClose =
      lastPrice != null && change != null
        ? +(lastPrice - change).toFixed(2)
        : null;
    stamp = stamp || r.lastUpdatedTime || null;
    if (pChange != null) {
      if (pChange > 0.05) adv++;
      else if (pChange < -0.05) dec++;
      else unch++;
    }
    data.push({
      symbol: r.symbol,
      open: opens[r.symbol] ?? null, // from pre-open auction (= official day open)
      dayHigh: num(r.high),
      dayLow: num(r.low),
      lastPrice,
      prevClose,
      change,
      pChange,
      totalTradedVolume: num(r.totalTradedVolume),
    });
  }
  return {
    source: "nseindia:heatmap-symbols+pre-open(ALL)+allIndices",
    timestamp: stamp,
    marketDataLive: data.length > 0,
    level: level || null, // the index's own points value (from allIndices)
    advance: { advances: adv, declines: dec, unchanged: unch },
    data,
  };
}

// Fetch NIFTY 50 and NIFTY NEXT 50 in one round trip.
async function fetchAllIndices() {
  const [n50rows, next50rows, preopen, allIndices] = await Promise.all([
    fetchHeatmapRows("NIFTY 50"),
    fetchHeatmapRows("NIFTY NEXT 50"),
    nseJson(PREOPEN_ALL_URL).catch(() => ({ data: [] })), // open is nice-to-have; don't fail the whole poll
    nseJson(ALL_INDICES_URL).catch(() => ({ data: [] })), // index level is nice-to-have too
  ]);
  const opens = openMapFrom(preopen);
  const levels = levelMapFrom(allIndices);

  return {
    "NIFTY 50": buildPayload(n50rows, opens, levels["NIFTY 50"]),
    "NIFTY NEXT 50": buildPayload(
      next50rows,
      opens,
      levels["NIFTY NEXT 50"],
    ),
  };
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

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/api/indices") {
    try {
      const data = await fetchAllIndices();
      send(res, 200, JSON.stringify(data), "application/json; charset=utf-8");
    } catch (e) {
      send(
        res,
        502,
        JSON.stringify({ error: String((e && e.message) || e) }),
        "application/json; charset=utf-8",
      );
    }
    return;
  }
  if (url === "/" || url === "/index.html") {
    const fp = path.join(HERE, "index.html");
    fs.readFile(fp, (err, buf) => {
      if (err) send(res, 404, "index.html not found", "text/plain");
      else send(res, 200, buf, "text/html; charset=utf-8");
    });
    return;
  }
  send(res, 404, "Not found", "text/plain");
});

async function main() {
  console.log(
    "\n  Trading Tracker - NIFTY 50 / NIFTY NEXT 50 dashboard (Node)",
  );
  console.log(
    "  Source: NSE heatmap-symbols (live OHLC) + market-data-pre-open?key=ALL (open)",
  );
  console.log("  Self-test: fetching both indices from NSE ...");
  try {
    const j = await fetchAllIndices();
    for (const key of ["NIFTY 50", "NIFTY NEXT 50"]) {
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
          `  OK [${key}] - got ${n} constituents (NSE stamp: ${j[key].timestamp})`,
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
          `  OK [${key}] - NSE reachable, but constituents list is EMPTY (market closed).`,
        );
      }
    }
    console.log(
      "  Live data flows Mon–Fri 09:15–15:30 IST; the dashboard fills automatically then.",
    );
  } catch (e) {
    console.log(`  WARNING - fetch failed: ${(e && e.message) || e}`);
    console.log(
      "  If HTTP 401/403, NSE anti-bot blocked this network (VPN/datacentre).",
    );
  }
  server.listen(PORT, HOST, () => {
    console.log(`\n  Serving on http://${HOST}:${PORT}/`);
    console.log("  Open that URL in your browser. Ctrl-C to stop.\n");
  });
}
main();
