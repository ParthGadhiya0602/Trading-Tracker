"use strict";
/**
 * Alert engine + storage (zero dependencies).
 *
 * Lifecycle per alert (BUY example, alert=1000 -> trigger=1100):
 *   armed     -> LTP reaches trigger (alert +10%)        => fire TRIGGER,  status=triggered
 *   triggered -> LTP rises +2% above the last fired peak => fire RE-ALERT  (monotonic)
 *   triggered -> LTP falls back below the alert price    => fire FINAL,    status=closed
 * SELL mirrors it: trigger = alert -10%; re-alert every -2% below the trough;
 * final + close when LTP rises back above the alert price.
 *
 * Fires go to Telegram (all configured recipients) + are marked "ringing" for the
 * in-page popup/sound. Snooze clears the current ring (re-rings on the next fire);
 * Close deactivates the alert. Evaluation is driven by server.js only in market hours.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HERE = __dirname;
const ROOT = path.join(HERE, ".."); // repo root (config lives here)
const STORE_DIR = path.join(ROOT, "store"); // alert + user data files live here
const STORE_FILE = path.join(STORE_DIR, "alerts.json");
const CONFIG_FILE = path.join(ROOT, "config.json");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "alerts-errors.log");

// ---------- error log (persistence/connection/notification failures) ----------
// IST timestamp "YYYY-MM-DD HH:MM:SS"
function logTs() {
  const p = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .forEach((x) => (p[x.type] = x.value));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} IST`;
}
// Append a dated line to logs/alerts-errors.log and echo to the console.
function logError(scope, err) {
  const msg = err && err.message ? err.message : String(err == null ? "" : err);
  const line = `[${logTs()}] ERROR [${scope}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    /* logging must never throw */
  }
  console.error("  " + line.trimEnd());
}

const OFFSET_PCT = 10; // default trigger offset (fallback if a timeframe is unmapped)
const STEP_PCT = 2; // default re-alert step (fallback for legacy alerts)
const STEP_DIVISOR = 5; // re-alert step = trigger offset / 5 (keeps the 10%->2% ratio)
// The indices used across the dashboard AND alerts (single source of truth). Add one
// here and it appears in both the dashboard tabs and the alert index picker; its stock
// list is then cached/refreshed automatically on every market tick.
const INDICES = [
  "NIFTY 50",
  "NIFTY NEXT 50",
  "NIFTY MIDCAP 50",
  "NIFTY MIDCAP 100",
];
// Trigger offset (%) per time frame - the pre-alert band scales with the timeframe.
// 1s-15m are tuned tight; 30m+ were retuned down to match realistic price travel
// (a stock rarely moves 4% in 30m or 20% in a day as normal noise). Kept monotonic.
const OFFSETS = {
  "1s": 0.1,
  "5s": 0.15,
  "10s": 0.2,
  "15s": 0.25,
  "30s": 0.35,
  "45s": 0.45,
  "1m": 0.5,
  "2m": 0.75,
  "3m": 1,
  "5m": 1.5,
  "10m": 2,
  "15m": 3,
  "30m": 3.5,
  "45m": 4,
  "1h": 4.5,
  "2h": 5.5,
  "3h": 6.5,
  "4h": 7.5,
  "1d": 9,
  "1w": 13,
  "1mo": 18,
  "3mo": 26,
  "6mo": 32,
  "12mo": 40,
};
function offsetFor(tf) {
  return OFFSETS[tf] != null ? OFFSETS[tf] : OFFSET_PCT;
}
// 1m-15m use a flat 0.5% re-alert step; all other frames use offset / STEP_DIVISOR.
const SMALL_TFS = ["1m", "2m", "3m", "5m", "10m", "15m"];
function stepFor(tf, offsetPct) {
  return SMALL_TFS.includes(tf) ? 0.5 : round2(offsetPct / STEP_DIVISOR);
}
// allowed chart time frames (values stored on the alert as metadata)
const TIMEFRAMES = [
  "1s",
  "5s",
  "10s",
  "15s",
  "30s",
  "45s",
  "1m",
  "2m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "45m",
  "1h",
  "2h",
  "3h",
  "4h",
  "1d",
  "1w",
  "1mo",
  "3mo",
  "6mo",
  "12mo",
];

