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
 * Fires create durable per-user Telegram deliveries + are marked "ringing" for the
 * in-page popup/sound. Snooze clears the current ring (re-rings on the next fire);
 * Close deactivates the alert. Evaluation is driven by server.js only in market hours.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { connectMongoWithRetry } = require("./mongo-retry");
const { DurableOutbox } = require("./durable-outbox");
const { istNow, istFromMs, istLogTs } = require("./utils");

const ROOT = path.join(__dirname, ".."); // repo root (config lives here)
const STORE_DIR = path.join(ROOT, "store"); // alert + user data files live here
const STORE_FILE = path.join(STORE_DIR, "alerts.json");
const OUTBOX_FILE = path.join(STORE_DIR, "alert-outbox.json");
const CONFIG_FILE = path.join(ROOT, "config.json");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "alerts-errors.log");

// Append a dated line to logs/alerts-errors.log and echo to the console.
function logError(scope, err) {
  const msg = err && err.message ? err.message : String(err == null ? "" : err);
  const line = `[${istLogTs()}] ERROR [${scope}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    /* logging must never throw */
  }
  console.error("  " + line.trimEnd());
}

const outbox = new DurableOutbox(OUTBOX_FILE, { logError });

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

// Runtime materialized state. Events are append-only audit records and intentionally
// remain after an alert is archived or deleted.
let store = {
  alerts: [],
  archived: [],
  events: [],
  notifications: [],
  symbols: {},
};
let usersProvider = () => [];
let eventSink = () => {};
let changeSink = () => {};

// ---------- persistence ----------
// Backing store: MongoDB Atlas if `mongo.uri` is configured AND reachable, otherwise the
// local alerts.json file. The in-memory `store` is the runtime source of truth; save()
// writes through to both (Mongo async fire-and-forget + alerts.json as a local cache/
// fallback), so a Mongo outage degrades gracefully instead of blanking the app.
// MongoDB schema (proper, per-record):
//   collection `alerts`          -> one doc per ACTIVE alert, _id = alert.id
//   collection `archived_alerts` -> one doc per CLOSED alert (moved on close) - keeps the
//                                   active `alerts` collection small / easy to manage
//   collection `alert_events`    -> immutable lifecycle + review history
//   collection `user_notifications` -> per-user event receipts
//   collection `meta`            -> { _id:"symbols", data:{ index: [symbols] } }
// The local alerts.json (single file, now with an `archived` array) is the offline cache.
let backend = "file"; // "file" | "mongo"
let alertsColl = null; // per-alert documents (active)
let archivedColl = null; // per-alert documents (closed / archived)
let eventsColl = null; // immutable alert lifecycle + review records
let notificationsColl = null; // per-user event receipts
let metaColl = null; // small meta docs (symbol cache)
let processedColl = null; // idempotency ledger for outbox operations
let tombstonesColl = null; // prevents delayed operations from resurrecting alerts
let mongoUri = "";
let reconnectTimer = null;
const syncConflicts = [];
function readFileStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
      archived: Array.isArray(raw.archived) ? raw.archived : [],
      events: Array.isArray(raw.events) ? raw.events : [],
      notifications: Array.isArray(raw.notifications) ? raw.notifications : [],
      symbols:
        raw.symbols && typeof raw.symbols === "object" ? raw.symbols : {},
    };
  } catch (_) {
    return {
      alerts: [],
      archived: [],
      events: [],
      notifications: [],
      symbols: {},
    };
  }
}
// backfill the tri-state review fields on a single alert, deriving from the legacy
// boolean `zoneVerified` when present. Ensures all 4 fields exist afterward.
function migrateReview(a) {
  if (a.reviewState === undefined) {
    if (a.zoneVerified === true) {
      a.reviewState = "approved";
      a.reviewer = "(migrated)";
      a.reviewReason = "(migrated from verify)";
      a.reviewedAt = istNow();
    } else {
      a.reviewState = "pending";
      a.reviewer = "";
      a.reviewReason = "";
      a.reviewedAt = null;
    }
  }
  if (a.reviewState === "raw") a.reviewState = "pending";
  // backfill defaults if partially present (e.g. hand-edited record)
  if (a.reviewer === undefined) a.reviewer = "";
  if (a.reviewReason === undefined) a.reviewReason = "";
  if (a.reviewedAt === undefined) a.reviewedAt = null;
  delete a.zoneVerified;
}
function migrateIdentity(alert, users) {
  const candidates = Array.isArray(users) ? users : [];
  const legacyName = String(alert.createdByUsername || alert.zoneCreator || "").trim();
  const match = candidates.find(
    (user) =>
      user.id === alert.createdByUserId ||
      (legacyName && user.username.toLowerCase() === legacyName.toLowerCase()),
  );
  if (!alert.createdByUserId) alert.createdByUserId = match ? match.id : null;
  if (!alert.createdByUsername)
    alert.createdByUsername = match ? match.username : legacyName;
  if (!alert.createdByRole)
    alert.createdByRole = match ? match.role : "unknown";
  alert.zoneCreator = alert.createdByUsername || legacyName;
  if (!Number.isInteger(alert.version) || alert.version < 1) alert.version = 1;
}
// migrate/backfill older records to the current schema (runs on whatever we loaded)
function migrate(users) {
  if (!Array.isArray(store.archived)) store.archived = [];
  if (!Array.isArray(store.events)) store.events = [];
  if (!Array.isArray(store.notifications)) store.notifications = [];
  for (const a of store.archived) {
    migrateReview(a);
    migrateIdentity(a, users);
  }
  for (const a of store.alerts) {
    if (a.reanchorChecked === undefined) a.reanchorChecked = false;
    migrateReview(a);
    migrateIdentity(a, users);
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
    const nowIso = istNow();
    for (const a of stillClosed) {
      if (!a.archivedAt) a.archivedAt = a.updatedAt || nowIso;
    }
    store.archived.push(...stillClosed);
    store.alerts = store.alerts.filter((a) => a.status !== "closed");
  }
  store.archived.sort((x, y) =>
    (y.archivedAt || "").localeCompare(x.archivedAt || ""),
  );
}
function mongoDocument(doc) {
  return { ...doc, _id: doc.id };
}
async function putAlert(payload) {
  const { doc, location } = payload;
  const tombstone = await tombstonesColl.findOne({ _id: doc.id });
  if (tombstone && tombstone.version >= doc.version) return;
  const target = location === "archived" ? archivedColl : alertsColl;
  const other = location === "archived" ? alertsColl : archivedColl;
  const current = await target.findOne({ _id: doc.id }, { projection: { version: 1 } });
  if (current && Number(current.version || 0) > doc.version)
    return {
      alertId: doc.id,
      localVersion: doc.version,
      mongoVersion: current.version,
      detectedAt: istNow(),
    };
  await target.replaceOne({ _id: doc.id }, mongoDocument(doc), { upsert: true });
  await other.deleteOne({ _id: doc.id, version: { $lte: doc.version } });
  if (location === "archived") {
    await tombstonesColl.updateOne(
      { _id: doc.id },
      { $max: { version: doc.version }, $set: { type: "closed", at: doc.archivedAt } },
      { upsert: true },
    );
  } else if (tombstone && doc.version > tombstone.version) {
    await tombstonesColl.deleteOne({ _id: doc.id });
  }
}
async function processOutboxOperation(operation) {
  if (await processedColl.findOne({ _id: operation.operationId })) return;
  const { type, payload } = operation;
  let outcome = null;
  if (type === "ALERT_PUT") {
    const conflict = await putAlert(payload);
    if (conflict) {
      outcome = { status: "conflict", ...conflict };
      syncConflicts.unshift(conflict);
      if (syncConflicts.length > 100) syncConflicts.length = 100;
      logError(
        "outbox.conflict",
        `${conflict.alertId}: local v${conflict.localVersion}, Mongo v${conflict.mongoVersion}`,
      );
    }
  }
  else if (type === "ALERT_DELETE") {
    await tombstonesColl.updateOne(
      { _id: payload.id },
      {
        $max: { version: payload.version },
        $set: { type: "deleted", at: payload.at },
      },
      { upsert: true },
    );
    await Promise.all([
      alertsColl.deleteOne({ _id: payload.id, version: { $lte: payload.version } }),
      archivedColl.deleteOne({ _id: payload.id, version: { $lte: payload.version } }),
    ]);
  } else if (type === "EVENT_PUT") {
    await eventsColl.updateOne(
      { _id: payload.id },
      { $setOnInsert: mongoDocument(payload) },
      { upsert: true },
    );
  } else if (type === "NOTIFICATION_PUT") {
    const id = `${payload.userId}:${payload.eventId}`;
    await notificationsColl.replaceOne(
      { _id: id },
      { ...payload, _id: id },
      { upsert: true },
    );
  } else if (type === "SYMBOLS_PUT") {
    await metaColl.replaceOne(
      { _id: "symbols" },
      { _id: "symbols", data: payload },
      { upsert: true },
    );
  } else {
    throw new Error(`unknown outbox operation: ${type}`);
  }
  await processedColl.updateOne(
    { _id: operation.operationId },
    { $setOnInsert: { type, processedAt: istNow(), outcome } },
    { upsert: true },
  );
}
function configureMongoCollections(db) {
  alertsColl = db.collection("alerts");
  archivedColl = db.collection("archived_alerts");
  eventsColl = db.collection("alert_events");
  notificationsColl = db.collection("user_notifications");
  metaColl = db.collection("meta");
  processedColl = db.collection("processed_operations");
  tombstonesColl = db.collection("alert_tombstones");
  outbox.setProcessor(processOutboxOperation);
}
function queueAlert(alert, location) {
  outbox.enqueue(
    "ALERT_PUT",
    { location, doc: { ...alert } },
    { dedupeKey: `alert:${alert.id}` },
  );
}
function queueDelete(alert) {
  outbox.enqueue(
    "ALERT_DELETE",
    { id: alert.id, version: alert.version, at: istNow() },
    { dedupeKey: `alert:${alert.id}` },
  );
}
function queueEvent(event) {
  outbox.enqueue("EVENT_PUT", { ...event }, { dedupeKey: `event:${event.id}` });
}
function queueNotification(notification) {
  outbox.enqueue(
    "NOTIFICATION_PUT",
    { ...notification },
    { dedupeKey: `notification:${notification.userId}:${notification.eventId}` },
  );
}
function queueAllState() {
  for (const alert of store.alerts) queueAlert(alert, "active");
  for (const alert of store.archived) queueAlert(alert, "archived");
  for (const event of store.events) queueEvent(event);
  for (const notification of store.notifications) queueNotification(notification);
  outbox.enqueue("SYMBOLS_PUT", { ...store.symbols }, { dedupeKey: "symbols" });
}
async function load(context = {}) {
  usersProvider =
    typeof context.usersProvider === "function"
      ? context.usersProvider
      : () => context.users || [];
  let seedFromLocal = false;
  mongoUri = loadConfig();
  if (mongoUri) {
    const retryCount = 3;
    try {
      const client = await connectMongoWithRetry(mongoUri, {
        retries: retryCount,
        retryDelayMs: 3000,
        serverSelectionTimeoutMS: 8000,
        onRetry: ({ retry, retries, retryDelayMs }) => {
          console.warn(
            `  alerts: MongoDB unavailable; retry ${retry}/${retries} in ${retryDelayMs / 1000}s`,
          );
        },
      });
      // db name from the URI path (…mongodb.net/<db>[?…]); default if none
      const dbName =
        (mongoUri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
        "trading_tracker";
      const db = client.db(dbName);
      configureMongoCollections(db);
      backend = "mongo";
      await outbox.drain();
      const [alertDocs, archivedDocs, eventDocs, notificationDocs, symDoc] = await Promise.all([
        alertsColl.find({}).toArray(),
        archivedColl.find({}).toArray(),
        eventsColl.find({}).sort({ at: 1 }).toArray(),
        notificationsColl.find({}).toArray(),
        metaColl.findOne({ _id: "symbols" }),
      ]);
      const strip = (d) => {
        delete d._id; // in-memory alerts key off `id`, not Mongo `_id`
        return d;
      };
      if (
        alertDocs.length ||
        archivedDocs.length ||
        eventDocs.length ||
        notificationDocs.length ||
        symDoc
      ) {
        store = {
          alerts: alertDocs.map(strip),
          archived: archivedDocs.map(strip),
          events: eventDocs.map(strip),
          notifications: notificationDocs.map(strip),
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
                events: Array.isArray(legacy.events) ? legacy.events : [],
                notifications: Array.isArray(legacy.notifications)
                  ? legacy.notifications
                  : [],
                symbols: legacy.symbols || {},
              }
            : readFileStore();
        seedFromLocal = true;
        console.log(
          `  alerts: initialized MongoDB '${dbName}' (alerts + meta)` +
            (store.alerts.length
              ? ` - seeded ${store.alerts.length} alerts from ${legacy ? "legacy state doc" : "alerts.json"}`
              : " - empty"),
        );
      }
    } catch (e) {
      logError(
        "mongo.connect",
        `failed after ${retryCount + 1} attempts: ${(e && e.message) || e} - using local alerts.json`,
      );
      alertsColl = null;
      archivedColl = null;
      eventsColl = null;
      notificationsColl = null;
      metaColl = null;
      processedColl = null;
      tombstonesColl = null;
      outbox.setProcessor(null);
      backend = "file";
      store = readFileStore();
      seedFromLocal = true;
    }
  } else {
    backend = "file";
    store = readFileStore();
    seedFromLocal = true;
  }
  migrate(context.users);
  if (backend === "mongo" && notificationsColl) {
    await notificationsColl.createIndex(
      { userId: 1, eventId: 1 },
      { unique: true },
    );
  }
  if (seedFromLocal) queueAllState();
  save(); // persist the migrated local cache; outbox handles Mongo asynchronously
  startReconnectWorker();
}
function backendName() {
  return backend;
}
function syncStatus() {
  return {
    backend,
    ...outbox.status(),
    conflicts: syncConflicts.length,
    latestConflict: syncConflicts[0] || null,
  };
}
function save() {
  // always keep a local file copy (offline cache + fallback on next start)
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    logError("file.write", `alerts.json - ${e.message}`);
  }
  if (backend === "mongo") void outbox.drain();
}
async function reconnectMongo() {
  if (!mongoUri || backend === "mongo") return;
  try {
    const client = await connectMongoWithRetry(mongoUri, {
      retries: 0,
      serverSelectionTimeoutMS: 5000,
    });
    const dbName =
      (mongoUri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
      "trading_tracker";
    configureMongoCollections(client.db(dbName));
    await notificationsColl.createIndex(
      { userId: 1, eventId: 1 },
      { unique: true },
    );
    backend = "mongo";
    await outbox.drain();
    console.log("  alerts: MongoDB reconnected; durable outbox replayed");
  } catch (error) {
    outbox.setProcessor(null);
    backend = "file";
    logError("mongo.reconnect", error);
  }
}
function startReconnectWorker() {
  if (!mongoUri || reconnectTimer) return;
  reconnectTimer = setInterval(() => void reconnectMongo(), 15_000);
  if (reconnectTimer.unref) reconnectTimer.unref();
}
function loadConfig() {
  let mongoUri = "";
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (cfg && cfg.mongo && cfg.mongo.uri)
      mongoUri = String(cfg.mongo.uri).trim();
  } catch (_) {
    /* no config.json -> Mongo stays disabled (file mode) */
  }
  return mongoUri;
}
function setEventSink(sink) {
  eventSink = typeof sink === "function" ? sink : () => {};
}
function setChangeSink(sink) {
  changeSink = typeof sink === "function" ? sink : () => {};
}
function emitChange(change) {
  try {
    changeSink(change);
  } catch (error) {
    logError("alert.change-sink", error);
  }
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
  return index
    ? store.archived.filter((alert) => alert.index === index)
    : store.archived;
}
function find(id) {
  return (
    store.alerts.find((alert) => alert.id === id) ||
    store.archived.find((alert) => alert.id === id) ||
    null
  );
}
function listEvents(alertId) {
  return store.events.filter((event) => event.alertId === alertId);
}
function symbols() {
  return store.symbols;
}

function versionConflict(alert, expectedVersion) {
  const expected = Number(expectedVersion);
  if (Number.isInteger(expected) && expected === alert.version) return null;
  return {
    error: "version conflict",
    status: 409,
    currentVersion: alert.version,
  };
}
function bumpVersion(alert, at = istNow()) {
  alert.version = (Number.isInteger(alert.version) ? alert.version : 0) + 1;
  alert.updatedAt = at;
  return at;
}
function recordEvent(alert, type, details = {}) {
  const at = details.at || istNow();
  const actor = details.actor || null;
  const event = {
    id: crypto.randomUUID(),
    alertId: alert.id,
    type,
    price: details.price == null ? null : round2(Number(details.price)),
    at,
    marketTime: details.marketTime || at,
    stateVersion: alert.version,
    actorUserId: actor ? actor.id : null,
    actorUsername: actor ? actor.username : "",
    actorRole: actor ? actor.role : "",
    text: details.text || "",
    metadata: details.metadata || {},
  };
  store.events.push(event);
  queueEvent(event);
  emitChange({ kind: "alert", alertId: alert.id, event });
  return event;
}
function createNotificationReceipts(event) {
  const users = usersProvider().filter((user) => !user.disabled);
  for (const user of users) {
    const exists = store.notifications.some(
      (receipt) => receipt.userId === user.id && receipt.eventId === event.id,
    );
    if (exists) continue;
    const receipt = {
      userId: user.id,
      eventId: event.id,
      readAt: null,
      dismissedAt: null,
      acknowledgedAt: null,
      snoozedUntil: null,
    };
    store.notifications.push(receipt);
    queueNotification(receipt);
    emitChange({ kind: "notification", userId: user.id, eventId: event.id });
  }
}
function listNotifications(userId) {
  const byId = new Map(store.events.map((event) => [event.id, event]));
  return store.notifications
    .filter((receipt) => receipt.userId === userId)
    .map((receipt) => ({ ...receipt, event: byId.get(receipt.eventId) || null }))
    .filter((notification) => notification.event)
    .sort((a, b) => b.event.at.localeCompare(a.event.at));
}
function updateNotification(userId, eventId, action, options = {}) {
  const receipt = store.notifications.find(
    (item) => item.userId === userId && item.eventId === eventId,
  );
  if (!receipt) return { error: "not found" };
  const now = istNow();
  if (action === "read") receipt.readAt = receipt.readAt || now;
  else if (action === "dismiss") {
    receipt.readAt = receipt.readAt || now;
    receipt.dismissedAt = now;
  } else if (action === "snooze") {
    const minutes = Number(options.minutes == null ? 15 : options.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440)
      return { error: "snooze minutes must be between 1 and 1440" };
    receipt.snoozedUntil = istFromMs(Date.now() + minutes * 60_000);
  } else {
    return { error: "invalid notification action" };
  }
  queueNotification(receipt);
  emitChange({ kind: "notification", userId, eventId });
  save();
  return { notification: { ...receipt } };
}
function active(userId) {
  const now = istNow();
  const result = [];
  for (const alert of store.alerts) {
    const event = alert.lastEvent;
    if (!event || !RINGS.has(event.type)) continue;
    const receipt = store.notifications.find(
      (item) => item.userId === userId && item.eventId === event.id,
    );
    if (
      !receipt ||
      receipt.dismissedAt ||
      (receipt.snoozedUntil && receipt.snoozedUntil > now)
    )
      continue;
    result.push({ ...alert, lastEvent: event, ringing: true });
  }
  return result;
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
  else if (side === "BUY" && alertPrice > 0 && stopLoss >= alertPrice)
    errors.push("stop loss must be below entry price for BUY");
  else if (side === "SELL" && alertPrice > 0 && stopLoss <= alertPrice)
    errors.push("stop loss must be above entry price for SELL");
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
  // Review is independent from market lifecycle. New or edited definitions need review.
  alert.reviewState = "pending"; // pending | approved | rejected
  alert.reviewer = "";
  alert.reviewerUserId = null;
  alert.reviewerRole = "";
  alert.reviewReason = "";
  alert.reviewedAt = null;
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

function create(input, currentPrice, actor) {
  const { errors, clean } = validate(input);
  if (errors.length) return { error: errors.join("; ") };
  const now = istNow();
  const offsetPct = offsetFor(clean.timeframe);
  const stepPct = stepFor(clean.timeframe, offsetPct);
  const alertPrice = round2(clean.alertPrice);
  const stopLoss = round2(clean.stopLoss);
  const rawTrigger = triggerFor(clean.side, alertPrice, offsetPct);
  const triggerPrice = rawTrigger;
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
    zoneCreator: actor.username,
    createdByUserId: actor.id,
    createdByUsername: actor.username,
    createdByRole: actor.role,
    version: 1,
    note: clean.note,
    candleDate: clean.candleDate, // optional
    candleTime: clean.candleTime, // optional
    createdAt: now,
    updatedAt: now,
  });
  store.alerts.push(alert);
  recordEvent(alert, "CREATED", { actor });
  queueAlert(alert, "active");
  save();
  return { alert };
}

function update(id, input, currentPrice, actor, expectedVersion) {
  const alert = store.alerts.find((a) => a.id === id);
  if (!alert) return { error: "not found" };
  const conflict = versionConflict(alert, expectedVersion);
  if (conflict) return conflict;
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
  freshState(alert); // editing re-arms the alert from scratch
  alert.triggerPrice = rawTrigger;
  bumpVersion(alert);
  recordEvent(alert, "UPDATED", { actor });
  queueAlert(alert, "active");
  save();
  return { alert };
}

function remove(id, actor, expectedVersion) {
  let i = store.alerts.findIndex((a) => a.id === id);
  if (i >= 0) {
    const alert = store.alerts[i];
    const conflict = versionConflict(alert, expectedVersion);
    if (conflict) return conflict;
    bumpVersion(alert);
    recordEvent(alert, "DELETED", { actor });
    queueDelete(alert);
    store.alerts.splice(i, 1);
    save();
    return { ok: true };
  }
  // also allow deleting an archived (closed) alert
  i = store.archived.findIndex((a) => a.id === id);
  if (i >= 0) {
    const alert = store.archived[i];
    const conflict = versionConflict(alert, expectedVersion);
    if (conflict) return conflict;
    bumpVersion(alert);
    recordEvent(alert, "DELETED", { actor });
    queueDelete(alert);
    store.archived.splice(i, 1);
    save();
    return { ok: true };
  }
  return { error: "not found" };
}

function snooze(id, userId, minutes) {
  const alert = find(id);
  if (!alert) return { error: "not found" };
  const eventId = alert.lastEvent && alert.lastEvent.id;
  if (!eventId) return { error: "notification not found", status: 404 };
  const result = updateNotification(userId, eventId, "snooze", { minutes });
  return result.error ? result : { alert };
}

// Move a closed alert out of the active list into the archive (keeps the active
// `alerts` list / collection small). Safe to call after the evaluate loop, not during it.
function archiveAlert(id, details = {}) {
  const i = store.alerts.findIndex((a) => a.id === id);
  if (i < 0) return null;
  const [alert] = store.alerts.splice(i, 1);
  alert.status = "closed";
  alert.ringing = false;
  const at = istNow();
  alert.archivedAt = at;
  bumpVersion(alert, at);
  recordEvent(alert, details.type || "CLOSED", {
    actor: details.actor,
    price: details.price,
    at,
    metadata: details.metadata,
  });
  store.archived.unshift(alert);
  queueAlert(alert, "archived");
  return alert;
}

function close(id, actor, expectedVersion) {
  const alert = store.alerts.find((a) => a.id === id);
  if (!alert) return { error: "not found" };
  const conflict = versionConflict(alert, expectedVersion);
  if (conflict) return conflict;
  alert.ringing = false;
  alert.snoozed = false;
  archiveAlert(id, { actor }); // deactivate + move to the archive
  save();
  return { alert };
}

// Re-arm an alert (active or closed) to a clean pre-entry state, applying the SAME
// current-price logic as creation: recompute trigger/targets, re-anchor against the live
// price, and mark it already-entered if the price is past the entry. Keeps the definition
// and createdAt; resets all fired/zone state. Preserves the review decision.
// A closed alert is pulled back out of the archive into the active list.
function rearm(id, currentPrice, actor, expectedVersion) {
  let alert = store.alerts.find((a) => a.id === id);
  if (alert) {
    const conflict = versionConflict(alert, expectedVersion);
    if (conflict) return conflict;
  }
  if (!alert) {
    const i = store.archived.findIndex((a) => a.id === id);
    if (i < 0) return { error: "not found" };
    const conflict = versionConflict(store.archived[i], expectedVersion);
    if (conflict) return conflict;
    alert = store.archived.splice(i, 1)[0];
    delete alert.archivedAt;
    store.alerts.push(alert);
  }
  const review = {
    reviewState: alert.reviewState,
    reviewer: alert.reviewer,
    reviewerUserId: alert.reviewerUserId,
    reviewerRole: alert.reviewerRole,
    reviewReason: alert.reviewReason,
    reviewedAt: alert.reviewedAt,
  };
  alert.offsetPct = offsetFor(alert.timeframe);
  alert.stepPct = stepFor(alert.timeframe, alert.offsetPct);
  const t = targetsFor(alert.side, alert.alertPrice, alert.stopLoss);
  alert.riskR = t.riskR;
  alert.target3 = t.target3;
  alert.target5 = t.target5;
  alert.profit3 = t.profit3;
  alert.profit5 = t.profit5;
  freshState(alert);
  Object.assign(alert, review); // preserve the review decision across re-arm
  // creation-time logic: raw trigger, re-anchor to current price, entered-if-past-entry
  alert.triggerPrice = reanchorTrigger(
    alert.side,
    triggerFor(alert.side, alert.alertPrice, alert.offsetPct),
    alert.alertPrice,
    currentPrice,
  );
  if (currentPrice > 0) alert.reanchorChecked = true;
  markEnteredIfPastEntry(alert, currentPrice);
  bumpVersion(alert);
  recordEvent(alert, "REARMED", { actor });
  queueAlert(alert, "active");
  save();
  return { alert };
}

// Manual review decision - approve or reject an alert's zone (gates whether it raises;
// see fire()). Transitions between raw/approved/rejected all go through here, so toggling
// back and forth (e.g. approved -> rejected) just re-runs this with the new decision.
function review(id, decision, reason, actor, expectedVersion) {
  const alert = find(id);
  if (!alert) return { error: "not found" };
  const conflict = versionConflict(alert, expectedVersion);
  if (conflict) return conflict;
  const trimmed = String(reason || "").trim();
  if (!trimmed) return { error: "reason is required" };
  if (decision !== "approve" && decision !== "reject")
    return { error: "decision must be approve or reject" };
  alert.reviewState = decision === "approve" ? "approved" : "rejected";
  alert.reviewer = actor.username;
  alert.reviewerUserId = actor.id;
  alert.reviewerRole = actor.role;
  alert.reviewReason = trimmed;
  alert.reviewedAt = istNow();
  bumpVersion(alert);
  recordEvent(alert, decision === "approve" ? "APPROVED" : "REJECTED", {
    actor,
    metadata: { reason: trimmed },
  });
  queueAlert(
    alert,
    store.archived.some((item) => item.id === alert.id) ? "archived" : "active",
  );
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
  if (changed) {
    outbox.enqueue("SYMBOLS_PUT", { ...store.symbols }, { dedupeKey: "symbols" });
    save();
  }
}

// ---------- notifications ----------
const EVENT_HEAD = {
  TRIGGER: "🔔 Alert",
  REALERT: "🔁 Re-alert",
  ENTRY: "🎯 Entry (entry price reached)",
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
    `Reviewed by: ${alert.reviewer || "-"}`,
  ].join("\n");
}

// Emit one immutable lifecycle event. Review gating happens before evaluation, so every
// call here belongs to an approved alert and may be broadcast to all eligible users.
function fire(alert, type, ltp, opts) {
  const ring = opts && opts.ring !== undefined ? opts.ring : RINGS.has(type);
  const text = messageFor(alert, type, ltp);
  const at = istNow();
  alert.firedCount++;
  alert.ringing = ring; // silent (non-ring) events clear any prior ring
  if (ring) alert.snoozed = false;
  bumpVersion(alert, at);
  const event = recordEvent(alert, type, {
    price: ltp,
    at,
    text,
    metadata: {
      symbol: alert.symbol,
      index: alert.index,
      side: alert.side,
    },
  });
  createNotificationReceipts(event);
  alert.lastEvent = event;
  alert.lastFiredAt = at;
  queueAlert(alert, "active");
  console.log(
    `  ALERT ${type}: ${alert.symbol} ${alert.side} @ ${ltp}${ring ? "" : " (silent)"}`,
  );
  try {
    eventSink(event);
  } catch (error) {
    logError("alert.event-sink", error);
  }
  return event;
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
  alert.updatedAt = istNow();
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
    if (alert.reviewState !== "approved") continue;
    const rows = (payload[alert.index] && payload[alert.index].data) || [];
    const row = rows.find((r) => r.symbol === alert.symbol);
    const ltp = row && Number(row.lastPrice);
    if (!(ltp > 0)) continue; // no live price (market closed / not trading) -> skip
    if (alert.status === "closed") continue;
    const buy = alert.side === "BUY";
    // During pre-open (09:00-09:15) the price is the INDICATIVE equilibrium (IEP) - a
    // provisional, volatile number set by early order-book discovery, NOT a real trade.
    const preopen =
      (payload[alert.index] && payload[alert.index].marketStatus) === "Pre-open";

    // ENTERED: gate is open - run the target/stop-loss machine only here
    if (alert.status === "active") {
      // Don't resolve SL / 3x / 5x against the pre-open IEP (a tight stop would trip on a
      // transient indicative swing before the market truly opens). The zone outcome only
      // settles in the continuous session (>=09:15). Entry/trigger below still run.
      if (preopen) continue;
      const r = evaluateZone(alert, ltp);
      if (r.fired) mutated = true;
      if (r.terminal) {
        alert.status = "closed";
        alert.updatedAt = istNow();
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
      mutated = true;
      const nt = reanchorTrigger(
        alert.side,
        alert.triggerPrice,
        alert.alertPrice,
        ltp,
      );
      if (nt !== alert.triggerPrice) {
        const previousTriggerPrice = alert.triggerPrice;
        alert.triggerPrice = nt;
        bumpVersion(alert);
        recordEvent(alert, "REANCHORED", {
          price: nt,
          metadata: { previousTriggerPrice },
        });
        queueAlert(alert, "active");
      } else {
        queueAlert(alert, "active");
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
  for (const id of toArchive) archiveAlert(id, { type: "AUTO_CLOSED" });
  if (mutated) save();
}

module.exports = {
  load,
  list,
  listArchived,
  find,
  listEvents,
  listNotifications,
  updateNotification,
  symbols,
  active,
  create,
  update,
  remove,
  snooze,
  close,
  rearm,
  review,
  updateSymbols,
  evaluate,
  setEventSink,
  setChangeSink,
  backendName,
  syncStatus,
  logError,
  config,
  INDICES,
  OFFSET_PCT,
  STEP_PCT,
};
