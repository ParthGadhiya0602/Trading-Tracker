"use strict";
/**
 * Manual trade journal — validation, storage, and derived P&L.
 *
 * Post-hoc journal: the user logs each trade by hand. No broker, no live feed, no
 * tick/market-state coupling. A trade is created with an entry (status "open") and
 * later edited to add the exit + charges, which flips it to "closed" and lets P&L
 * derive. Intraday and swing are a first-class `tradeType` distinction.
 *
 * Storage mirrors auth.js: in-memory `store` is the runtime source of truth; save()
 * writes through to a MongoDB `trades` collection (if MONGO_URI is set and reachable)
 * AND always to store/trades.json as an offline cache, falling back to the file when
 * Mongo is down. P&L is DERIVED on read (derive()), never hand-stored.
 *
 * Exported as a shared singleton (drop-in for the old function-module API); the
 * TradesRepo class is attached for tests / isolated instances.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { connectMongoWithRetry } = require("./mongo-retry");
const { DurableOutbox } = require("./durable-outbox");
const { istNow } = require("./utils");
const { logError, logErrorOnce, resetErrorOnce } = require("./logger");

const ROOT = path.join(__dirname, ".."); // repo root for local stores and logs
const STORE_DIR = path.join(ROOT, "store"); // alert + user data files live here
const STORE_FILE = path.join(STORE_DIR, "trades.json");
const OUTBOX_FILE = path.join(STORE_DIR, "trades-outbox.json");

const SCHEMA_VERSION = 1;
const TRADE_TYPES = ["intraday", "swing"];
const EXCHANGES = ["NSE", "BSE"];
const SIDES = ["BUY", "SELL"];

// ---------- pure helpers (no instance state) ----------
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
function pad2(hhmm) {
  const [h, m] = hhmm.split(":");
  return `${String(h).padStart(2, "0")}:${m}`;
}
// A comparable epoch for an IST date (+ optional HH:MM). Both sides use the same
// assumed +05:30, so relative comparisons (exit >= entry) are correct.
function istEpoch(date, time) {
  if (!date) return NaN;
  return Date.parse(`${date}T${time && /^\d{1,2}:\d{2}$/.test(time) ? pad2(time) : "00:00"}:00+05:30`);
}
function loadConfig() {
  // MONGO_URI env only; unset -> Mongo disabled (local file mode)
  return String(process.env.MONGO_URI || "").trim();
}

// ---------- domain (pure) ----------
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

// Trade journal repository: owns the in-memory store, Mongo↔file backend, and durable outbox.
class TradesRepo {
  constructor() {
    this.store = { trades: [] };
    this.backend = "file"; // "file" | "mongo"
    this.tradesColl = null;
    this.processedColl = null;
    this.mongoUri = "";
    this.reconnectTimer = null;
    this.outbox = new DurableOutbox(OUTBOX_FILE, { logError });
  }

  // ---------- persistence (mirrors auth.js) ----------
  #readFileStore() {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      return { trades: Array.isArray(raw.trades) ? raw.trades : [] };
    } catch (_) {
      return { trades: [] };
    }
  }

  async load() {
    this.mongoUri = loadConfig();
    let seedFromLocal = false;
    if (this.mongoUri) {
      try {
        const client = await connectMongoWithRetry(this.mongoUri, {
          retries: 1,
          retryDelayMs: 2000,
          serverSelectionTimeoutMS: 6000,
        });
        this.#configureMongo(client.db(mongoDbName(this.mongoUri)));
        await this.outbox.drain();
        this.backend = "mongo";
        const docs = await this.tradesColl.find({}).toArray();
        if (docs.length) {
          this.store = {
            trades: docs.map((d) => {
              delete d._id;
              return d;
            }),
          };
        } else {
          this.store = this.#readFileStore();
          seedFromLocal = true;
          if (this.store.trades.length)
            console.log(`  trades: seeded ${this.store.trades.length} trades from trades.json`);
        }
      } catch (e) {
        logError("trades.mongo.connect", `${(e && e.message) || e} - using trades.json`);
        this.tradesColl = null;
        this.processedColl = null;
        this.outbox.setProcessor(null);
        this.backend = "file";
        this.store = this.#readFileStore();
        seedFromLocal = true;
      }
    } else {
      this.backend = "file";
      this.store = this.#readFileStore();
      seedFromLocal = true;
    }
    this.#migrate();
    this.#save({ queue: seedFromLocal });
    this.#startReconnectWorker();
    return this.backend;
  }

  backendName() {
    return this.backend;
  }

  #queueTrade(trade) {
    this.outbox.enqueue("TRADE_PUT", { ...trade }, { dedupeKey: `trade:${trade.id}` });
  }
  #queueTradeDelete(id) {
    this.outbox.enqueue(
      "TRADE_DELETE",
      { id, at: istNow() },
      { dedupeKey: `trade:${id}` },
    );
  }

  async #processOutbox(operation) {
    if (await this.processedColl.findOne({ _id: operation.operationId })) return;
    if (operation.type === "TRADE_PUT") {
      const trade = operation.payload;
      await this.tradesColl.replaceOne(
        { _id: trade.id },
        { ...trade, _id: trade.id },
        { upsert: true },
      );
    } else if (operation.type === "TRADE_DELETE") {
      await this.tradesColl.deleteOne({ _id: operation.payload.id });
    } else {
      throw new Error(`unknown trades outbox operation: ${operation.type}`);
    }
    await this.processedColl.updateOne(
      { _id: operation.operationId },
      { $setOnInsert: { type: operation.type, processedAt: istNow() } },
      { upsert: true },
    );
  }

  #configureMongo(db) {
    this.tradesColl = db.collection("trades");
    // distinct ledger - do NOT share `processed_operations` with auth/alerts
    this.processedColl = db.collection("trades_processed_operations");
    this.outbox.setProcessor((operation) => this.#processOutbox(operation));
  }

  #save(options = {}) {
    if (options.queue !== false) for (const trade of this.store.trades) this.#queueTrade(trade);
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(this.store, null, 2));
    } catch (e) {
      logError("trades.file.write", `trades.json - ${e.message}`);
    }
    if (this.backend === "mongo") void this.outbox.drain();
  }

  async #reconnectMongo() {
    if (!this.mongoUri || this.backend === "mongo") return;
    try {
      const client = await connectMongoWithRetry(this.mongoUri, {
        retries: 0,
        serverSelectionTimeoutMS: 5000,
      });
      this.#configureMongo(client.db(mongoDbName(this.mongoUri)));
      this.backend = "mongo";
      resetErrorOnce("trades.mongo.reconnect");
      await this.outbox.drain();
      console.log("  trades: MongoDB reconnected; durable outbox replayed");
    } catch (error) {
      this.backend = "file";
      this.outbox.setProcessor(null);
      logErrorOnce("trades.mongo.reconnect", error); // log once per outage
    }
  }

  #startReconnectWorker() {
    if (!this.mongoUri || this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => void this.#reconnectMongo(), 15_000);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  // Idempotent backfill for legacy / hand-edited rows.
  #migrate() {
    let changed = false;
    for (const t of this.store.trades) {
      if (!t.tradeType) { t.tradeType = "intraday"; changed = true; }
      if (t.charges == null) { t.charges = 0; changed = true; }
      if (t.version == null) { t.version = 1; changed = true; }
      if (t.schemaVersion == null) { t.schemaVersion = SCHEMA_VERSION; changed = true; }
      const derivedStatus = isClosed(t) ? "closed" : "open";
      if (t.status !== derivedStatus) { t.status = derivedStatus; changed = true; }
    }
    if (changed) this.#save({ queue: false });
  }

  // ---------- CRUD ----------
  find(id) {
    return this.store.trades.find((t) => t.id === id) || null;
  }
  get(id) {
    const t = this.find(id);
    return t ? derive(t) : null;
  }
  list(filters = {}) {
    let rows = this.store.trades;
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

  create(input, actor) {
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
    this.store.trades.push(trade);
    this.#save();
    return { trade: derive(trade) };
  }

  update(id, input, actor) {
    const existing = this.find(id);
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
    this.#save();
    return { trade: derive(existing) };
  }

  remove(id) {
    const i = this.store.trades.findIndex((t) => t.id === id);
    if (i < 0) return { error: "not found", status: 404 };
    this.store.trades.splice(i, 1);
    this.#queueTradeDelete(id);
    this.#save();
    return { ok: true };
  }

  summary(filters = {}) {
    const rows = this.list(filters); // already derived + filtered
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

  // pure helpers exposed for callers/tests (no instance state)
  derive(t) {
    return derive(t);
  }
  validate(input) {
    return validate(input);
  }
}

// Shared singleton (drop-in for the old function-module API) + the class for tests/isolated instances.
const trades = new TradesRepo();
trades.TradesRepo = TradesRepo;
module.exports = trades;