// { alerts: [active...], archived: [closed...], symbols: { "NIFTY 50": [...], ... } }
let store = { alerts: [], archived: [], symbols: {} };
let telegram = null; // { botToken, recipients: [{chatId,label}] } or null

// ---------- persistence ----------
// Backing store: MongoDB Atlas if `mongo.uri` is configured AND reachable, otherwise the
// local alerts.json file. The in-memory `store` is the runtime source of truth; save()
// writes through to both (Mongo async fire-and-forget + alerts.json as a local cache/
// fallback), so a Mongo outage degrades gracefully instead of blanking the app.
// MongoDB schema (proper, per-record):
//   collection `alerts`          -> one doc per ACTIVE alert, _id = alert.id
//   collection `archived_alerts` -> one doc per CLOSED alert (moved on close) - keeps the
//                                   active `alerts` collection small / easy to manage
//   collection `meta`            -> { _id:"symbols", data:{ index: [symbols] } }
// The local alerts.json (single file, now with an `archived` array) is the offline cache.
let backend = "file"; // "file" | "mongo"
let alertsColl = null; // per-alert documents (active)
let archivedColl = null; // per-alert documents (closed / archived)
let metaColl = null; // small meta docs (symbol cache)
let mongoBusy = false,
  mongoDirty = false;
let mongoConfUri = null; // mongo.uri from config.json (loaded in loadConfig)

