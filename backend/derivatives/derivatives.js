"use strict";

const { providerExpiry } = require("./nse-derivatives");

const SUPPORTED_SYMBOLS = new Set(["NIFTY", "NIFTYNXT50", "FINNIFTY", "BANKNIFTY", "MIDCPNIFTY", "NIFTYFPI"]);
const OPTION_KEY_PATTERN = /^index:(NIFTY|NIFTYNXT50|FINNIFTY|BANKNIFTY|MIDCPNIFTY|NIFTYFPI):(\d{4}-\d{2}-\d{2})$/;
const EQUITY_KEY_PATTERN = /^equity:([A-Z0-9][A-Z0-9&._-]{0,29}):(\d{4}-\d{2}-\d{2})$/;
const FUTURE_KEY_PATTERN = /^future:index:(NIFTY|NIFTYNXT50|FINNIFTY|BANKNIFTY|MIDCPNIFTY|NIFTYFPI)$/;
const STOCK_FUTURE_KEY_PATTERN = /^future:stock:([A-Z0-9][A-Z0-9&._-]{0,29})$/;
const COMMODITY_FUTURE_KEY_PATTERN = /^commodity:fut:([A-Z0-9]{1,20})$/;
const COMMODITY_OPTION_KEY_PATTERN = /^commodity:([A-Z0-9]{1,20}):(\d{4}-\d{2}-\d{2})$/;
const COMMODITY_SYMBOL_PATTERN = /^[A-Z0-9]{1,20}$/;
const EQUITY_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9&._-]{0,29}$/;

class DerivativesError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "DerivativesError";
    this.code = code;
    this.retryAfter = options.retryAfter == null ? null : options.retryAfter;
    this.retryAfterMs = options.retryAfterMs == null ? null : options.retryAfterMs;
    this.retryAt = options.retryAt == null ? null : options.retryAt;
    this.details = options.details == null ? null : options.details;
    this.cause = options.cause || null;
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function queryIdentity(query, requireExpiry) {
  if (!query || typeof query !== "object" || !["index", "equity", "commodity"].includes(query.market)) {
    throw new DerivativesError("INVALID_QUERY", "market must be index, equity, or commodity", { details: { field: "market" } });
  }
  const validSymbol = query.market === "index"
    ? typeof query.symbol === "string" && SUPPORTED_SYMBOLS.has(query.symbol)
    : query.market === "commodity"
      ? typeof query.symbol === "string" && COMMODITY_SYMBOL_PATTERN.test(query.symbol)
      : typeof query.symbol === "string" && EQUITY_SYMBOL_PATTERN.test(query.symbol);
  if (!validSymbol) {
    throw new DerivativesError("INVALID_QUERY", "symbol is not a supported derivative", { details: { field: "symbol" } });
  }
  if (requireExpiry && !validDate(query.expiry)) {
    throw new DerivativesError("INVALID_QUERY", "expiry must be an ISO calendar date", { details: { field: "expiry" } });
  }
  return { market: query.market, symbol: query.symbol, ...(requireExpiry ? { expiry: query.expiry } : {}) };
}

function keyIdentity(key) {
  if (typeof key !== "string") throw new DerivativesError("INVALID_KEY", "key must identify a supported derivative snapshot");
  const option = OPTION_KEY_PATTERN.exec(key);
  if (option && validDate(option[2])) return { key, kind: "option-chain", market: "index", symbol: option[1], expiry: option[2] };
  const equity = EQUITY_KEY_PATTERN.exec(key);
  if (equity && validDate(equity[2])) return { key, kind: "option-chain", market: "equity", symbol: equity[1], expiry: equity[2] };
  const future = FUTURE_KEY_PATTERN.exec(key);
  if (future) return { key, kind: "index-futures", market: "index", symbol: future[1] };
  const stockFuture = STOCK_FUTURE_KEY_PATTERN.exec(key);
  if (stockFuture) return { key, kind: "stock-futures", market: "stock", symbol: stockFuture[1] };
  const commodityFuture = COMMODITY_FUTURE_KEY_PATTERN.exec(key);
  if (commodityFuture) return { key, kind: "commodity-futures", market: "commodity", symbol: commodityFuture[1] };
  const commodityOption = COMMODITY_OPTION_KEY_PATTERN.exec(key);
  if (commodityOption && validDate(commodityOption[2])) return { key, kind: "option-chain", market: "commodity", symbol: commodityOption[1], expiry: commodityOption[2] };
  throw new DerivativesError("INVALID_KEY", "key must identify a supported derivative snapshot");
}

function retryAfterMs(value, now) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.ceil(Number(text) * 1000));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
}

function errorRetryAfterMs(error, now) {
  for (const current of causeChain(error)) {
    if (current.retryAfterMs != null && Number.isFinite(Number(current.retryAfterMs))) return Math.max(0, Number(current.retryAfterMs));
    const parsed = retryAfterMs(current.retryAfter == null ? current.retryAt : current.retryAfter, now);
    if (parsed != null) return parsed;
  }
  return null;
}

function sourceCode(error) {
  let fallback = "";
  for (const current of causeChain(error)) {
    if (typeof current.code !== "string") continue;
    const code = current.code.toUpperCase();
    if (!fallback) fallback = code;
    if (["SOURCE_BUSY", "SOURCE_BLOCKED", "UPSTREAM_BLOCK", "UPSTREAM_BLOCKED", "COORDINATOR_BLOCKED"].includes(code)) return code;
  }
  return fallback;
}

function causeChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current) && chain.length < 4) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function causeRetryAt(error) {
  for (const current of causeChain(error)) {
    if (typeof current.retryAt === "string" && current.retryAt.trim()) return current.retryAt;
  }
  return null;
}

function hasDerivativesScope(store) {
  return Boolean(store && store.derivatives && typeof store.derivatives.ingestSnapshot === "function" && typeof store.derivatives.getSnapshot === "function" && typeof store.derivatives.setStatus === "function");
}

function nonNegativeNumber(value) {
  if (value == null || (typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteNumber(value) {
  if (value == null || (typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function highestAtStrike(entries) {
  if (!entries.length) return null;
  return entries.reduce((best, entry) => !best || entry.value > best.value || (entry.value === best.value && entry.strike < best.strike) ? entry : best, null);
}

/**
 * Read-only facts derived from a normalized option-chain snapshot. It deliberately
 * has no provider, demand, or timer dependency: an analysis request cannot refresh
 * or otherwise change the market-data lifecycle.
 */
class DerivativesAnalysis {
  constructor(options = {}) {
    if (!options.scope || typeof options.scope.getSnapshot !== "function") {
      throw new DerivativesError("CONFIG_ERROR", "derivatives snapshot scope is required");
    }
    this.scope = options.scope;
  }

  getAnalysis(query) {
    const identity = queryIdentity(query, true);
    const key = `${identity.market}:${identity.symbol}:${identity.expiry}`;
    const snapshot = this.scope.getSnapshot(key);
    if (!snapshot || !snapshot.data || !Array.isArray(snapshot.data.rows) || !snapshot.data.rows.length) {
      throw new DerivativesError("SNAPSHOT_UNAVAILABLE", "option chain snapshot unavailable", { details: { key } });
    }

    const base = {
      kind: "derivatives-analysis",
      ...identity,
      key,
      sequence: Number.isFinite(snapshot.sequence) ? snapshot.sequence : null,
      state: typeof snapshot.state === "string" ? snapshot.state : null,
      sourceTimestamp: typeof snapshot.sourceTimestamp === "string" ? snapshot.sourceTimestamp : null,
      receivedAt: typeof snapshot.receivedAt === "string" ? snapshot.receivedAt : null,
      disclaimer: "Facts derived from the stored option-chain snapshot only; not trading advice.",
    };
    const prepared = this.#prepare(snapshot.data.rows);
    const diagnostics = this.#diagnostics(snapshot, prepared);
    if (!prepared.rows.length) {
      return { ...base, facts: null, diagnostics };
    }
    return { ...base, facts: this.#facts(prepared.underlying, prepared), diagnostics };
  }

  #prepare(rows) {
    const prepared = [];
    let invalidStrikes = 0;
    let missingCalls = 0;
    let missingPuts = 0;
    let invalidOi = 0;
    let invalidVolume = 0;
    for (const row of rows) {
      const strike = nonNegativeNumber(row && row.strike);
      if (strike == null) { invalidStrikes += 1; continue; }
      const call = row && row.call && typeof row.call === "object" ? row.call : null;
      const put = row && row.put && typeof row.put === "object" ? row.put : null;
      if (!call) missingCalls += 1;
      if (!put) missingPuts += 1;
      const normalizeLeg = (leg) => {
        if (!leg) return null;
        const oi = nonNegativeNumber(leg.openInterest);
        const volume = nonNegativeNumber(leg.volume);
        if (leg.openInterest != null && oi == null) invalidOi += 1;
        if (leg.volume != null && volume == null) invalidVolume += 1;
        return { oi, volume, changeOi: finiteNumber(leg.changeInOpenInterest), iv: nonNegativeNumber(leg.impliedVolatility) };
      };
      prepared.push({ strike, call: normalizeLeg(call), put: normalizeLeg(put) });
    }
    prepared.sort((a, b) => a.strike - b.strike);
    return { rows: prepared, underlying: null, invalidStrikes, missingCalls, missingPuts, invalidOi, invalidVolume };
  }

  #diagnostics(snapshot, prepared) {
    const underlying = nonNegativeNumber(snapshot.data && snapshot.data.underlyingValue);
    prepared.underlying = underlying;
    const legs = prepared.rows.flatMap((row) => [row.call, row.put]).filter(Boolean);
    return {
      missingLegs: { calls: prepared.missingCalls, puts: prepared.missingPuts },
      strikes: { total: Array.isArray(snapshot.data.rows) ? snapshot.data.rows.length : 0, valid: prepared.rows.length, invalid: prepared.invalidStrikes },
      liquidity: {
        callLegs: prepared.rows.filter((row) => row.call).length,
        putLegs: prepared.rows.filter((row) => row.put).length,
        oiAvailableLegs: legs.filter((leg) => leg.oi != null).length,
        volumeAvailableLegs: legs.filter((leg) => leg.volume != null).length,
        invalidOi: prepared.invalidOi,
        invalidVolume: prepared.invalidVolume,
      },
      underlyingAvailable: underlying != null,
    };
  }

  #facts(underlying, prepared) {
    const atm = underlying == null ? null : prepared.rows.reduce((best, row) => !best || Math.abs(row.strike - underlying) < Math.abs(best - underlying) || (Math.abs(row.strike - underlying) === Math.abs(best - underlying) && row.strike < best) ? row.strike : best, null);
    const totals = (field) => {
      let callTotal = 0; let putTotal = 0; let calls = 0; let puts = 0;
      for (const row of prepared.rows) {
        if (row.call && row.call[field] != null) { callTotal += row.call[field]; calls += 1; }
        if (row.put && row.put[field] != null) { putTotal += row.put[field]; puts += 1; }
      }
      return { value: calls && puts && callTotal > 0 ? putTotal / callTotal : null, callTotal: calls ? callTotal : null, putTotal: puts ? putTotal : null };
    };
    const highest = (side, field) => highestAtStrike(prepared.rows.flatMap((row) => row[side] && row[side][field] != null ? [{ strike: row.strike, value: row[side][field] }] : []));
    const atmRow = atm == null ? null : prepared.rows.find((row) => row.strike === atm);
    const callIv = atmRow && atmRow.call ? atmRow.call.iv : null;
    const putIv = atmRow && atmRow.put ? atmRow.put.iv : null;
    const painInputs = prepared.rows.filter((row) => (row.call && row.call.oi != null) || (row.put && row.put.oi != null));
    const payouts = prepared.rows.map((candidate) => ({
      strike: candidate.strike,
      value: painInputs.reduce((sum, row) => sum + (row.call && row.call.oi != null ? Math.max(0, candidate.strike - row.strike) * row.call.oi : 0) + (row.put && row.put.oi != null ? Math.max(0, row.strike - candidate.strike) * row.put.oi : 0), 0),
    }));
    const maxPain = payouts.length && painInputs.length ? payouts.reduce((best, entry) => !best || entry.value < best.value || (entry.value === best.value && entry.strike < best.strike) ? entry : best, null) : null;
    return {
      underlying,
      atm: atm == null ? null : { strike: atm },
      pcr: { openInterest: totals("oi"), volume: totals("volume") },
      highestOpenInterest: { call: highest("call", "oi"), put: highest("put", "oi") },
      highestChangeInOpenInterest: { call: highest("call", "changeOi"), put: highest("put", "changeOi") },
      maxPain: maxPain && { strike: maxPain.strike, totalPayout: maxPain.value, inputCoverage: { candidateStrikes: payouts.length, inputStrikes: painInputs.length, callInputs: painInputs.filter((row) => row.call && row.call.oi != null).length, putInputs: painInputs.filter((row) => row.put && row.put.oi != null).length } },
      atmImpliedVolatility: atm == null ? null : { call: callIv, put: putIv, putMinusCall: callIv != null && putIv != null ? putIv - callIv : null },
    };
  }
}

class DerivativesService {
  constructor(options = {}) {
    if (!options.provider || typeof options.provider.getContracts !== "function" || typeof options.provider.getOptionChain !== "function") {
      throw new DerivativesError("CONFIG_ERROR", "provider must implement getContracts and getOptionChain");
    }
    if (!hasDerivativesScope(options.store)) throw new DerivativesError("CONFIG_ERROR", "store.derivatives scope is required");
    if (typeof options.isMarketOpen !== "function" || typeof options.nextOpenDelayMs !== "function") {
      throw new DerivativesError("CONFIG_ERROR", "isMarketOpen and nextOpenDelayMs functions are required");
    }

    const config = options.config || {};
    this.provider = options.provider;
    this.scope = options.store.derivatives;
    this.analysis = options.analysis || new DerivativesAnalysis({ scope: this.scope });
    if (!this.analysis || typeof this.analysis.getAnalysis !== "function") throw new DerivativesError("CONFIG_ERROR", "analysis must implement getAnalysis");
    this.isMarketOpen = options.isMarketOpen;
    this.nextOpenDelayMs = options.nextOpenDelayMs;
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.tradingDate = options.tradingDate || (() => new Date(this.now()).toISOString().slice(0, 10));
    this.sourceStatus = typeof options.sourceStatus === "function" ? options.sourceStatus : null;
    this.onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;
    this.timers = options.timers || { setTimeout, clearTimeout };
    if (typeof this.timers.setTimeout !== "function" || typeof this.timers.clearTimeout !== "function") {
      throw new DerivativesError("CONFIG_ERROR", "timers must implement setTimeout and clearTimeout");
    }

    this.refreshMs = Math.max(3_000, Number(config.refreshMs == null ? 5_000 : config.refreshMs) || 5_000);
    this.initialJitterMs = Math.max(0, Number(config.initialJitterMs == null ? Math.min(1_000, this.refreshMs / 4) : config.initialJitterMs) || 0);
    this.laterJitterMs = Math.max(0, Number(config.laterJitterMs == null ? this.refreshMs * 0.1 : config.laterJitterMs) || 0);
    this.graceMs = Math.max(0, Number(config.graceMs == null ? 60_000 : config.graceMs) || 60_000);
    this.maxActiveKeys = Math.max(1, Number(config.maxActiveKeys == null ? 2 : config.maxActiveKeys) || 2);
    this.maxCalls = Math.max(1, Number(config.maxCalls == null ? 2 : config.maxCalls) || 2);
    this.chainBudget = Math.max(1, Number(config.chainBudget == null ? 24 : config.chainBudget) || 24);
    this.metadataBudget = Math.max(1, Number(config.metadataBudget == null ? 4 : config.metadataBudget) || 4);
    this.allowClosedReview = Boolean(config.allowClosedReview);
    this.futuresEnabled = Boolean(config.futuresEnabled);
    this.stockOptionsEnabled = Boolean(config.stockOptionsEnabled);
    this.commodityEnabled = Boolean(config.commodityEnabled);
    if (this.commodityEnabled && ["getCommoditySymbols", "getCommodityFutures", "getCommodityContracts", "getCommodityOptionChain"].some((name) => typeof this.provider[name] !== "function")) {
      throw new DerivativesError("CONFIG_ERROR", "provider must implement getCommoditySymbols, getCommodityFutures, getCommodityContracts and getCommodityOptionChain when commodities are enabled");
    }
    if (this.futuresEnabled && (typeof this.provider.getIndexFutures !== "function" || typeof this.provider.getStockFutures !== "function")) {
      throw new DerivativesError("CONFIG_ERROR", "provider must implement getIndexFutures and getStockFutures when futures are enabled");
    }
    if (this.stockOptionsEnabled && typeof this.provider.getEquitySymbols !== "function") {
      throw new DerivativesError("CONFIG_ERROR", "provider must implement getEquitySymbols when stock options are enabled");
    }

    // Live option-chain WSS (opt-in). Layers price/bid/ask/ltp deltas onto the REST-seeded
    // chain; REST stays the seed + periodic reconcile. Disabled unless a stream client is
    // injected, configured, and the provider can normalize frames.
    this.optionStream = options.optionStream || null;
    this.streamEnabled = Boolean(options.streamEnabled)
      && !!this.optionStream
      && typeof this.optionStream.open === "function"
      && typeof this.optionStream.configured === "function"
      && this.optionStream.configured()
      && typeof this.provider.normalizeStreamFrame === "function";
    this.streamEmitMs = Math.max(50, Number(options.streamEmitMs == null ? 250 : options.streamEmitMs) || 250);
    this.streamEmitTimers = new Map();

    this.demands = new Map();
    this.contractCache = new Map();
    this.contractInflight = new Map();
    this.equitySymbolsCache = null;
    this.equitySymbolsInflight = null;
    this.metadataDate = null;
    this.budgets = { chain: { window: null, count: 0 }, metadata: { window: null, count: 0 } };
    this.activeCalls = 0;
    this.blockedUntil = 0;
    this.blockFailures = 0;
    this.closed = false;
    this.sourceCounters = { chainCalls: 0, metadataCalls: 0, failures: 0 };
  }

  getContracts(query) {
    const identity = queryIdentity(query, false);
    if (identity.market === "equity") {
      if (!this.stockOptionsEnabled) return Promise.reject(new DerivativesError("NOT_FOUND", "stock options are disabled"));
      return this.getEquitySymbols().then((result) => {
        if (!result.symbols.includes(identity.symbol)) throw new DerivativesError("INVALID_QUERY", "symbol is not available in NSE master quote");
        return this.#getContracts(identity);
      });
    }
    if (identity.market === "commodity" && !this.commodityEnabled) {
      return Promise.reject(new DerivativesError("NOT_FOUND", "commodities are disabled"));
    }
    return this.#getContracts(identity);
  }

  #getContracts(identity) {
    if (this.closed) return Promise.reject(new DerivativesError("CLOSED", "derivatives service is closed"));
    const date = String(this.tradingDate());
    this.#rollMetadataDate(date);
    const cacheKey = `${date}:${identity.market}:${identity.symbol}`;
    const cached = this.contractCache.get(cacheKey);
    if (cached) return Promise.resolve(clone(cached));
    const inFlight = this.contractInflight.get(cacheKey);
    if (inFlight) return inFlight.then(clone);
    if (this.now() < this.blockedUntil) {
      return Promise.reject(new DerivativesError("UPSTREAM_BLOCK", "derivatives source is temporarily blocked", { retryAfterMs: this.blockedUntil - this.now() }));
    }
    if (this.activeCalls >= this.maxCalls || !this.#takeBudget("metadata")) {
      return Promise.reject(new DerivativesError("REQUEST_BUDGET", "contract metadata request budget is exhausted", { retryAfterMs: this.#nextWindowDelay() }));
    }

    this.activeCalls += 1;
    this.sourceCounters.metadataCalls += 1;
    const request = Promise.resolve()
      .then(() => identity.market === "commodity"
        ? this.provider.getCommodityContracts(identity)
        : this.provider.getContracts(identity))
      .then((result) => {
        const saved = clone(result);
        if (!this.closed && this.metadataDate === date) {
          this.contractCache.set(cacheKey, saved);
          this.blockFailures = 0;
          this.blockedUntil = 0;
        }
        return saved;
      })
      .catch((error) => {
        if (!this.closed) {
          this.sourceCounters.failures += 1;
          if (this.#isBlocked(sourceCode(error))) {
            const now = this.now();
            const localBackoff = this.#registerBlock(now);
            const coordinatorRetry = errorRetryAfterMs(error, now);
            const delay = Math.min(300_000, Math.max(localBackoff, coordinatorRetry == null ? 0 : coordinatorRetry));
            this.blockedUntil = Math.max(this.blockedUntil, now + delay);
          }
        }
        throw this.#asPublicError(error);
      })
      .finally(() => {
        this.activeCalls -= 1;
        this.contractInflight.delete(cacheKey);
      });
    this.contractInflight.set(cacheKey, request);
    return request.then(clone);
  }

  getEquitySymbols() {
    if (this.closed) return Promise.reject(new DerivativesError("CLOSED", "derivatives service is closed"));
    if (!this.stockOptionsEnabled) return Promise.reject(new DerivativesError("NOT_FOUND", "stock options are disabled"));
    const date = String(this.tradingDate());
    this.#rollMetadataDate(date);
    if (this.equitySymbolsCache) return Promise.resolve(clone(this.equitySymbolsCache));
    if (this.equitySymbolsInflight) return this.equitySymbolsInflight.then(clone);
    if (this.now() < this.blockedUntil) {
      return Promise.reject(new DerivativesError("UPSTREAM_BLOCK", "derivatives source is temporarily blocked", { retryAfterMs: this.blockedUntil - this.now() }));
    }
    if (this.activeCalls >= this.maxCalls || !this.#takeBudget("metadata")) {
      return Promise.reject(new DerivativesError("REQUEST_BUDGET", "stock symbol request budget is exhausted", { retryAfterMs: this.#nextWindowDelay() }));
    }
    this.activeCalls += 1;
    this.sourceCounters.metadataCalls += 1;
    const request = Promise.resolve()
      .then(() => this.provider.getEquitySymbols())
      .then((result) => {
        const saved = clone(result);
        if (!this.closed && this.metadataDate === date) {
          this.equitySymbolsCache = saved;
          this.blockFailures = 0;
          this.blockedUntil = 0;
        }
        return saved;
      })
      .catch((error) => {
        if (!this.closed) {
          this.sourceCounters.failures += 1;
          if (this.#isBlocked(sourceCode(error))) {
            const now = this.now();
            const localBackoff = this.#registerBlock(now);
            const coordinatorRetry = errorRetryAfterMs(error, now);
            const delay = Math.min(300_000, Math.max(localBackoff, coordinatorRetry == null ? 0 : coordinatorRetry));
            this.blockedUntil = Math.max(this.blockedUntil, now + delay);
          }
        }
        throw this.#asPublicError(error);
      })
      .finally(() => {
        this.activeCalls -= 1;
        this.equitySymbolsInflight = null;
      });
    this.equitySymbolsInflight = request;
    return request.then(clone);
  }

  getAnalysis(query) {
    return clone(this.analysis.getAnalysis(query));
  }

  addDemand(query) {
    return this.#addDemand(queryIdentity(query, true), "option-chain");
  }

  addFuturesDemand(query) {
    if (!this.futuresEnabled) throw new DerivativesError("NOT_FOUND", "index futures are disabled");
    return this.#addDemand(queryIdentity(query, false), "index-futures");
  }

  addStockFuturesDemand(query) {
    if (!this.futuresEnabled) throw new DerivativesError("NOT_FOUND", "stock futures are disabled");
    const symbol = query && typeof query.symbol === "string" ? query.symbol.trim().toUpperCase() : "";
    if (!EQUITY_SYMBOL_PATTERN.test(symbol)) throw new DerivativesError("INVALID_QUERY", "invalid stock symbol", { details: { field: "symbol" } });
    return this.#addDemand({ market: "stock", symbol }, "stock-futures");
  }

  addCommodityFuturesDemand(query) {
    if (!this.commodityEnabled) throw new DerivativesError("NOT_FOUND", "commodities are disabled");
    const symbol = query && typeof query.symbol === "string" ? query.symbol.trim().toUpperCase() : "";
    if (!COMMODITY_SYMBOL_PATTERN.test(symbol)) throw new DerivativesError("INVALID_QUERY", "invalid commodity symbol", { details: { field: "symbol" } });
    return this.#addDemand({ market: "commodity", symbol }, "commodity-futures");
  }

  getCommoditySymbols() {
    if (this.closed) return Promise.reject(new DerivativesError("CLOSED", "derivatives service is closed"));
    if (!this.commodityEnabled) return Promise.reject(new DerivativesError("NOT_FOUND", "commodities are disabled"));
    return Promise.resolve()
      .then(() => this.provider.getCommoditySymbols())
      .then(clone)
      .catch((error) => { throw this.#asPublicError(error); });
  }

  #addDemand(identity, kind) {
    if (this.closed) throw new DerivativesError("CLOSED", "derivatives service is closed");
    const key = kind === "index-futures"
      ? `future:index:${identity.symbol}`
      : kind === "stock-futures"
        ? `future:stock:${identity.symbol}`
        : kind === "commodity-futures"
          ? `commodity:fut:${identity.symbol}`
          : `${identity.market}:${identity.symbol}:${identity.expiry}`;
    let demand = this.demands.get(key);
    if (!demand) {
      if (this.demands.size >= this.maxActiveKeys) throw new DerivativesError("CAPACITY", "derivative demand capacity reached");
      demand = { ...identity, kind, key, count: 0, timer: null, graceTimer: null, graceExpired: false, inFlight: null, nextAttemptAt: 0, closedReviewUsed: false };
      this.demands.set(key, demand);
    }
    demand.count += 1;
    if (demand.graceTimer) {
      this.timers.clearTimeout(demand.graceTimer);
      demand.graceTimer = null;
    }
    demand.graceExpired = false;
    demand.graceExpiresAt = null;
    // Give a newly subscribed stream a complete, normalized envelope immediately;
    // fetching remains timer-driven and only starts after demand is registered.
    if (!this.scope.getSnapshot(key)) this.#setStatus(key, { state: "loading", reason: "awaiting-refresh" });
    if (!demand.timer && !demand.inFlight) this.#schedule(key, this.#initialDelay());

    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        this.#release(key);
      },
    };
  }

  refresh(key) {
    const identity = keyIdentity(key);
    const demand = this.demands.get(identity.key);
    if (this.closed || !demand || demand.count < 1) return Promise.resolve(this.scope.getSnapshot(identity.key));
    if (demand.inFlight) return demand.inFlight.then(clone);

    const now = this.now();
    const marketOpen = this.isMarketOpen();
    const closedReviewEligible = this.allowClosedReview && !marketOpen;
    if (!marketOpen) {
      this.#closeStream(identity.key); // no live WSS outside the continuous session
      if (!this.allowClosedReview) {
        this.#setStatus(identity.key, { state: "closed", reason: "market-closed" });
        this.#scheduleNextOpen(identity.key);
        return Promise.resolve(this.scope.getSnapshot(identity.key));
      }
      if (demand.closedReviewUsed) {
        this.#scheduleNextOpen(identity.key);
        return Promise.resolve(this.scope.getSnapshot(identity.key));
      }
    } else {
      demand.closedReviewUsed = false;
    }
    if (now < demand.nextAttemptAt || now < this.blockedUntil) {
      this.#schedule(identity.key, Math.max(demand.nextAttemptAt, this.blockedUntil) - now);
      return Promise.resolve(this.scope.getSnapshot(identity.key));
    }
    if (this.activeCalls >= this.maxCalls) {
      this.#schedule(identity.key, this.refreshMs);
      return Promise.resolve(this.scope.getSnapshot(identity.key));
    }
    if (!this.#takeBudget("chain")) {
      const delay = this.#nextWindowDelay();
      demand.nextAttemptAt = now + delay;
      this.#setStatus(identity.key, {
        state: "rate-limited",
        reason: "request-budget",
        retryAfterMs: delay,
        retryAt: new Date(now + delay).toISOString(),
      });
      this.#schedule(identity.key, delay);
      return Promise.resolve(this.scope.getSnapshot(identity.key));
    }

    this.#setStatus(identity.key, { state: "loading", reason: "refreshing" });
    if (closedReviewEligible) demand.closedReviewUsed = true;
    this.activeCalls += 1;
    this.sourceCounters.chainCalls += 1;
    const operation = Promise.resolve()
      .then(() => identity.kind === "index-futures"
        ? this.provider.getIndexFutures(identity)
        : identity.kind === "stock-futures"
          ? this.provider.getStockFutures(identity)
          : identity.kind === "commodity-futures"
            ? this.provider.getCommodityFutures(identity)
            : identity.market === "commodity"
              ? this.provider.getCommodityOptionChain(identity)
              : this.provider.getOptionChain(identity))
      .then((snapshot) => this.#handleSuccess(identity.key, snapshot))
      .catch((error) => this.#handleFailure(identity.key, error))
      .finally(() => {
        this.activeCalls -= 1;
        const current = this.demands.get(identity.key);
        if (current === demand) {
          current.inFlight = null;
          if (current.count === 0 && current.graceExpired) this.demands.delete(identity.key);
        }
      });
    demand.inFlight = operation;
    return operation.then(clone);
  }

  getStatus() {
    let sourceStatus = null;
    if (this.sourceStatus) {
      try { sourceStatus = clone(this.sourceStatus()); } catch { sourceStatus = null; }
    }
    return clone({
      closed: this.closed,
      activeCalls: this.activeCalls,
      blockedUntil: this.blockedUntil || null,
      config: {
        pollMs: this.refreshMs,
        graceMs: this.graceMs,
        maxActiveKeys: this.maxActiveKeys,
        maxCalls: this.maxCalls,
        chainBudget: this.chainBudget,
        metadataBudget: this.metadataBudget,
        allowClosedReview: this.allowClosedReview,
        futuresEnabled: this.futuresEnabled,
        stockOptionsEnabled: this.stockOptionsEnabled,
        commodityEnabled: this.commodityEnabled,
      },
      activeKeys: [...this.demands.values()].map((entry) => ({
        key: entry.key,
        subscribers: entry.count,
        inFlight: Boolean(entry.inFlight),
        nextAttemptAt: entry.nextAttemptAt || null,
        graceExpiresAt: entry.graceExpiresAt || null,
      })),
      budgets: { chain: this.#budgetStatus("chain"), metadata: this.#budgetStatus("metadata") },
      source: { counters: { ...this.sourceCounters }, status: sourceStatus },
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const demand of this.demands.values()) {
      if (demand.timer) this.timers.clearTimeout(demand.timer);
      if (demand.graceTimer) this.timers.clearTimeout(demand.graceTimer);
      demand.timer = null;
      demand.graceTimer = null;
      demand.count = 0;
    }
    this.demands.clear();
    this.contractInflight.clear();
    this.equitySymbolsInflight = null;
    if (this.optionStream) this.optionStream.stop();
    for (const timer of this.streamEmitTimers.values()) this.timers.clearTimeout(timer);
    this.streamEmitTimers.clear();
  }

  #release(key) {
    const demand = this.demands.get(key);
    if (!demand || demand.count < 1) return;
    demand.count -= 1;
    if (demand.count > 0) return;
    this.#closeStream(key); // no subscribers left -> drop the live socket immediately
    if (demand.timer) {
      this.timers.clearTimeout(demand.timer);
      demand.timer = null;
    }
    demand.graceTimer = this.timers.setTimeout(() => {
      const current = this.demands.get(key);
      if (current !== demand || current.count !== 0) return;
      current.graceTimer = null;
      current.graceExpiresAt = null;
      if (current.inFlight) current.graceExpired = true;
      else this.demands.delete(key);
    }, this.graceMs);
    demand.graceExpiresAt = this.now() + this.graceMs;
    demand.graceTimer.unref?.();
  }

  #schedule(key, delay) {
    const demand = this.demands.get(key);
    if (this.closed || !demand || demand.count < 1) return;
    if (demand.timer) this.timers.clearTimeout(demand.timer);
    const safeDelay = Math.max(0, Number(delay) || 0);
    demand.timer = this.timers.setTimeout(() => {
      const current = this.demands.get(key);
      if (current === demand) current.timer = null;
      void this.refresh(key);
    }, safeDelay);
    demand.timer.unref?.();
  }

  #scheduleNextOpen(key) {
    let delay;
    try { delay = Number(this.nextOpenDelayMs()); } catch { delay = NaN; }
    // A closed calendar must never create a tight non-network timer loop.
    this.#schedule(key, Number.isFinite(delay) && delay > 0 ? delay : this.refreshMs);
  }

  #initialDelay() {
    return this.initialJitterMs === 0 ? 0 : Math.floor(this.random() * (this.initialJitterMs + 1));
  }

  #laterDelay() {
    const jitter = this.laterJitterMs === 0 ? 0 : Math.round((this.random() * 2 - 1) * this.laterJitterMs);
    return Math.max(3_000, this.refreshMs + jitter);
  }

  #takeBudget(name) {
    const budget = this.budgets[name];
    const window = Math.floor(this.now() / 60_000);
    if (budget.window !== window) {
      budget.window = window;
      budget.count = 0;
    }
    if (budget.count >= (name === "chain" ? this.chainBudget : this.metadataBudget)) return false;
    budget.count += 1;
    return true;
  }

  #nextWindowDelay() {
    return Math.max(1, 60_000 - (this.now() % 60_000));
  }

  #handleSuccess(key, snapshot) {
    const demand = this.demands.get(key);
    // A completed request is not allowed to resurrect a released chain.
    if (this.closed || !demand || demand.count < 1) return this.scope.getSnapshot(key);
    const completedWhileClosed = !this.isMarketOpen();
    const normalizedSnapshot = completedWhileClosed && snapshot && typeof snapshot === "object"
      ? { ...snapshot, state: "closed", reason: "market-closed", stale: true, upstreamState: snapshot.state }
      : snapshot;
    const stored = this.scope.ingestSnapshot(normalizedSnapshot);
    if (!stored) return this.#handleFailure(key, new DerivativesError("SCHEMA_ERROR", "provider returned an invalid derivative snapshot"));
    this.#emitUpdate(stored, "snapshot");
    this.blockFailures = 0;
    this.blockedUntil = 0;
    // The chain is now REST-seeded — safe to open the live WSS delta layer on top of it.
    if (this.streamEnabled && this.isMarketOpen() && demand.kind === "option-chain" && demand.market !== "commodity" && !this.optionStream.has(key)) this.#openStream(demand); // commodity options have no WSS
    if (completedWhileClosed || stored.state === "closed") this.#scheduleNextOpen(key);
    else this.#schedule(key, this.#laterDelay());
    return stored;
  }

  #handleFailure(key, error) {
    const demand = this.demands.get(key);
    if (this.closed || !demand || demand.count < 1) return this.scope.getSnapshot(key);
    const now = this.now();
    const code = sourceCode(error);
    this.sourceCounters.failures += 1;
    const retryMs = errorRetryAfterMs(error, now);
    let state = "error";
    let reason = "source-error";
    let delay = this.#laterDelay();

    if (this.#isBlocked(code)) {
      const localBackoff = this.#registerBlock(now);
      delay = Math.min(300_000, Math.max(localBackoff, retryMs == null ? 0 : retryMs));
      this.blockedUntil = Math.max(this.blockedUntil, now + delay);
      state = "blocked";
      reason = "upstream-block";
    } else if (["RATE_LIMITED", "REQUEST_BUDGET"].includes(code)) {
      state = "rate-limited";
      reason = "request-budget";
      delay = Math.max(3_000, retryMs == null ? this.#laterDelay() : retryMs);
    } else if (["SCHEMA_ERROR", "MALFORMED_JSON", "NON_JSON_RESPONSE", "IDENTITY_MISMATCH"].includes(code)) {
      state = "error";
      reason = "schema-error";
    } else if (code === "CONFIG_ERROR") {
      // Unconfigured endpoint: back off hard (5 min) so a config gap can't retry-spam upstream.
      state = "error";
      reason = "not-configured";
      delay = 300_000;
    } else if (code === "NOT_FOUND") {
      state = "error";
      reason = "source-lag";
      delay = Math.max(60_000, retryMs == null ? 0 : retryMs);
    } else if (code === "SOURCE_BUSY") {
      reason = "source-lag";
      state = this.scope.hasData(key) ? "stale" : "error";
      delay = Math.max(1_000, retryMs == null ? 1_000 : retryMs);
    } else if (["TRANSPORT_ERROR", "UPSTREAM_HTTP"].includes(code)) {
      reason = "source-lag";
      state = this.scope.hasData(key) ? "stale" : "error";
    }

    demand.nextAttemptAt = now + Math.max(1, delay);
    const normalizedDelay = Math.max(1, delay);
    this.#setStatus(key, {
      state,
      reason,
      retryAfterMs: normalizedDelay,
      retryAt: new Date(now + normalizedDelay).toISOString(),
      lastErrorCode: code || "UNKNOWN",
    });
    const closedReview = this.allowClosedReview && !this.isMarketOpen() && demand.closedReviewUsed;
    if (closedReview) this.#scheduleNextOpen(key);
    else this.#schedule(key, normalizedDelay);
    return this.scope.getSnapshot(key);
  }

  #asPublicError(error) {
    const code = sourceCode(error);
    if (this.#isBlocked(code)) {
      return new DerivativesError("UPSTREAM_BLOCK", "derivatives source is temporarily blocked", { cause: error, retryAfterMs: errorRetryAfterMs(error, this.now()), retryAt: causeRetryAt(error) });
    }
    if (["RATE_LIMITED", "REQUEST_BUDGET"].includes(code)) {
      return new DerivativesError("REQUEST_BUDGET", "derivatives request budget is exhausted", { cause: error, retryAfter: error && error.retryAfter, retryAfterMs: errorRetryAfterMs(error, this.now()), retryAt: causeRetryAt(error) });
    }
    if (["SCHEMA_ERROR", "MALFORMED_JSON", "NON_JSON_RESPONSE", "IDENTITY_MISMATCH"].includes(code)) {
      return new DerivativesError("SCHEMA_ERROR", "derivatives source returned invalid data", { cause: error });
    }
    if (code === "SOURCE_BUSY") return new DerivativesError("SOURCE_BUSY", "derivatives source is busy", { cause: error, retryAfterMs: errorRetryAfterMs(error, this.now()), retryAt: causeRetryAt(error) });
    // A missing/misconfigured upstream endpoint (e.g. derivatives.masterQuoteEndpoint
    // or .futuresEndpoint) never fixes itself — surface it verbatim instead of masking it as a
    // generic, retryable "source request failed".
    if (code === "CONFIG_ERROR") return new DerivativesError("CONFIG_ERROR", (error && error.message) || "derivatives endpoint is not configured", { cause: error });
    if (error instanceof DerivativesError) return error;
    return new DerivativesError("SOURCE_ERROR", "derivatives source request failed", { cause: error });
  }

  #isBlocked(code) {
    return ["UPSTREAM_BLOCKED", "UPSTREAM_BLOCK", "SOURCE_BLOCKED", "BLOCKED", "COORDINATOR_BLOCKED"].includes(code);
  }

  #registerBlock(now) {
    this.blockFailures += 1;
    const delay = Math.min(300_000, 5_000 * (2 ** (this.blockFailures - 1)));
    this.blockedUntil = Math.max(this.blockedUntil, now + delay);
    return delay;
  }

  #setStatus(key, status) {
    const stored = this.scope.setStatus(key, status);
    if (stored) this.#emitUpdate(stored, "status");
    return stored;
  }

  #emitUpdate(snapshot, type) {
    if (!this.onUpdate) return;
    try { this.onUpdate(clone(snapshot), type); } catch (_) {}
  }

  // ---- live option-chain WSS (delta layer over the REST-seeded chain) ----
  #openStream(demand) {
    if (!this.streamEnabled || !demand || demand.kind !== "option-chain") return;
    let expiryParam;
    try { expiryParam = providerExpiry(demand.expiry); } catch (_) { return; }
    this.optionStream.open(demand.key, { symbol: demand.symbol, providerExpiry: expiryParam }, (raw) => this.#onStreamFrame(demand, raw));
  }

  #onStreamFrame(demand, raw) {
    const current = this.demands.get(demand.key);
    if (this.closed || !current || current.count < 1) return; // don't feed a released chain
    let delta;
    try { delta = this.provider.normalizeStreamFrame(raw, { market: demand.market, symbol: demand.symbol, expiry: demand.expiry }); } catch (_) { return; }
    if (!delta) return;
    const updated = this.scope.applyTick(delta);
    if (updated) this.#scheduleStreamEmit(demand.key); // coalesce -> one full-snapshot SSE per window
  }

  #scheduleStreamEmit(key) {
    if (this.streamEmitTimers.has(key)) return;
    const timer = this.timers.setTimeout(() => {
      this.streamEmitTimers.delete(key);
      const snapshot = this.scope.getSnapshot(key);
      if (snapshot) this.#emitUpdate(snapshot, "snapshot");
    }, this.streamEmitMs);
    timer.unref?.();
    this.streamEmitTimers.set(key, timer);
  }

  #closeStream(key) {
    if (this.optionStream) this.optionStream.close(key);
    const timer = this.streamEmitTimers.get(key);
    if (timer) {
      this.timers.clearTimeout(timer);
      this.streamEmitTimers.delete(key);
    }
  }

  #budgetStatus(name) {
    const budget = this.budgets[name];
    const limit = name === "chain" ? this.chainBudget : this.metadataBudget;
    const window = Math.floor(this.now() / 60_000);
    const used = budget.window === window ? budget.count : 0;
    const resetMs = (window + 1) * 60_000;
    return { used, remaining: Math.max(0, limit - used), limit, resetAt: new Date(resetMs).toISOString() };
  }

  #rollMetadataDate(date) {
    if (this.metadataDate === date) return;
    this.metadataDate = date;
    this.contractCache.clear();
    this.equitySymbolsCache = null;
  }
}

module.exports = { DerivativesAnalysis, DerivativesError, DerivativesService };
