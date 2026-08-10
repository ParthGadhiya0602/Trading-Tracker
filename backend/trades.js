"use strict";
/**
 * Manual trade journal — engine + storage + P&L (ZERO dependencies).
 *
 * Post-hoc journal: the user logs each trade by hand. No broker, no live feed, no
 * tick/market-state coupling. A trade is created with an entry (status "open") and
 * later edited to add the exit + charges, which flips it to "closed" and lets P&L
 * derive. Intraday and swing are a first-class `tradeType` distinction.
 *
 * Storage mirrors auth.js: in-memory `store` is the runtime source of truth; save()
 * writes through to a MongoDB `trades` collection (if `mongo.uri` is set & reachable)
 * AND always to store/trades.json as an offline cache, falling back to the file when
 * Mongo is down. P&L is DERIVED on read (derive()), never hand-stored.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { connectMongoWithRetry } = require("./mongo-retry");
const { DurableOutbox } = require("./durable-outbox");
const { istNow } = require("./utils");
const { logError, logErrorOnce, resetErrorOnce } = require("./logger");

const ROOT = path.join(__dirname, ".."); // repo root (config lives here)
const STORE_DIR = path.join(ROOT, "store"); // alert + user data files live here
const STORE_FILE = path.join(STORE_DIR, "trades.json");
const OUTBOX_FILE = path.join(STORE_DIR, "trades-outbox.json");

const SCHEMA_VERSION = 1;
const TRADE_TYPES = ["intraday", "swing"];
const EXCHANGES = ["NSE", "BSE"];
const SIDES = ["BUY", "SELL"];

let store = { trades: [] };
let backend = "file"; // "file" | "mongo"
let tradesColl = null;
let processedColl = null;
let mongoUri = "";
let reconnectTimer = null;

const outbox = new DurableOutbox(OUTBOX_FILE, { logError });

// ---------- helpers ----------
function round2(n) {
  return Math.round(n * 100) / 100;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function mongoDbName(uri) {
  return (
    (uri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
    "trading_tracker"
  );
}
// A comparable epoch for an IST date (+ optional HH:MM). Both sides use the same
// assumed +05:30, so relative comparisons (exit >= entry) are correct.
function istEpoch(date, time) {
  if (!date) return NaN;
  return Date.parse(`${date}T${time && /^\d{1,2}:\d{2}$/.test(time) ? pad2(time) : "00:00"}:00+05:30`);
}
function pad2(hhmm) {
  const [h, m] = hhmm.split(":");
  return `${String(h).padStart(2, "0")}:${m}`;
}

// ---------- persistence (mirrors auth.js) ----------
function loadConfig() {
  // MONGO_URI env only; unset -> Mongo disabled (local file mode)
  return String(process.env.MONGO_URI || "").trim();
}
function readFileStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { trades: Array.isArray(raw.trades) ? raw.trades : [] };
  } catch (_) {
    return { trades: [] };
  }
}
async function load() {
  mongoUri = loadConfig();
  let seedFromLocal = false;
  if (mongoUri) {
    try {
      const client = await connectMongoWithRetry(mongoUri, {
        retries: 1,
        retryDelayMs: 2000,
        serverSelectionTimeoutMS: 6000,
      });
      configureMongo(client.db(mongoDbName(mongoUri)));
      await outbox.drain();
      backend = "mongo";
      const docs = await tradesColl.find({}).toArray();
      if (docs.length) {
        store = {
          trades: docs.map((d) => {
            delete d._id;
            return d;
          }),
        };
      } else {
        store = readFileStore();
        seedFromLocal = true;
        if (store.trades.length)
          console.log(`  trades: seeded ${store.trades.length} trades from trades.json`);
      }
    } catch (e) {
      logError("trades.mongo.connect", `${(e && e.message) || e} - using trades.json`);
      tradesColl = null;
      processedColl = null;
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
  migrate();
  save({ queue: seedFromLocal });
  startReconnectWorker();
  return backend;
}
function backendName() {
  return backend;
}
function queueTrade(trade) {
  outbox.enqueue("TRADE_PUT", { ...trade }, { dedupeKey: `trade:${trade.id}` });
}
function queueTradeDelete(id) {
  outbox.enqueue(
    "TRADE_DELETE",
    { id, at: istNow() },
    { dedupeKey: `trade:${id}` },
  );
}
async function processOutbox(operation) {
  if (await processedColl.findOne({ _id: operation.operationId })) return;
  if (operation.type === "TRADE_PUT") {
    const trade = operation.payload;
    await tradesColl.replaceOne(
      { _id: trade.id },
      { ...trade, _id: trade.id },
      { upsert: true },
    );
  } else if (operation.type === "TRADE_DELETE") {
    await tradesColl.deleteOne({ _id: operation.payload.id });
  } else {
    throw new Error(`unknown trades outbox operation: ${operation.type}`);
  }
  await processedColl.updateOne(
    { _id: operation.operationId },
    { $setOnInsert: { type: operation.type, processedAt: istNow() } },
    { upsert: true },
  );
}
function configureMongo(db) {
  tradesColl = db.collection("trades");
  // distinct ledger - do NOT share `processed_operations` with auth/alerts
  processedColl = db.collection("trades_processed_operations");
  outbox.setProcessor(processOutbox);
}
function save(options = {}) {
  if (options.queue !== false) for (const trade of store.trades) queueTrade(trade);
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    logError("trades.file.write", `trades.json - ${e.message}`);
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
    configureMongo(client.db(mongoDbName(mongoUri)));
    backend = "mongo";
    resetErrorOnce("trades.mongo.reconnect");
    await outbox.drain();
    console.log("  trades: MongoDB reconnected; durable outbox replayed");
  } catch (error) {
    backend = "file";
    outbox.setProcessor(null);
    logErrorOnce("trades.mongo.reconnect", error); // log once per outage
  }
}
function startReconnectWorker() {
  if (!mongoUri || reconnectTimer) return;
  reconnectTimer = setInterval(() => void reconnectMongo(), 15_000);
  if (reconnectTimer.unref) reconnectTimer.unref();
}
// Idempotent backfill for legacy / hand-edited rows.
function migrate() {
  let changed = false;
  for (const t of store.trades) {
    if (!t.tradeType) { t.tradeType = "intraday"; changed = true; }
    if (t.charges == null) { t.charges = 0; changed = true; }
    if (t.version == null) { t.version = 1; changed = true; }
    if (t.schemaVersion == null) { t.schemaVersion = SCHEMA_VERSION; changed = true; }
    const derivedStatus = isClosed(t) ? "closed" : "open";
    if (t.status !== derivedStatus) { t.status = derivedStatus; changed = true; }
  }
  if (changed) save({ queue: false });
}

// ---------- domain ----------
function isClosed(t) {
  return num(t.exitPrice) > 0 && !!t.exitDate;
}
// P&L is derived on read; never stored as source of truth.
function derive(t) {
  const out = { ...t };
  const entry = num(t.entryPrice);
  const qty = num(t.qty);
  const charges = num(t.charges) || 0;
  if (isClosed(t) && entry > 0 && qty > 0) {
    const exit = num(t.exitPrice);
    const gross = round2((t.side === "BUY" ? exit - entry : entry - exit) * qty);
    const net = round2(gross - charges);
    out.grossPnl = gross;
    out.netPnl = net;
    out.pnlPct = round2((net / (entry * qty)) * 100);
    const sl = num(t.stopLoss);
    out.rMultiple =
      sl > 0 && Math.abs(entry - sl) > 0
        ? round2(net / (Math.abs(entry - sl) * qty))
        : null;
    const em = istEpoch(t.entryDate, t.entryTime);
    const xm = istEpoch(t.exitDate, t.exitTime);
    out.holdingPeriodMinutes =
      Number.isFinite(em) && Number.isFinite(xm) ? Math.round((xm - em) / 60000) : null;
  } else {
    out.grossPnl = null;
    out.netPnl = null;
    out.pnlPct = null;
    out.rMultiple = null;
    out.holdingPeriodMinutes = null;
  }
  return out;
}

function validate(input) {
  const errors = [];
  const tradeType = String(input.tradeType || "").toLowerCase();
  const symbol = String(input.symbol || "").toUpperCase().trim();
  const exchange = String(input.exchange || "NSE").toUpperCase().trim();
  const index = String(input.index || "").trim();
  const side = String(input.side || "").toUpperCase();
  const qty = num(input.qty);
  const entryPrice = num(input.entryPrice);
  const entryDate = String(input.entryDate || "").trim();
  const entryTime = String(input.entryTime || "").trim();
  const exitPriceRaw = input.exitPrice;
  const exitDate = String(input.exitDate || "").trim();
  const exitTime = String(input.exitTime || "").trim();
  const stopLoss = input.stopLoss === "" || input.stopLoss == null ? null : num(input.stopLoss);
  const target = input.target === "" || input.target == null ? null : num(input.target);
  const charges = input.charges === "" || input.charges == null ? 0 : num(input.charges);
  const strategy = String(input.strategy || "").trim();
  const notes = String(input.notes || "").trim().slice(0, 500);
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const timeRe = /^(\d{1,2}):(\d{2})$/;

  if (!TRADE_TYPES.includes(tradeType)) errors.push("tradeType must be intraday or swing");
  if (!symbol) errors.push("symbol is required");
  if (!EXCHANGES.includes(exchange)) errors.push("exchange must be NSE or BSE");
  if (side !== "BUY" && side !== "SELL") errors.push("side must be BUY or SELL");
  if (!(qty > 0)) errors.push("qty must be a positive number");
  if (!(entryPrice > 0)) errors.push("entryPrice must be a positive number");
  if (!dateRe.test(entryDate) || isNaN(Date.parse(entryDate)))
    errors.push("entryDate must be a valid date (YYYY-MM-DD)");
  const etm = entryTime.match(timeRe);
  if (entryTime && (!etm || +etm[1] > 23 || +etm[2] > 59))
    errors.push("entryTime must be HH:MM (24h)");
  else if (!entryTime && tradeType === "intraday")
    errors.push("entryTime is required for intraday trades");

  // closing? exit price OR exit date present => both required
  const closing = (exitPriceRaw != null && String(exitPriceRaw) !== "") || !!exitDate;
  let exitPrice = null;
  if (closing) {
    exitPrice = num(exitPriceRaw);
    if (!(exitPrice > 0)) errors.push("exitPrice must be a positive number to close");
    if (!dateRe.test(exitDate) || isNaN(Date.parse(exitDate)))
      errors.push("exitDate must be a valid date (YYYY-MM-DD) to close");
    const xtm = exitTime.match(timeRe);
    if (exitTime && (!xtm || +xtm[1] > 23 || +xtm[2] > 59))
      errors.push("exitTime must be HH:MM (24h)");
    if (dateRe.test(entryDate) && dateRe.test(exitDate)) {
      const em = istEpoch(entryDate, entryTime);
      const xm = istEpoch(exitDate, exitTime);
      if (Number.isFinite(em) && Number.isFinite(xm) && xm < em)
        errors.push("exit must be on or after entry");
      if (tradeType === "intraday" && entryDate !== exitDate)
        errors.push("intraday entry and exit must be the same day");
      if (tradeType === "swing" && entryDate === exitDate && !errors.length)
        errors.push("swing entry and exit are on the same day - use intraday");
    }
  }

  if (stopLoss != null) {
    if (!(stopLoss > 0)) errors.push("stopLoss must be a positive number");
    else if (side === "BUY" && entryPrice > 0 && stopLoss >= entryPrice)
      errors.push("stop loss must be below entry price for BUY");
    else if (side === "SELL" && entryPrice > 0 && stopLoss <= entryPrice)
      errors.push("stop loss must be above entry price for SELL");
  }
  if (target != null) {
    if (!(target > 0)) errors.push("target must be a positive number");
    else if (side === "BUY" && entryPrice > 0 && target <= entryPrice)
      errors.push("target must be above entry price for BUY");
    else if (side === "SELL" && entryPrice > 0 && target >= entryPrice)
      errors.push("target must be below entry price for SELL");
  }
  if (!(charges >= 0)) errors.push("charges must be zero or a positive number");

  return {
    errors,
    clean: {
      tradeType,
      symbol,
      exchange,
      index: index || null,
      side,
      qty,
      entryPrice,
      entryDate,
      entryTime: entryTime || null,
      exitPrice: closing ? exitPrice : null,
      exitDate: closing ? exitDate : null,
      exitTime: closing ? exitTime || null : null,
      stopLoss,
      target,
      charges: charges || 0,
      strategy: strategy || null,
      notes: notes || null,
      tags,
    },
  };
}

// ---------- CRUD ----------
function find(id) {
  return store.trades.find((t) => t.id === id) || null;
}
function get(id) {
  const t = find(id);
  return t ? derive(t) : null;
}
function list(filters = {}) {
  let rows = store.trades;
  const f = filters;
  if (f.tradeType) rows = rows.filter((t) => t.tradeType === f.tradeType);
  if (f.status) rows = rows.filter((t) => t.status === f.status);
  if (f.side) rows = rows.filter((t) => t.side === String(f.side).toUpperCase());
  if (f.symbol) {
    const s = String(f.symbol).toUpperCase();
    rows = rows.filter((t) => (t.symbol || "").includes(s));
  }
  if (f.strategy) rows = rows.filter((t) => (t.strategy || "") === f.strategy);
  if (f.from) rows = rows.filter((t) => t.entryDate >= f.from);
  if (f.to) rows = rows.filter((t) => t.entryDate <= f.to);
  return rows
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(derive);
}

function create(input, actor) {
  const { errors, clean } = validate(input);
  if (errors.length) return { error: errors.join("; ") };
  const now = istNow();
  const trade = {
    id: crypto.randomUUID(),
    ...clean,
    status: clean.exitPrice > 0 && clean.exitDate ? "closed" : "open",
    createdByUserId: (actor && actor.id) || null,
    createdByUsername: (actor && actor.username) || null,
    createdByRole: (actor && actor.role) || null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    schemaVersion: SCHEMA_VERSION,
  };
  store.trades.push(trade);
  save();
  return { trade: derive(trade) };
}

function update(id, input, actor) {
  const existing = find(id);
  if (!existing) return { error: "not found", status: 404 };
  // merge stored + patch, then validate the full candidate
  const merged = { ...existing, ...input };
  const { errors, clean } = validate(merged);
  if (errors.length) return { error: errors.join("; ") };
  Object.assign(existing, clean, {
    status: clean.exitPrice > 0 && clean.exitDate ? "closed" : "open",
    updatedAt: istNow(),
    version: (existing.version || 1) + 1,
  });
  save();
  return { trade: derive(existing) };
}

function remove(id) {
  const i = store.trades.findIndex((t) => t.id === id);
  if (i < 0) return { error: "not found", status: 404 };
  store.trades.splice(i, 1);
  queueTradeDelete(id);
  save();
  return { ok: true };
}

function summary(filters = {}) {
  const rows = list(filters); // already derived + filtered
  const byType = {
    intraday: { open: 0, closed: 0, netPnl: 0 },
    swing: { open: 0, closed: 0, netPnl: 0 },
  };
  let open = 0;
  let closed = 0;
  let wins = 0;
  let losses = 0;
  let netPnl = 0;
  for (const t of rows) {
    const bt = byType[t.tradeType] || (byType[t.tradeType] = { open: 0, closed: 0, netPnl: 0 });
    if (t.status === "closed") {
      closed++;
      bt.closed++;
      netPnl = round2(netPnl + (t.netPnl || 0));
      bt.netPnl = round2(bt.netPnl + (t.netPnl || 0));
      if ((t.netPnl || 0) > 0) wins++;
      else if ((t.netPnl || 0) < 0) losses++;
    } else {
      open++;
      bt.open++;
    }
  }
  const resolved = wins + losses;
  return {
    open: { count: open },
    closed: {
      count: closed,
      netPnl,
      wins,
      losses,
      winRate: resolved ? round2((wins / resolved) * 100) : 0,
    },
    byType,
  };
}

module.exports = {
  load,
  list,
  get,
  find,
  create,
  update,
  remove,
  summary,
  backendName,
  derive,
  validate,
};