function mongoUri() {
  return mongoConfUri;
}
function readFileStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
      archived: Array.isArray(raw.archived) ? raw.archived : [],
      symbols:
        raw.symbols && typeof raw.symbols === "object" ? raw.symbols : {},
    };
  } catch (_) {
    return { alerts: [], archived: [], symbols: {} };
  }
}
// migrate/backfill older records to the current schema (runs on whatever we loaded)
function migrate() {
  if (!Array.isArray(store.archived)) store.archived = [];
  for (const a of store.alerts) {
    if (a.reanchorChecked === undefined) a.reanchorChecked = false;
    if (a.zoneVerified === undefined) a.zoneVerified = false;
    if (a.zoneOutcome === undefined) a.zoneOutcome = "pending";
    if (a.offsetPct == null) a.offsetPct = offsetFor(a.timeframe);
    if (a.stepPct == null) a.stepPct = stepFor(a.timeframe, a.offsetPct);
    if (a.target5 == null && a.stopLoss > 0) {
      const t = targetsFor(a.side, a.alertPrice, a.stopLoss);
      a.riskR = t.riskR;
      a.target3 = t.target3;
      a.target5 = t.target5;
      a.profit3 = t.profit3;
      a.profit5 = t.profit5;
    }
    // new lifecycle fields (backfill for records created before the redesign)
    if (a.entered === undefined) a.entered = a.status === "active";
    if (a.lastFiredAt === undefined)
      a.lastFiredAt = (a.lastEvent && a.lastEvent.at) || null;
    // pre-entry alerts can't legitimately hold a zone outcome - the old ungated engine
    // may have set one before the price ever reached the entry. Reset it to pending.
    if (
      (a.status === "armed" || a.status === "triggered") &&
      a.zoneOutcome !== "pending"
    )
      a.zoneOutcome = "pending";
    // armed alerts: recompute the raw trigger and let them re-anchor on the next live tick
    if (a.status === "armed") {
      a.triggerPrice = triggerFor(a.side, a.alertPrice, a.offsetPct);
      a.reanchorChecked = false;
    } else if (a.triggerPrice == null) {
      a.triggerPrice = triggerFor(a.side, a.alertPrice, a.offsetPct);
    }
  }
  // move any lingering closed alerts out of the active list into the archive
  const stillClosed = store.alerts.filter((a) => a.status === "closed");
  if (stillClosed.length) {
    const nowIso = new Date().toISOString();
    for (const a of stillClosed) {
      if (!a.archivedAt) a.archivedAt = a.updatedAt || nowIso;
    }
    store.archived.push(...stillClosed);
    store.alerts = store.alerts.filter((a) => a.status !== "closed");
  }
}
async function load() {
  loadConfig();
  const uri = mongoUri();
  if (uri) {
    try {
      const { MongoClient } = require("mongodb"); // lazy: only needed for Mongo mode
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      // db name from the URI path (…mongodb.net/<db>[?…]); default if none
      const dbName =
        (uri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
        "trading_tracker";
      const db = client.db(dbName);
      alertsColl = db.collection("alerts");
      archivedColl = db.collection("archived_alerts");
      metaColl = db.collection("meta");
      backend = "mongo";
      const [alertDocs, archivedDocs, symDoc] = await Promise.all([
        alertsColl.find({}).toArray(),
        archivedColl.find({}).toArray(),
        metaColl.findOne({ _id: "symbols" }),
      ]);
      const strip = (d) => {
        delete d._id; // in-memory alerts key off `id`, not Mongo `_id`
        return d;
      };
      if (alertDocs.length || archivedDocs.length || symDoc) {
        store = {
          alerts: alertDocs.map(strip),
          archived: archivedDocs.map(strip),
          symbols: (symDoc && symDoc.data) || {},
        };
      } else {
        // fresh DB: seed from a legacy single-doc `state` (old schema), else alerts.json.
        // The final save() below writes the per-alert docs, creating the collections.
        const legacy = await db
          .collection("state")
          .findOne({ _id: "state" })
          .catch(() => null);
        store =
          legacy && Array.isArray(legacy.alerts)
            ? {
                alerts: legacy.alerts,
                archived: Array.isArray(legacy.archived) ? legacy.archived : [],
                symbols: legacy.symbols || {},
              }
            : readFileStore();
        console.log(
          `  alerts: initialized MongoDB '${dbName}' (alerts + meta)` +
            (store.alerts.length
              ? ` - seeded ${store.alerts.length} alerts from ${legacy ? "legacy state doc" : "alerts.json"}`
              : " - empty"),
        );
      }
    } catch (e) {
      logError("mongo.connect", `${(e && e.message) || e} - using local alerts.json`);
      alertsColl = null;
      metaColl = null;
      backend = "file";
      store = readFileStore();
    }
  } else {
    backend = "file";
    store = readFileStore();
  }
  migrate();
  save(); // persist the migrated shape to the active backend
}
function backendName() {
  return backend;
}
function save() {
  // always keep a local file copy (offline cache + fallback on next start)
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    logError("file.write", `alerts.json - ${e.message}`);
  }
  if (backend === "mongo" && alertsColl) persistMongo();
}
// Sync the in-memory alerts into the `alerts` collection (one doc each) and the symbol
// cache into meta. Upsert every current alert, delete any doc no longer present.
async function syncMongo() {
  const upserts = (coll, arr) => {
    const ids = arr.map((a) => a.id);
    const ops = arr.map((a) => ({
      replaceOne: {
        filter: { _id: a.id },
        replacement: { ...a, _id: a.id },
        upsert: true,
      },
    }));
    ops.push({ deleteMany: { filter: { _id: { $nin: ids } } } });
    return coll.bulkWrite(ops, { ordered: false });
  };
  await Promise.all([
    upserts(alertsColl, store.alerts),
    upserts(archivedColl, store.archived),
  ]);
  await metaColl.replaceOne(
    { _id: "symbols" },
    { _id: "symbols", data: store.symbols },
    { upsert: true },
  );
}
async function persistMongo() {
  if (mongoBusy) {
    mongoDirty = true;
    return;
  } // coalesce overlapping writes
  mongoBusy = true;
  try {
    await syncMongo();
  } catch (e) {
    logError("mongo.write", (e && e.message) || e);
  } finally {
    mongoBusy = false;
    if (mongoDirty) {
      mongoDirty = false;
      persistMongo();
    }
  }
}
function loadConfig() {
  telegram = null;
  mongoConfUri = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const t = cfg && cfg.telegram;
    if (t && t.botToken && Array.isArray(t.recipients) && t.recipients.length) {
      telegram = {
        botToken: t.botToken,
        recipients: t.recipients.filter((r) => r && r.chatId),
      };
    }
    if (cfg && cfg.mongo && cfg.mongo.uri)
      mongoConfUri = String(cfg.mongo.uri).trim();
  } catch (_) {
    /* no config.json -> Telegram + Mongo stay disabled (file mode) */
  }
}
function telegramConfigured() {
  return !!(telegram && telegram.recipients.length);
}
// per-timeframe trigger offsets, for the create-form preview (single source of truth)
function config() {
  return {
    offsets: OFFSETS,
    defaultOffset: OFFSET_PCT,
    stepDivisor: STEP_DIVISOR,
    indices: INDICES,
  };
}

