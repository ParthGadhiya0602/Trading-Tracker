"use strict";

function createNseSession({
  base,
  referer,
  userAgents,
  warmupPaths,
  sessionTtl,
  log,
  requireFeed,
  DerivativesError,
}) {
  let jar = new Map();
  let warmedAt = 0;
  let warming = null;
  let warmingKind = null;

  function headers(uaIndex = 0) {
    return {
      "User-Agent": userAgents[uaIndex % userAgents.length],
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: base ? `${base}/` : undefined,
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

  class SourceTrafficCoordinator {
    constructor({ now = Date.now, random = Math.random, sleep = null } = {}) {
      this.now = now;
      this.random = random;
      this.sleep =
        sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
        if (this.closed)
          throw new Error("source traffic coordinator is closed");
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
        throw new DerivativesError(
          "SOURCE_CLOSED",
          "source traffic coordinator is closed",
        );
      }
      if (this.cashFlows > 0 || this.cashPending > 0 || this.cashInFlight > 0) {
        throw new DerivativesError(
          "SOURCE_BUSY",
          "cash market traffic has priority",
          { retryAfter: new Date(now + 1000).toUTCString() },
        );
      }
      const blockedUntil = Math.max(
        this.sourceBlockedUntil,
        this.derivativeBlockedUntil,
      );
      if (blockedUntil > now) {
        throw new DerivativesError(
          "SOURCE_BLOCKED",
          "upstream source is cooling down",
          { retryAfter: new Date(blockedUntil).toUTCString() },
        );
      }
      if (this.derivativeInFlight >= 2) {
        throw new DerivativesError(
          "SOURCE_BUSY",
          "derivative request concurrency reached",
          { retryAfter: new Date(now + 1000).toUTCString() },
        );
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
        this.sourceBlockedUntil = Math.max(
          this.sourceBlockedUntil,
          now + 1000,
        );
        const derivativeBackoff = Math.min(
          300_000,
          5000 * 2 ** (this.blockStreak - 1),
        );
        const jitter = Math.floor(
          this.random() * Math.min(1000, derivativeBackoff * 0.1),
        );
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

  function storeCookies(response) {
    const list =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie")]
          : [];
    for (const line of list) {
      const first = line.split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq > 0)
        jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
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

  async function srcGet(url, uaIndex, timeoutMs = 15000, requestReferer = null) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const requestHeaders = headers(uaIndex);
      if (requestReferer) requestHeaders.Referer = requestReferer;
      const cookies = cookieHeader();
      if (cookies) requestHeaders.Cookie = cookies;
      const response = await fetch(url, {
        headers: requestHeaders,
        redirect: "follow",
        signal: ac.signal,
      });
      storeCookies(response);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function warm(uaIndex = 0, kind = "cash") {
    requireFeed();
    jar = new Map();
    const paths = Array.isArray(warmupPaths) ? warmupPaths : ["/"];
    for (const warmupPath of paths) {
      const response = await sourceTraffic[
        kind === "derivative" ? "runDerivative" : "runCash"
      ](() => srcGet(`${base}${warmupPath}`, uaIndex, 10000), {
        warmup: true,
      });
      sourceTraffic.observeResponse(kind, response);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    warmedAt = Date.now();
  }

  async function ensureWarm(uaIndex, kind = "cash") {
    if (jar.size && Date.now() - warmedAt <= sessionTtl) return;
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

  async function srcJson(url, retries = 2) {
    return sourceTraffic.withCashPriority(() =>
      srcJsonWithRetries(url, retries),
    );
  }

  async function srcJsonWithRetries(url, retries) {
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt)
        await new Promise((resolve) =>
          setTimeout(resolve, 2 ** (attempt - 1) * 1000),
        );
      try {
        await ensureWarm(attempt, "cash");
        const response = sourceTraffic.observeResponse(
          "cash",
          await sourceTraffic.runCash(() =>
            srcGet(url, attempt, 15000, referer),
          ),
        );
        if (response.status === 401 || response.status === 403) {
          last = `HTTP ${response.status} (anti-bot block)`;
          jar = new Map();
          warmedAt = 0;
          continue;
        }
        if (!response.ok) {
          last = `HTTP ${response.status}`;
          jar = new Map();
          warmedAt = 0;
          continue;
        }
        return await response.json();
      } catch (error) {
        last =
          error && error.name === "AbortError"
            ? "timeout"
            : String((error && error.message) || error);
        jar = new Map();
        warmedAt = 0;
      }
    }
    throw new Error(`data fetch failed: ${last}`);
  }

  async function derivativeResponse(request) {
    await ensureWarm(0, "derivative");
    const requestReferer =
      request && request.referer
        ? new URL(request.referer, base).toString()
        : referer;
    const response = sourceTraffic.observeResponse(
      "derivative",
      await sourceTraffic.runDerivative(() =>
        srcGet(request.url, 0, 15000, requestReferer),
      ),
    );
    if (response.status === 401 || response.status === 403) {
      jar = new Map();
      warmedAt = 0;
    }
    return response;
  }

  return {
    headers,
    storeCookies,
    cookieHeader,
    srcGet,
    warm,
    ensureWarm,
    srcJson,
    srcJsonWithRetries,
    derivativeResponse,
    sourceTraffic,
  };
}

module.exports = { createNseSession };
