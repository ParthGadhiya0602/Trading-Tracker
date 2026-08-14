"use strict";

const SUPPORTED_SYMBOLS = new Set(["NIFTY", "BANKNIFTY"]);
const KEY_PATTERN = /^index:(NIFTY|BANKNIFTY):(\d{4}-\d{2}-\d{2})$/;

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
  if (!query || typeof query !== "object" || query.market !== "index") {
    throw new DerivativesError("INVALID_QUERY", "market must be index", { details: { field: "market" } });
  }
  if (typeof query.symbol !== "string" || !SUPPORTED_SYMBOLS.has(query.symbol)) {
    throw new DerivativesError("INVALID_QUERY", "symbol must be NIFTY or BANKNIFTY", { details: { field: "symbol" } });
  }
  if (requireExpiry && !validDate(query.expiry)) {
    throw new DerivativesError("INVALID_QUERY", "expiry must be an ISO calendar date", { details: { field: "expiry" } });
  }
  return { market: "index", symbol: query.symbol, ...(requireExpiry ? { expiry: query.expiry } : {}) };
}

function keyIdentity(key) {
  const match = typeof key === "string" ? KEY_PATTERN.exec(key) : null;
  if (!match || !validDate(match[2])) throw new DerivativesError("INVALID_KEY", "key must identify a supported index option chain");
  return { key, market: "index", symbol: match[1], expiry: match[2] };
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

    this.demands = new Map();
    this.contractCache = new Map();
    this.contractInflight = new Map();
    this.metadataDate = null;
    this.budgets = { chain: { window: null, count: 0 }, metadata: { window: null, count: 0 } };
    this.activeCalls = 0;
    this.blockedUntil = 0;
    this.blockFailures = 0;
    this.closed = false;
    this.sourceCounters = { chainCalls: 0, metadataCalls: 0, failures: 0 };
  }

  getContracts(query) {
    if (this.closed) return Promise.reject(new DerivativesError("CLOSED", "derivatives service is closed"));
    const identity = queryIdentity(query, false);
    const date = String(this.tradingDate());
    this.#rollMetadataDate(date);
    const cacheKey = `${date}:${identity.symbol}`;
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
      .then(() => this.provider.getContracts(identity))
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

  addDemand(query) {
    if (this.closed) throw new DerivativesError("CLOSED", "derivatives service is closed");
    const identity = queryIdentity(query, true);
    const key = `index:${identity.symbol}:${identity.expiry}`;
    let demand = this.demands.get(key);
    if (!demand) {
      if (this.demands.size >= this.maxActiveKeys) throw new DerivativesError("CAPACITY", "at most two option chains may have active demand or grace retention");
      demand = { ...identity, key, count: 0, timer: null, graceTimer: null, graceExpired: false, inFlight: null, nextAttemptAt: 0 };
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
    if (!this.isMarketOpen()) {
      this.#setStatus(identity.key, { state: "closed", reason: "market-closed" });
      this.#scheduleNextOpen(identity.key);
      return Promise.resolve(this.scope.getSnapshot(identity.key));
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
    this.activeCalls += 1;
    this.sourceCounters.chainCalls += 1;
    const operation = Promise.resolve()
      .then(() => this.provider.getOptionChain(identity))
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
  }

  #release(key) {
    const demand = this.demands.get(key);
    if (!demand || demand.count < 1) return;
    demand.count -= 1;
    if (demand.count > 0) return;
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
    const stored = this.scope.ingestSnapshot(snapshot);
    if (!stored) return this.#handleFailure(key, new DerivativesError("SCHEMA_ERROR", "provider returned an invalid option-chain snapshot"));
    this.#emitUpdate(stored, "snapshot");
    this.blockFailures = 0;
    this.blockedUntil = 0;
    if (stored.state === "closed") this.#scheduleNextOpen(key);
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
    this.#schedule(key, normalizedDelay);
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
  }
}

module.exports = { DerivativesError, DerivativesService };