// ---------- helpers ----------
function round2(n) {
  return Math.round(n * 100) / 100;
}
function triggerFor(side, alertPrice, offsetPct) {
  const o = offsetPct / 100;
  // BUY fires on a rise (trigger ABOVE = alert +%); SELL on a fall (trigger BELOW = alert -%)
  return round2(side === "BUY" ? alertPrice * (1 + o) : alertPrice * (1 - o));
}
// Re-anchor: if the live price is already BETWEEN the alert price and the trigger, the
// price is inside the band, so start tracking from the current price (trigger = current).
// BUY band = (alert, trigger above); SELL band = (trigger below, alert).
function reanchorTrigger(side, trigger, alertPrice, current) {
  if (!(current > 0)) return trigger;
  if (side === "BUY" && current > alertPrice && current < trigger)
    return round2(current);
  if (side === "SELL" && current < alertPrice && current > trigger)
    return round2(current);
  return trigger;
}
// Profit targets from the risk unit R = |alert - stop loss|. 3x/5x add for BUY,
// subtract for SELL. Returns the target prices and the ₹ profit at each.
function targetsFor(side, alertPrice, stopLoss) {
  const R = round2(Math.abs(alertPrice - stopLoss));
  const dir = side === "BUY" ? 1 : -1;
  return {
    riskR: R,
    target3: round2(alertPrice + dir * 3 * R),
    target5: round2(alertPrice + dir * 5 * R),
    profit3: round2(3 * R),
    profit5: round2(5 * R),
  };
}
function fmt(n) {
  return n == null || isNaN(n)
    ? "-"
    : "₹" +
        Number(n).toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
}

// ---------- CRUD ----------
function list(index) {
  const a = store.alerts;
  return index ? a.filter((x) => x.index === index) : a;
}
// archived (closed) alerts, newest-closed first
function listArchived(index) {
  const a = [...store.archived].sort((x, y) =>
    (y.archivedAt || "").localeCompare(x.archivedAt || ""),
  );
  return index ? a.filter((x) => x.index === index) : a;
}
function symbols() {
  return store.symbols;
}
function active() {
  // alerts currently ringing (unacknowledged fire) for the in-page popup/sound
  return store.alerts.filter((a) => a.ringing);
}

function validate(input, opts = {}) {
  const errors = [];
  const requireZoneCreator = opts.requireZoneCreator !== false;
  const index = String(input.index || "");
  const symbol = String(input.symbol || "").toUpperCase();
  const side = String(input.side || "").toUpperCase();
  const alertPrice = Number(input.alertPrice);
  const timeframe = String(input.timeframe || "");
  const stopLoss = Number(input.stopLoss);
  const note = String(input.note || "").trim();
  const zoneCreator = String(input.zoneCreator || "").trim();
  // candle date/time are OPTIONAL; validate only if provided
  const candleDate = String(input.candleDate || "").trim();
  const candleTime = String(input.candleTime || "").trim();
  const tm = candleTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!INDICES.includes(index))
    errors.push("index must be NIFTY 50 or NIFTY NEXT 50");
  if (!symbol) errors.push("symbol is required");
  else if (
    Array.isArray(store.symbols[index]) &&
    store.symbols[index].length &&
    !store.symbols[index].includes(symbol)
  )
    errors.push(`${symbol} is not in ${index}`);
  if (side !== "BUY" && side !== "SELL")
    errors.push("side must be BUY or SELL");
  if (!(alertPrice > 0)) errors.push("alertPrice must be a positive number");
  if (!TIMEFRAMES.includes(timeframe)) errors.push("timeframe is required");
  if (!(stopLoss > 0)) errors.push("stop loss must be a positive number");
  if (!note) errors.push("note is required");
  // on create the caller must supply a creator (set server-side from the session);
  // on edit a blank/legacy stored value shouldn't block an otherwise-valid update.
  if (!zoneCreator && requireZoneCreator)
    errors.push("zone creator name is required");
  if (
    candleDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(candleDate) || isNaN(Date.parse(candleDate)))
  )
    errors.push("candle date must be a valid date (YYYY-MM-DD)");
  if (candleTime && (!tm || +tm[1] > 23 || +tm[2] > 59))
    errors.push("candle time must be HH:MM (24h)");
  return {
    errors,
    clean: {
      index,
      symbol,
      side,
      alertPrice,
      timeframe,
      stopLoss,
      note,
      zoneCreator,
      candleDate,
      candleTime,
    },
  };
}

function freshState(alert) {
  alert.status = "armed"; // armed | triggered | active | closed
  alert.entered = false; // true once the price has touched the alert price (zone gate)
  alert.peak = null; // last fired price (peak for BUY / trough for SELL)
  alert.firedCount = 0;
  alert.ringing = false;
  alert.snoozed = false;
  alert.reanchorChecked = false; // one-time re-anchor happens on first live tick
  alert.zoneVerified = false; // someone must verify the zone (reset on create/edit)
  alert.zoneOutcome = "pending"; // pending | fail | partial | success (from live price)
  alert.lastEvent = null; // { type, price, at, text }
  alert.lastFiredAt = null; // timestamp of the most recent fire (metadata)
  return alert;
}

// If the live price is already at/past the entry when created/edited, open the zone gate
// immediately (status "active") so targets/stop-loss track from the next tick. Silent -
// no ENTRY fire at create time (avoids a notification on every prefilled create).
function markEnteredIfPastEntry(alert, currentPrice) {
  if (!(currentPrice > 0)) return;
  const buy = alert.side === "BUY";
  const past = buy
    ? currentPrice <= alert.alertPrice
    : currentPrice >= alert.alertPrice;
  if (past) {
    alert.status = "active";
    alert.entered = true;
  }
}

function create(input, currentPrice) {
  const { errors, clean } = validate(input);
  if (errors.length) return { error: errors.join("; ") };
  const now = new Date().toISOString();
  const offsetPct = offsetFor(clean.timeframe);
  const stepPct = stepFor(clean.timeframe, offsetPct);
  const alertPrice = round2(clean.alertPrice);
  const stopLoss = round2(clean.stopLoss);
  const rawTrigger = triggerFor(clean.side, alertPrice, offsetPct);
  const triggerPrice = reanchorTrigger(
    clean.side,
    rawTrigger,
    alertPrice,
    currentPrice,
  );
  const t = targetsFor(clean.side, alertPrice, stopLoss);
  const alert = freshState({
    id: crypto.randomUUID(),
    index: clean.index,
    symbol: clean.symbol,
    side: clean.side,
    alertPrice, // the target; stays as typed
    stopLoss,
    riskR: t.riskR,
    target3: t.target3,
    target5: t.target5,
    profit3: t.profit3,
    profit5: t.profit5,
    offsetPct,
    stepPct,
    triggerPrice,
    timeframe: clean.timeframe,
    zoneCreator: clean.zoneCreator,
    note: clean.note,
    candleDate: clean.candleDate, // optional
    candleTime: clean.candleTime, // optional
    createdAt: now,
    updatedAt: now,
  });
  if (currentPrice > 0) alert.reanchorChecked = true; // checked at creation
  markEnteredIfPastEntry(alert, currentPrice);
  store.alerts.push(alert);
  save();
  return { alert };
}

function update(id, input, currentPrice) {
  const alert = store.alerts.find((a) => a.id === id);
  if (!alert) return { error: "not found" };
  const merged = { ...alert, ...input };
  const { errors, clean } = validate(merged, { requireZoneCreator: false });
  if (errors.length) return { error: errors.join("; ") };
  // backfill from the existing alert if the update input carried no creator (or the
  // stored value is blank/legacy) - never let that block an otherwise-valid edit.
  clean.zoneCreator = clean.zoneCreator || alert.zoneCreator || "";
  alert.index = clean.index;
  alert.symbol = clean.symbol;
  alert.side = clean.side;
  alert.alertPrice = round2(clean.alertPrice);
  alert.stopLoss = round2(clean.stopLoss);
  alert.offsetPct = offsetFor(clean.timeframe);
  alert.stepPct = stepFor(clean.timeframe, alert.offsetPct);
  const rawTrigger = triggerFor(clean.side, clean.alertPrice, alert.offsetPct);
  const t = targetsFor(clean.side, alert.alertPrice, alert.stopLoss);
  alert.riskR = t.riskR;
  alert.target3 = t.target3;
  alert.target5 = t.target5;
  alert.profit3 = t.profit3;
  alert.profit5 = t.profit5;
  alert.timeframe = clean.timeframe;
  alert.zoneCreator = clean.zoneCreator;
  alert.note = clean.note;
  alert.candleDate = clean.candleDate;
  alert.candleTime = clean.candleTime;
  alert.updatedAt = new Date().toISOString();
  freshState(alert); // editing re-arms the alert from scratch
  alert.triggerPrice = reanchorTrigger(
    clean.side,
    rawTrigger,
    alert.alertPrice,
    currentPrice,
  );
  if (currentPrice > 0) alert.reanchorChecked = true;
  markEnteredIfPastEntry(alert, currentPrice);
  save();
  return { alert };
}

function remove(id) {
  let i = store.alerts.findIndex((a) => a.id === id);
  if (i >= 0) {
    store.alerts.splice(i, 1);
    save();
    return { ok: true };
  }
  // also allow deleting an archived (closed) alert
  i = store.archived.findIndex((a) => a.id === id);
  if (i >= 0) {
    store.archived.splice(i, 1);
    save();
    return { ok: true };
  }
  return { error: "not found" };
}

function snooze(id) {
  const alert = store.alerts.find((a) => a.id === id);
  if (!alert) return { error: "not found" };
  alert.ringing = false; // silence current ring; next fire re-rings
  alert.snoozed = true;
  alert.updatedAt = new Date().toISOString();
  save();
  return { alert };
}

// Move a closed alert out of the active list into the archive (keeps the active
// `alerts` list / collection small). Safe to call after the evaluate loop, not during it.
function archiveAlert(id) {
  const i = store.alerts.findIndex((a) => a.id === id);
  if (i < 0) return null;
  const [alert] = store.alerts.splice(i, 1);
  alert.status = "closed";
  alert.ringing = false;
  alert.archivedAt = new Date().toISOString();
  store.archived.push(alert);
  return alert;
}

function close(id) {
  const alert = store.alerts.find((a) => a.id === id);
  if (!alert) return { error: "not found" };
  alert.ringing = false;
  alert.snoozed = false;
  alert.updatedAt = new Date().toISOString();
  archiveAlert(id); // deactivate + move to the archive
  save();
  return { alert };
}

// Re-arm an alert (active or closed) to a clean pre-entry state, applying the SAME
// current-price logic as creation: recompute trigger/targets, re-anchor against the live
// price, and mark it already-entered if the price is past the entry. Keeps the definition
// and createdAt; resets all fired/zone state. Preserves the manual zoneVerified flag.
// A closed alert is pulled back out of the archive into the active list.
function rearm(id, currentPrice) {
  let alert = store.alerts.find((a) => a.id === id);
  if (!alert) {
    const i = store.archived.findIndex((a) => a.id === id);
    if (i < 0) return { error: "not found" };
    alert = store.archived.splice(i, 1)[0];
    delete alert.archivedAt;
    store.alerts.push(alert);
  }
  const verified = !!alert.zoneVerified;
  alert.offsetPct = offsetFor(alert.timeframe);
  alert.stepPct = stepFor(alert.timeframe, alert.offsetPct);
  const t = targetsFor(alert.side, alert.alertPrice, alert.stopLoss);
  alert.riskR = t.riskR;
  alert.target3 = t.target3;
  alert.target5 = t.target5;
  alert.profit3 = t.profit3;
  alert.profit5 = t.profit5;
  freshState(alert);
  alert.zoneVerified = verified; // preserve manual verification
  // creation-time logic: raw trigger, re-anchor to current price, entered-if-past-entry
  alert.triggerPrice = reanchorTrigger(
    alert.side,
    triggerFor(alert.side, alert.alertPrice, alert.offsetPct),
    alert.alertPrice,
    currentPrice,
  );
  if (currentPrice > 0) alert.reanchorChecked = true;
  markEnteredIfPastEntry(alert, currentPrice);
  alert.updatedAt = new Date().toISOString();
  save();
  return { alert };
}

// mark the alert's zone as verified / unverified (manual review flag)
function setVerified(id, verified) {
  const alert = store.alerts.find((a) => a.id === id);
  if (!alert) return { error: "not found" };
  alert.zoneVerified = !!verified;
  alert.updatedAt = new Date().toISOString();
  save();
  return { alert };
}

// ---------- symbol cache (keeps the create-form dropdown working off-hours) ----------
function updateSymbols(payload) {
  let changed = false;
  for (const index of INDICES) {
    const rows = (payload[index] && payload[index].data) || [];
    if (rows.length) {
      store.symbols[index] = rows.map((r) => r.symbol).sort();
      changed = true;
    }
  }
  if (changed) save();
}

// ---------- notifications ----------
const EVENT_HEAD = {
  TRIGGER: "🔔 Trigger",
  REALERT: "🔁 Re-trigger",
  ENTRY: "🎯 Entry (alert price reached)",
  PARTIAL: "🟡 Partial (3× hit)",
  SUCCESS: "✅ Success (5× hit)",
  FAIL: "❌ Fail (stop loss hit)",
  SL_AFTER_PARTIAL: "🟡 Closed at stop loss (partial locked)",
};
// Only approach events ring (persistent toast + Snooze/Close). Entry/Partial/Success/Fail
// notify silently (Telegram + notification center) but never prompt for an action.
const RINGS = new Set(["TRIGGER", "REALERT"]);
// One uniform labeled schema for every alert (Telegram + in-page toast).
function messageFor(alert, type, ltp) {
  const head = EVENT_HEAD[type] || "🔔 Alert";
  const side = alert.side === "BUY" ? "Buy" : "Sell";
  return [
    `${head} — ${alert.symbol} (${alert.index})`,
    `Side: ${side}`,
    `Current: ${fmt(ltp)}`,
    `Entry: ${fmt(alert.alertPrice)}`,
    `Target: ${fmt(alert.target3)} (3×) · ${fmt(alert.target5)} (5×)`,
    `Stop loss: ${fmt(alert.stopLoss)}`,
    `Time frame: ${alert.timeframe}`,
    `Creator: ${alert.zoneCreator || "-"}`,
    `Note: ${alert.note || "-"}`,
    `Verified: ${alert.zoneVerified ? "Yes" : "No"}`,
  ].join("\n");
}

async function sendTelegram(text) {
  if (!telegramConfigured()) return;
  await Promise.all(
    telegram.recipients.map(async (r) => {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${telegram.botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: r.chatId, text }),
          },
        );
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            detail = j.description || detail;
          } catch (_) {}
          logError("telegram.send", `${r.label || r.chatId} - ${detail}`);
        }
      } catch (e) {
        logError("telegram.send", `${r.label || r.chatId} - ${e.message}`);
      }
    }),
  );
}

function fire(alert, type, ltp, opts) {
  const ring = opts && opts.ring !== undefined ? opts.ring : RINGS.has(type);
  const text = messageFor(alert, type, ltp);
  const at = new Date().toISOString();
  alert.firedCount++;
  alert.ringing = ring; // silent (non-ring) events clear any prior ring
  if (ring) alert.snoozed = false;
  alert.lastEvent = { type, price: ltp, at, text };
  alert.lastFiredAt = at;
  console.log(
    `  ALERT ${type}: ${alert.symbol} ${alert.side} @ ${ltp}${ring ? "" : " (silent)"}`,
  );
  sendTelegram(text); // fire-and-forget; never blocks evaluation
}

// Trade "zone" outcome against live price. ONLY runs once the alert is entered (status
// "active"), so targets/stop-loss can't fire before the price reaches the alert price.
// Returns { fired, terminal } - terminal outcomes auto-close (Success 5×, Fail SL, and
// stop-loss after a Partial which closes keeping the "partial" status).
function evaluateZone(alert, ltp) {
  if (!(alert.stopLoss > 0) || alert.target5 == null)
    return { fired: false, terminal: false };
  const buy = alert.side === "BUY";
  const hit5 = buy ? ltp >= alert.target5 : ltp <= alert.target5;
  const hit3 = buy ? ltp >= alert.target3 : ltp <= alert.target3;
  const slHit = buy ? ltp <= alert.stopLoss : ltp >= alert.stopLoss;
  if (alert.zoneOutcome === "partial") {
    if (hit5) {
      alert.zoneOutcome = "success";
      fire(alert, "SUCCESS", round2(ltp), { ring: false });
      return { fired: true, terminal: true };
    }
    if (slHit) {
      // point 5: stop loss after 3× -> close, but keep the "partial" outcome
      fire(alert, "SL_AFTER_PARTIAL", round2(ltp), { ring: false });
      return { fired: true, terminal: true };
    }
    return { fired: false, terminal: false };
  }
  // pending (5× checked before 3× so a gap through both counts as success)
  if (slHit) {
    alert.zoneOutcome = "fail";
    fire(alert, "FAIL", round2(ltp), { ring: false });
    return { fired: true, terminal: true };
  }
  if (hit5) {
    alert.zoneOutcome = "success";
    fire(alert, "SUCCESS", round2(ltp), { ring: false });
    return { fired: true, terminal: true };
  }
  if (hit3) {
    alert.zoneOutcome = "partial";
    fire(alert, "PARTIAL", round2(ltp), { ring: false });
    return { fired: true, terminal: false };
  }
  return { fired: false, terminal: false };
}

// Enter the trade: price has touched the alert price. Opens the zone gate and marks entry
// with a silent ENTRY event (no Snooze/Close prompt).
function enterAlert(alert, ltp) {
  alert.status = "active";
  alert.entered = true;
  alert.updatedAt = new Date().toISOString();
  fire(alert, "ENTRY", round2(ltp), { ring: false });
}

// ---------- the engine: evaluate every active alert against fresh LTPs ----------
// Progression per alert: armed -> triggered (offset) -> active (entered) -> closed.
// The zone machine (3×/5×/SL) runs ONLY once entered, so it can't fire before the price
// reaches the alert price. Entry = price touches the alert price (detected in armed OR
// triggered). Terminal zone outcomes mark the alert closed (archiving lands in Phase 2).
function evaluate(payload) {
  let mutated = false;
  const toArchive = []; // ids closed this pass; moved after the loop (no mutation mid-loop)
  for (const alert of store.alerts) {
    const rows = (payload[alert.index] && payload[alert.index].data) || [];
    const row = rows.find((r) => r.symbol === alert.symbol);
    const ltp = row && Number(row.lastPrice);
    if (!(ltp > 0)) continue; // no live price (market closed / not trading) -> skip
    if (alert.status === "closed") continue;
    const buy = alert.side === "BUY";

    // ENTERED: gate is open - run the target/stop-loss machine only here
    if (alert.status === "active") {
      const r = evaluateZone(alert, ltp);
      if (r.fired) mutated = true;
      if (r.terminal) {
        alert.status = "closed";
        alert.updatedAt = new Date().toISOString();
        toArchive.push(alert.id);
        mutated = true;
      }
      continue;
    }

    // PRE-ENTRY (armed / triggered)
    // one-time re-anchor: if the live price is already between the alert price and the
    // trigger, start from the current price (trigger = current).
    if (alert.status === "armed" && !alert.reanchorChecked) {
      alert.reanchorChecked = true;
      const nt = reanchorTrigger(
        alert.side,
        alert.triggerPrice,
        alert.alertPrice,
        ltp,
      );
      if (nt !== alert.triggerPrice) {
        alert.triggerPrice = nt;
        mutated = true;
      }
    }
    // ENTRY: price touched the alert price (works whether armed or already triggered).
    const entryHit = buy ? ltp <= alert.alertPrice : ltp >= alert.alertPrice;
    if (entryHit) {
      enterAlert(alert, ltp);
      mutated = true;
      continue;
    }
    if (alert.status === "armed") {
      // TRIGGER: BUY when price RISES to the trigger (above); SELL when it FALLS to it (below)
      const hit = buy ? ltp >= alert.triggerPrice : ltp <= alert.triggerPrice;
      if (hit) {
        alert.status = "triggered";
        alert.peak = alert.triggerPrice; // re-alerts step from the trigger toward the alert
        fire(alert, "TRIGGER", round2(ltp));
        mutated = true;
      }
    } else if (alert.status === "triggered") {
      // RE-ALERT: step toward the alert price by stepPct (BUY down, SELL up)
      const sp = (alert.stepPct != null ? alert.stepPct : STEP_PCT) / 100;
      const step = buy
        ? ltp <= alert.peak * (1 - sp)
        : ltp >= alert.peak * (1 + sp);
      if (step) {
        alert.peak = round2(ltp);
        fire(alert, "REALERT", round2(ltp));
        mutated = true;
      }
    }
  }
  // move alerts closed this pass into the archive (after iterating store.alerts)
  for (const id of toArchive) archiveAlert(id);
  if (mutated) save();
}

module.exports = {
  load,
  list,
  listArchived,
  symbols,
  active,
  create,
  update,
  remove,
  snooze,
  close,
  rearm,
  setVerified,
  updateSymbols,
  evaluate,
  telegramConfigured,
  backendName,
  logError,
  config,
  INDICES,
  OFFSET_PCT,
  STEP_PCT,
};
