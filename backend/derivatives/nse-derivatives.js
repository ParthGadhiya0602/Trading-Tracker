"use strict";

const SUPPORTED_SYMBOLS = new Set(["NIFTY", "NIFTYNXT50", "FINNIFTY", "BANKNIFTY", "MIDCPNIFTY", "NIFTYFPI"]);
const EQUITY_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9&._-]{0,29}$/;
const FUTURES_CATEGORIES = Object.freeze({
  NIFTY: "nse50_fut",
  NIFTYNXT50: "niftynxt50_fut",
  FINNIFTY: "finnifty_fut",
  BANKNIFTY: "nifty_bank_fut",
  MIDCPNIFTY: "niftymidcap_fut",
  NIFTYFPI: "niftyfpi_fut",
});
const MONTHS = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};
const MONTH_NAMES = Object.keys(MONTHS);

class ProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.httpStatus = options.httpStatus == null ? null : options.httpStatus;
    this.retryAfter = options.retryAfter == null ? null : options.retryAfter;
    this.contentType = options.contentType == null ? null : options.contentType;
    this.retryable = Boolean(options.retryable);
    this.details = options.details == null ? null : options.details;
    this.cause = options.cause || null;
  }
}

function configError(message, details) {
  return new ProviderError("CONFIG_ERROR", message, { details });
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function canonicalExpiry(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  let match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  let day;
  let month;
  let year;

  if (match) {
    [, day, month, year] = match;
  } else if ((match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(text))) {
    [, day, month, year] = match;
    month = MONTHS[month.toUpperCase()];
    if (!month) return null;
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) {
    [, year, month, day] = match;
  } else {
    return null;
  }

  day = Number(day);
  month = Number(month);
  year = Number(year);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function providerExpiry(expiry) {
  const [year, month, day] = expiry.split("-");
  return `${day}-${MONTH_NAMES[Number(month) - 1][0]}${MONTH_NAMES[Number(month) - 1].slice(1).toLowerCase()}-${year}`;
}

function numberOrNull(value) {
  if (value == null || value === "" || value === "-") return null;
  const normalized = typeof value === "string" ? value.trim().replaceAll(",", "") : value;
  if (normalized === "" || normalized === "-") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text !== "-" ? text : null;
}

function validClock(hour, minute, second) {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function sourceTimestamp(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  let match = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s(\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (match) {
    const [, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
    const year = Number(yearText);
    const month = MONTHS[monthText.toUpperCase()];
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (!month || day < 1 || day > daysInMonth(year, month) || !validClock(hour, minute, second)) return null;
    return `${yearText}-${String(month).padStart(2, "0")}-${dayText}T${hourText}:${minuteText}:${secondText}+05:30`;
  }
  match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || !validClock(hour, minute, second)) return null;
  if (offset !== "Z") {
    const [, offsetHour, offsetMinute] = /[+-](\d{2}):(\d{2})/.exec(offset);
    if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null;
  }
  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${fraction}${offset}`;
}

function istIso(now) {
  const date = new Date(Number(now));
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = Object.fromEntries(parts.filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}.${String(date.getUTCMilliseconds()).padStart(3, "0")}+05:30`;
}

function rootRelativeEndpoint(baseUrl, value, name) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    throw configError(`${name} must be a root-relative path`, { field: name });
  }
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw configError(`${name} is invalid`, { field: name });
  }
  if (url.origin !== baseUrl.origin) throw configError(`${name} must remain on the configured origin`, { field: name });
  return value;
}

function validateFactoryOptions(options) {
  if (!options || typeof options !== "object") throw configError("Provider options are required");
  let baseUrl;
  try {
    baseUrl = new URL(options.base);
  } catch {
    throw configError("base must be an absolute URL", { field: "base" });
  }
  if (!/^https?:$/.test(baseUrl.protocol)) throw configError("base must use HTTP or HTTPS", { field: "base" });
  const config = options.config;
  if (!config || typeof config !== "object") throw configError("config is required");
  const contractInfoEndpoint = rootRelativeEndpoint(baseUrl, config.contractInfoEndpoint, "contractInfoEndpoint");
  const optionChainEndpoint = rootRelativeEndpoint(baseUrl, config.optionChainEndpoint, "optionChainEndpoint");
  const masterQuoteEndpoint = config.masterQuoteEndpoint == null ? null : rootRelativeEndpoint(baseUrl, config.masterQuoteEndpoint, "masterQuoteEndpoint");
  const futuresEndpoint = config.futuresEndpoint == null ? null : rootRelativeEndpoint(baseUrl, config.futuresEndpoint, "futuresEndpoint");
  const stockQuoteEndpoint = config.stockQuoteEndpoint == null ? null : rootRelativeEndpoint(baseUrl, config.stockQuoteEndpoint, "stockQuoteEndpoint");
  const commodityFuturesEndpoint = config.commodityFuturesEndpoint == null ? null : rootRelativeEndpoint(baseUrl, config.commodityFuturesEndpoint, "commodityFuturesEndpoint");
  const commodityOptionEndpoint = config.commodityOptionEndpoint == null ? null : rootRelativeEndpoint(baseUrl, config.commodityOptionEndpoint, "commodityOptionEndpoint");
  const commodityFilterEndpoint = config.commodityFilterEndpoint == null ? null : rootRelativeEndpoint(baseUrl, config.commodityFilterEndpoint, "commodityFilterEndpoint");
  const commodityDetailEndpoint = config.commodityDetailEndpoint == null ? null : rootRelativeEndpoint(baseUrl, config.commodityDetailEndpoint, "commodityDetailEndpoint");
  const referer = rootRelativeEndpoint(baseUrl, config.referer, "referer");
  const commodityReferer = config.commodityReferer == null ? referer : rootRelativeEndpoint(baseUrl, config.commodityReferer, "commodityReferer");
  const futuresReferer = config.futuresReferer == null ? referer : rootRelativeEndpoint(baseUrl, config.futuresReferer, "futuresReferer");
  if (!Array.isArray(config.enabledSymbols) || config.enabledSymbols.some((symbol) => !SUPPORTED_SYMBOLS.has(symbol))) {
    throw configError("enabledSymbols must contain only supported symbols", { field: "enabledSymbols" });
  }
  if (typeof options.fetchResponse !== "function") throw configError("fetchResponse is required", { field: "fetchResponse" });
  if (typeof options.now !== "undefined" && typeof options.now !== "function") {
    throw configError("now must be a function", { field: "now" });
  }
  return { baseUrl, contractInfoEndpoint, optionChainEndpoint, masterQuoteEndpoint, futuresEndpoint, stockQuoteEndpoint, commodityFuturesEndpoint, commodityOptionEndpoint, commodityFilterEndpoint, commodityDetailEndpoint, referer, futuresReferer, commodityReferer, enabledSymbols: new Set(config.enabledSymbols) };
}

function validateQuery(query, requireExpiry, enabledSymbols) {
  if (!query || typeof query !== "object" || !["index", "equity"].includes(query.market)) {
    throw new ProviderError("INVALID_QUERY", "market must be index or equity", { details: { field: "market" } });
  }
  const validSymbol = query.market === "index"
    ? typeof query.symbol === "string" && enabledSymbols.has(query.symbol)
    : typeof query.symbol === "string" && EQUITY_SYMBOL_PATTERN.test(query.symbol);
  if (!validSymbol) {
    throw new ProviderError("INVALID_QUERY", "symbol is not enabled", { details: { field: "symbol" } });
  }
  if (!requireExpiry) return null;
  const expiry = canonicalExpiry(query.expiry);
  if (!expiry) throw new ProviderError("INVALID_QUERY", "expiry must be a valid supported date", { details: { field: "expiry" } });
  return expiry;
}

function retryAfter(headers) {
  const raw = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

async function readJson(fetchResponse, request) {
  let response;
  try {
    response = await fetchResponse(request);
  } catch (cause) {
    throw new ProviderError("TRANSPORT_ERROR", "NSE request failed", { retryable: true, cause });
  }
  if (!response || typeof response.status !== "number" || typeof response.ok !== "boolean" || !response.headers || typeof response.headers.get !== "function" || typeof response.text !== "function") {
    throw new ProviderError("TRANSPORT_ERROR", "NSE response is not Response-compatible", { retryable: true });
  }
  const status = response.status;
  if (response.ok !== (status >= 200 && status < 300)) {
    throw new ProviderError("TRANSPORT_ERROR", "NSE response has inconsistent status metadata", { retryable: true });
  }
  if (status < 200 || status >= 300) {
    const options = { httpStatus: status, retryAfter: retryAfter(response.headers), retryable: status === 408 || status === 429 || status >= 500 };
    if (status === 401 || status === 403) throw new ProviderError("UPSTREAM_BLOCKED", "NSE blocked the request", options);
    if (status === 404) throw new ProviderError("NOT_FOUND", "NSE resource was not found", options);
    if (status === 429) throw new ProviderError("RATE_LIMITED", "NSE rate limit reached", options);
    throw new ProviderError("UPSTREAM_HTTP", "NSE returned an HTTP error", options);
  }
  const contentType = response.headers.get("content-type");
  const mediaType = typeof contentType === "string" ? contentType.split(";", 1)[0].trim() : "";
  if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/i.test(mediaType)) {
    throw new ProviderError("NON_JSON_RESPONSE", "NSE did not return JSON", { httpStatus: status, contentType: contentType || null, retryable: false });
  }
  let body;
  try {
    body = await response.text();
  } catch (cause) {
    throw new ProviderError("TRANSPORT_ERROR", "Unable to read NSE response", { httpStatus: status, contentType, retryable: true, cause });
  }
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new ProviderError("MALFORMED_JSON", "NSE returned malformed JSON", { httpStatus: status, contentType, cause });
  }
}

function schemaError(message, details) {
  return new ProviderError("SCHEMA_ERROR", message, { details });
}

function dataRoot(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw schemaError("NSE JSON must be an object");
  return payload.records && typeof payload.records === "object" && !Array.isArray(payload.records) ? payload.records : payload;
}

function identityError(message, details) {
  return new ProviderError("IDENTITY_MISMATCH", message, { details });
}

function validateIdentity(value, expectedSymbol, expectedExpiry, field) {
  if (value == null || value === "") return;
  if (field === "expiry") {
    const canonical = canonicalExpiry(String(value));
    if (!canonical || canonical !== expectedExpiry) throw identityError("NSE response expiry does not match query", { field });
  } else if (String(value).trim().toUpperCase() !== expectedSymbol) {
    throw identityError("NSE response symbol does not match query", { field });
  }
}

function findLeg(row, name) {
  return row[name] || row[name.toLowerCase()] || row[name === "CE" ? "call" : "put"] || null;
}

function legValue(leg, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(leg, name)) return leg[name];
  }
  return null;
}

function normalizeLeg(leg, side, symbol, expiry, strike, underlyingValue) {
  validateIdentity(leg.underlying, symbol, expiry, "underlying");
  validateIdentity(leg.expiryDate, symbol, expiry, "expiry");
  if (leg.strikePrice != null && leg.strikePrice !== "") {
    const legStrike = numberOrNull(leg.strikePrice);
    if (legStrike == null || legStrike !== strike) throw identityError("NSE leg strike does not match its row", { field: "strikePrice" });
  }
  const legUnderlyingValue = numberOrNull(leg.underlyingValue);
  return {
    providerContractId: stringOrNull(legValue(leg, ["identifier", "contractId", "instrumentKey"])),
    side,
    underlying: symbol,
    expiry,
    strike,
    underlyingValue: legUnderlyingValue == null ? underlyingValue : legUnderlyingValue,
    openInterest: numberOrNull(legValue(leg, ["openInterest"])),
    changeInOpenInterest: numberOrNull(legValue(leg, ["changeinOpenInterest", "changeInOpenInterest"])),
    percentChangeInOpenInterest: numberOrNull(legValue(leg, ["pchangeinOpenInterest", "pChangeinOpenInterest", "percentChangeInOpenInterest"])),
    volume: numberOrNull(legValue(leg, ["totalTradedVolume", "volume"])),
    impliedVolatility: numberOrNull(legValue(leg, ["impliedVolatility"])),
    lastPrice: numberOrNull(legValue(leg, ["lastPrice"])),
    change: numberOrNull(legValue(leg, ["change"])),
    percentChange: numberOrNull(legValue(leg, ["pChange", "PChange", "percentChange"])),
    bidQuantity: numberOrNull(legValue(leg, ["buyQuantity1", "bidQty", "bidquantity", "bidQuantity"])),
    bidPrice: numberOrNull(legValue(leg, ["buyPrice1", "bidprice", "bidPrice"])),
    askPrice: numberOrNull(legValue(leg, ["sellPrice1", "askPrice", "askprice"])),
    askQuantity: numberOrNull(legValue(leg, ["sellQuantity1", "askQty", "askquantity", "askQuantity"])),
  };
}

// One live WSS leg (streams/fo/mbp) -> a pruned patch of ONLY the fields the stream carries
// (price/bid/ask/ltp/change). OI/volume/IV are never in a stream frame, so they are omitted
// and the store keeps whatever REST last provided. Returns null when the leg has nothing usable.
function normalizeStreamLeg(leg) {
  if (!leg || typeof leg !== "object" || Array.isArray(leg)) return null;
  const patch = {
    lastPrice: numberOrNull(legValue(leg, ["lastPrice"])),
    change: numberOrNull(legValue(leg, ["change"])),
    bidPrice: numberOrNull(legValue(leg, ["buyPrice1", "bidPrice"])),
    askPrice: numberOrNull(legValue(leg, ["sellPrice1", "askPrice"])),
    bidQuantity: numberOrNull(legValue(leg, ["buyQuantity1", "bidQuantity"])),
    askQuantity: numberOrNull(legValue(leg, ["sellQuantity1", "askQuantity"])),
  };
  const out = {};
  for (const [name, value] of Object.entries(patch)) if (value != null) out[name] = value;
  return Object.keys(out).length ? out : null;
}

// One raw option-chain WSS frame -> a normalized single-strike delta for
// MarketStore.DerivativeScope.applyTick(). context = { market, symbol, expiry } where expiry
// is the STORE (ISO) expiry, so the delta key matches the REST-seeded chain. Never throws.
function normalizeStreamFrame(raw, context) {
  let frame;
  try { frame = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return null; }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  if (!context || !context.market || !context.symbol || !context.expiry) return null;
  const strike = numberOrNull(frame.strikePrice);
  if (strike == null) return null;
  const call = normalizeStreamLeg(findLeg(frame, "CE"));
  const put = normalizeStreamLeg(findLeg(frame, "PE"));
  if (!call && !put) return null;
  const delta = {
    key: `${context.market}:${context.symbol}:${context.expiry}`,
    kind: "option-chain",
    market: context.market,
    symbol: context.symbol,
    expiry: context.expiry,
    strike,
  };
  if (call) delta.call = call;
  if (put) delta.put = put;
  // A live-tick marker, kept distinct from REST's sourceTimestamp (which owns ingest ordering).
  const stamp = sourceTimestamp(frame.timestamp);
  if (typeof stamp === "string") delta.streamedAt = stamp;
  return delta;
}

function createNseDerivatives(options) {
  const validated = validateFactoryOptions(options);
  const now = options.now || Date.now;

  async function getEquitySymbols() {
    if (!validated.masterQuoteEndpoint) throw configError("masterQuoteEndpoint is required for stock options", { field: "masterQuoteEndpoint" });
    const url = new URL(validated.masterQuoteEndpoint, validated.baseUrl);
    const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.referer });
    if (!Array.isArray(payload)) throw schemaError("NSE master quote response must be an array");
    const symbols = new Set();
    let discardedSymbols = 0;
    for (const raw of payload) {
      const symbol = typeof raw === "string" ? raw.trim().toUpperCase() : "";
      if (!EQUITY_SYMBOL_PATTERN.test(symbol)) discardedSymbols += 1;
      else symbols.add(symbol);
    }
    if (!symbols.size) throw schemaError("NSE master quote response has no valid symbols");
    return {
      kind: "equity-symbols",
      market: "equity",
      symbols: [...symbols].sort((a, b) => a.localeCompare(b)),
      receivedAt: istIso(now()),
      diagnostics: { totalSymbols: payload.length, validSymbols: symbols.size, discardedSymbols },
    };
  }

  async function getContracts(query) {
    validateQuery(query, false, validated.enabledSymbols);
    const url = new URL(validated.contractInfoEndpoint, validated.baseUrl);
    url.searchParams.set("symbol", query.symbol);
    const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.referer });
    const records = dataRoot(payload);
    validateIdentity(records.underlying || records.symbol, query.symbol, null, "underlying");
    const rawExpiries = records.expiryDates;
    if (!Array.isArray(rawExpiries)) throw schemaError("NSE contracts response has no expiry dates");
    let discardedExpiries = 0;
    const expiries = new Map();
    for (const raw of rawExpiries) {
      const expiry = canonicalExpiry(String(raw));
      if (!expiry) {
        discardedExpiries += 1;
        continue;
      }
      if (expiries.has(expiry)) {
        discardedExpiries += 1;
        continue;
      }
      expiries.set(expiry, String(raw));
    }
    if (!expiries.size) throw schemaError("NSE contracts response has no valid expiry dates");
    let discardedStrikes = 0;
    const strikes = new Set();
    for (const raw of Array.isArray(records.strikePrices) ? records.strikePrices : []) {
      const strike = numberOrNull(raw);
      if (strike == null) discardedStrikes += 1;
      else strikes.add(strike);
    }
    return {
      kind: "option-contracts",
      market: query.market,
      symbol: query.symbol,
      expiries: [...expiries].sort(([a], [b]) => a.localeCompare(b)).map(([expiry, providerValue]) => ({ expiry, providerValue })),
      strikes: [...strikes].sort((a, b) => a - b),
      sourceTimestamp: sourceTimestamp(records.timestamp),
      receivedAt: istIso(now()),
      diagnostics: { discardedExpiries, discardedStrikes },
    };
  }

  async function getOptionChain(query) {
    const expiry = validateQuery(query, true, validated.enabledSymbols);
    const url = new URL(validated.optionChainEndpoint, validated.baseUrl);
    url.searchParams.set("type", query.market === "equity" ? "Equity" : "Indices");
    url.searchParams.set("symbol", query.symbol);
    url.searchParams.set("expiry", providerExpiry(expiry));
    const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.referer });
    const records = dataRoot(payload);
    validateIdentity(records.underlying || records.symbol, query.symbol, expiry, "underlying");
    const rawRows = payload.filtered && Array.isArray(payload.filtered.data) ? payload.filtered.data : records.data;
    const closed = /closed/i.test(String(payload.marketStatus || records.marketStatus || payload.marketState || records.marketState || ""));
    if (!Array.isArray(rawRows)) throw schemaError("NSE option-chain response has no data rows");
    const underlyingValue = numberOrNull(records.underlyingValue == null ? payload.underlyingValue : records.underlyingValue);
    const rowsByStrike = new Map();
    let discardedRows = 0;
    for (const rawRow of rawRows) {
      if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
        discardedRows += 1;
        continue;
      }
      validateIdentity(rawRow.underlying, query.symbol, expiry, "underlying");
      validateIdentity(rawRow.expiryDate, query.symbol, expiry, "expiry");
      if (rawRow.expiryDates != null) {
        const values = Array.isArray(rawRow.expiryDates) ? rawRow.expiryDates : [rawRow.expiryDates];
        for (const value of values) validateIdentity(value, query.symbol, expiry, "expiry");
      }
      const strike = numberOrNull(rawRow.strikePrice);
      if (strike == null) {
        discardedRows += 1;
        continue;
      }
      let row = rowsByStrike.get(strike);
      if (!row) {
        row = { strike, call: null, put: null };
        rowsByStrike.set(strike, row);
      } else {
        discardedRows += 1;
      }
      for (const [name, side, key] of [["CE", "CE", "call"], ["PE", "PE", "put"]]) {
        const leg = findLeg(rawRow, name);
        if (leg == null) continue;
        if (typeof leg !== "object" || Array.isArray(leg) || row[key]) {
          discardedRows += 1;
          continue;
        }
        row[key] = normalizeLeg(leg, side, query.symbol, expiry, strike, underlyingValue);
      }
      if (!row.call && !row.put) {
        rowsByStrike.delete(strike);
        discardedRows += 1;
      }
    }
    const rows = [...rowsByStrike.values()].sort((a, b) => a.strike - b.strike);
    const missingCallLegs = rows.filter((row) => !row.call).length;
    const missingPutLegs = rows.filter((row) => !row.put).length;
    const missingIvLegs = rows.flatMap((row) => [row.call, row.put]).filter((leg) => leg && leg.impliedVolatility == null).length;
    if (!rows.length) {
      throw schemaError("NSE option-chain response has no valid rows", {
        totalRows: rawRows.length,
        validRows: 0,
        discardedRows,
        missingCallLegs,
        missingPutLegs,
        missingIvLegs,
      });
    }
    const partial = rows.some((row) => !row.call || !row.put);
    return {
      kind: "option-chain",
      key: `${query.market}:${query.symbol}:${expiry}`,
      market: query.market,
      symbol: query.symbol,
      expiry,
      transport: "rest",
      stale: false,
      state: closed ? "closed" : partial ? "partial" : "live",
      reason: closed ? "market-closed" : partial ? "missing-leg" : null,
      data: { underlyingValue, rows },
      sourceTimestamp: sourceTimestamp(records.timestamp),
      receivedAt: istIso(now()),
      diagnostics: {
        totalRows: rawRows.length,
        validRows: rows.length,
        discardedRows,
        missingCallLegs,
        missingPutLegs,
        missingIvLegs,
      },
    };
  }

  async function getIndexFutures(query) {
    validateQuery(query, false, validated.enabledSymbols);
    if (query.market !== "index") throw new ProviderError("INVALID_QUERY", "futures market must be index", { details: { field: "market" } });
    if (!validated.futuresEndpoint) throw configError("futuresEndpoint is required for index futures", { field: "futuresEndpoint" });
    const url = new URL(validated.futuresEndpoint, validated.baseUrl);
    url.searchParams.set("index", FUTURES_CATEGORIES[query.symbol]);
    const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.futuresReferer });
    const records = dataRoot(payload);
    const rawRows = Array.isArray(records.data) ? records.data : Array.isArray(payload.data) ? payload.data : null;
    if (!rawRows) throw schemaError("NSE futures response has no data rows");

    const rows = [];
    let discardedRows = 0;
    for (const raw of rawRows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || String(raw.instrumentType || "").toUpperCase() !== "FUTIDX") {
        discardedRows += 1;
        continue;
      }
      if (String(raw.underlying || "").trim().toUpperCase() !== query.symbol) {
        discardedRows += 1;
        continue;
      }
      try {
        validateIdentity(raw.underlying, query.symbol, null, "underlying");
      } catch (error) {
        if (error && error.code === "IDENTITY_MISMATCH") {
          discardedRows += 1;
          continue;
        }
        throw error;
      }
      const expiry = canonicalExpiry(String(raw.expiryDate || ""));
      const providerContractId = stringOrNull(raw.identifier);
      if (!expiry || !providerContractId) {
        discardedRows += 1;
        continue;
      }
      rows.push({
        providerContractId,
        contract: stringOrNull(raw.contract),
        expiry,
        lastPrice: numberOrNull(raw.lastPrice),
        change: numberOrNull(raw.change),
        percentChange: numberOrNull(raw.pChange == null ? raw.PChange : raw.pChange),
        openPrice: numberOrNull(raw.openPrice),
        highPrice: numberOrNull(raw.highPrice),
        lowPrice: numberOrNull(raw.lowPrice),
        previousClose: numberOrNull(raw.closePrice),
        volume: numberOrNull(raw.volume),
        turnover: numberOrNull(raw.totalTurnover == null ? raw.value : raw.totalTurnover),
        openInterest: numberOrNull(raw.openInterest),
        trades: numberOrNull(raw.noOfTrades),
        underlyingValue: numberOrNull(raw.underlyingValue),
      });
    }
    rows.sort((a, b) => a.expiry.localeCompare(b.expiry));
    if (!rows.length) throw schemaError("NSE futures response has no valid index-futures rows", { totalRows: rawRows.length, discardedRows });
    const marketStatus = payload.marketStatus && typeof payload.marketStatus === "object" ? payload.marketStatus : records.marketStatus;
    const marketStatusText = marketStatus && typeof marketStatus === "object"
      ? `${marketStatus.marketOpenOrClose || ""} ${marketStatus.marketStatusMessage || ""}`
      : String(marketStatus || "");
    const closed = /closed?/i.test(marketStatusText);
    return {
      kind: "index-futures",
      key: `future:index:${query.symbol}`,
      market: "index",
      symbol: query.symbol,
      transport: "rest",
      stale: closed,
      state: closed ? "closed" : "live",
      reason: closed ? "market-closed" : null,
      data: { rows },
      sourceTimestamp: sourceTimestamp(payload.timestamp || records.timestamp),
      receivedAt: istIso(now()),
      diagnostics: { totalRows: rawRows.length, validRows: rows.length, discardedRows },
    };
  }

  function requireEquitySymbol(query) {
    const symbol = query && typeof query.symbol === "string" ? query.symbol.trim().toUpperCase() : "";
    if (!EQUITY_SYMBOL_PATTERN.test(symbol)) throw new ProviderError("INVALID_QUERY", "invalid stock symbol", { details: { field: "symbol" } });
    return symbol;
  }

  function stockQuoteUrl(functionName, params) {
    if (!validated.stockQuoteEndpoint) throw configError("stockQuoteEndpoint is required for stock futures", { field: "stockQuoteEndpoint" });
    const url = new URL(validated.stockQuoteEndpoint, validated.baseUrl);
    url.searchParams.set("functionName", functionName);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url;
  }

  // Expiry dates available for a stock's futures (getSymbolDerivativesFilter -> { expiryDate: [...] }).
  async function getStockFuturesExpiries(query) {
    const symbol = requireEquitySymbol(query);
    const url = stockQuoteUrl("getSymbolDerivativesFilter", { isSymbolIndex: "S", symbol });
    const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.futuresReferer });
    const rawList = Array.isArray(payload.expiryDate)
      ? payload.expiryDate
      : payload.data && Array.isArray(payload.data.expiryDate) ? payload.data.expiryDate : null;
    if (!rawList) throw schemaError("NSE stock-futures filter response has no expiryDate list");
    const seen = new Set();
    const expiries = [];
    for (const value of rawList) {
      const expiry = canonicalExpiry(String(value || ""));
      if (!expiry || seen.has(expiry)) continue;
      seen.add(expiry);
      expiries.push({ expiry, providerValue: String(value).trim() });
    }
    expiries.sort((a, b) => a.expiry.localeCompare(b.expiry));
    if (!expiries.length) throw schemaError("NSE stock-futures filter response has no valid expiries");
    return { kind: "stock-future-contracts", market: "stock", symbol, expiries, receivedAt: istIso(now()) };
  }

  // One FUTSTK quote row (getSymbolDerivativesData) -> a normalized futures row. Field names
  // per the GetQuoteApi FUT response (identifier, pchange, changeinOpenInterest, prevClose, ...).
  function normalizeStockFutureRow(raw, symbol) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (String(raw.instrumentType || "").toUpperCase() !== "FUTSTK") return null;
    const rowSymbol = (stringOrNull(raw.underlying) || symbol || "").trim().toUpperCase();
    const expiry = canonicalExpiry(String(raw.expiryDate || ""));
    if (!rowSymbol || !expiry) return null;
    return {
      symbol: rowSymbol,
      underlying: rowSymbol,
      providerContractId: stringOrNull(raw.identifier) || `${rowSymbol}:${expiry}`,
      expiry,
      lastPrice: numberOrNull(raw.lastPrice),
      change: numberOrNull(raw.change),
      percentChange: numberOrNull(legValue(raw, ["pchange", "pChange", "PChange"])),
      openPrice: numberOrNull(raw.openPrice),
      highPrice: numberOrNull(raw.highPrice),
      lowPrice: numberOrNull(raw.lowPrice),
      previousClose: numberOrNull(legValue(raw, ["prevClose", "closePrice"])),
      volume: numberOrNull(legValue(raw, ["totalTradedVolume", "volume"])),
      turnover: numberOrNull(legValue(raw, ["totalTurnover", "value"])),
      openInterest: numberOrNull(raw.openInterest),
      changeInOpenInterest: numberOrNull(legValue(raw, ["changeinOpenInterest", "changeInOpenInterest"])),
      percentChangeInOpenInterest: numberOrNull(legValue(raw, ["pchangeinOpenInterest", "pChangeinOpenInterest"])),
      underlyingValue: numberOrNull(raw.underlyingValue),
    };
  }

  // A single stock's full futures strip: expiries via the filter call, then one data call per
  // expiry (in parallel), assembled into one snapshot keyed `future:stock:<SYMBOL>`. REST-only.
  async function getStockFutures(query) {
    const symbol = requireEquitySymbol(query);
    const { expiries } = await getStockFuturesExpiries({ symbol });
    let latestTs = null;
    const settled = await Promise.all(expiries.map(async ({ expiry, providerValue }) => {
      const url = stockQuoteUrl("getSymbolDerivativesData", { symbol, instrumentType: "FUT", expiryDt: providerValue });
      try {
        const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.futuresReferer });
        const list = Array.isArray(payload.data) ? payload.data : [];
        const ts = sourceTimestamp(payload.timestamp);
        if (ts && (!latestTs || ts > latestTs)) latestTs = ts;
        for (const raw of list) {
          const row = normalizeStockFutureRow(raw, symbol);
          if (row && row.expiry === expiry) return row;
        }
        return null;
      } catch (_) {
        return null; // one bad expiry never sinks the whole strip
      }
    }));
    const rows = settled.filter(Boolean).sort((a, b) => a.expiry.localeCompare(b.expiry));
    if (!rows.length) throw schemaError("NSE stock-futures returned no valid FUTSTK rows", { symbol, expiries: expiries.length });
    return {
      kind: "stock-futures",
      key: `future:stock:${symbol}`,
      market: "stock",
      symbol,
      transport: "rest",
      stale: false,
      state: "live",
      reason: null,
      data: { rows },
      sourceTimestamp: latestTs,
      receivedAt: istIso(now()),
      diagnostics: { expiries: expiries.length, validRows: rows.length },
    };
  }

  // ---- MCX commodity futures (watch-based: one call carries every symbol × expiry) ----
  function requireCommoditySymbol(query) {
    const symbol = query && typeof query.symbol === "string" ? query.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{1,20}$/.test(symbol)) throw new ProviderError("INVALID_QUERY", "invalid commodity symbol", { details: { field: "symbol" } });
    return symbol;
  }

  function commodityCategory(instrument) {
    return (stringOrNull(instrument) || "").replace(/\s*futures?\s*$/i, "").trim() || null;
  }

  async function commodityFuturesWatch() {
    if (!validated.commodityFuturesEndpoint) throw configError("commodityFuturesEndpoint is required for commodity futures", { field: "commodityFuturesEndpoint" });
    const url = new URL(validated.commodityFuturesEndpoint, validated.baseUrl);
    const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.commodityReferer });
    const records = dataRoot(payload);
    const rawRows = Array.isArray(records.data) ? records.data : Array.isArray(payload.data) ? payload.data : null;
    if (!rawRows) throw schemaError("NSE commodity futures response has no data rows");
    const marketStatus = payload.marketStatus && typeof payload.marketStatus === "object" ? payload.marketStatus : records.marketStatus;
    const closed = /close/i.test(String((marketStatus && (marketStatus.marketStatus || marketStatus.marketStatusMessage)) || ""));
    return { rawRows, closed, sourceTimestamp: sourceTimestamp(payload.timestamp || records.timestamp) };
  }

  function normalizeCommodityFutureRow(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (!/^FUT/i.test(String(raw.instrumentType || ""))) return null; // futures only
    const symbol = (stringOrNull(raw.contract) || "").trim().toUpperCase();
    const expiry = canonicalExpiry(String(raw.expiryDate || ""));
    if (!symbol || !expiry) return null;
    return {
      symbol,
      underlying: symbol,
      providerContractId: stringOrNull(raw.identifier) || `${symbol}:${expiry}`,
      instrumentType: stringOrNull(raw.instrumentType),
      category: commodityCategory(raw.instrument),
      unit: stringOrNull(raw.unit),
      expiry,
      lastPrice: numberOrNull(raw.lastPrice),
      change: numberOrNull(raw.change),
      percentChange: numberOrNull(legValue(raw, ["pChange", "pchange", "PChange"])),
      openPrice: numberOrNull(raw.openPrice),
      highPrice: numberOrNull(raw.highPrice),
      lowPrice: numberOrNull(raw.lowPrice),
      previousClose: numberOrNull(raw.prevClose),
      volume: numberOrNull(legValue(raw, ["numberOfContractsTraded", "volume"])),
      turnover: numberOrNull(raw.totalTurnover),
      openInterest: numberOrNull(raw.openInterest),
      underlyingValue: numberOrNull(raw.spotPrice),
    };
  }

  // Distinct commodity symbols (+ their category) from the futures watch — feeds the picker.
  async function getCommoditySymbols() {
    const { rawRows } = await commodityFuturesWatch();
    const bySymbol = new Map();
    for (const raw of rawRows) {
      const row = normalizeCommodityFutureRow(raw);
      if (row && !bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row.category);
    }
    if (!bySymbol.size) throw schemaError("NSE commodity futures watch has no valid symbols");
    const symbols = [...bySymbol.entries()].map(([symbol, category]) => ({ symbol, category })).sort((a, b) => a.symbol.localeCompare(b.symbol));
    return { kind: "commodity-symbols", market: "commodity", symbols, receivedAt: istIso(now()) };
  }

  // One commodity's futures strip: the watch rows for that symbol, nearest expiry first.
  async function getCommodityFutures(query) {
    const symbol = requireCommoditySymbol(query);
    const { rawRows, closed, sourceTimestamp: ts } = await commodityFuturesWatch();
    const rows = rawRows
      .map(normalizeCommodityFutureRow)
      .filter((row) => row && row.symbol === symbol)
      .sort((a, b) => a.expiry.localeCompare(b.expiry));
    if (!rows.length) throw new ProviderError("NOT_FOUND", "no commodity futures for this symbol", { details: { symbol } });
    return {
      kind: "commodity-futures",
      key: `commodity:fut:${symbol}`,
      market: "commodity",
      symbol,
      transport: "rest",
      stale: closed,
      state: closed ? "closed" : "live",
      reason: closed ? "market-closed" : null,
      data: { rows, category: rows[0].category, unit: rows[0].unit },
      sourceTimestamp: ts,
      receivedAt: istIso(now()),
      diagnostics: { expiries: rows.length },
    };
  }

  // ---- MCX commodity options (master-filter expiries + option watch filtered by symbol+expiry) ----
  // Expiry list for a commodity's options (master-filter -> data.OPTFUT.expiryDates, DD-MM-YYYY).
  async function getCommodityContracts(query) {
    const symbol = requireCommoditySymbol(query);
    if (!validated.commodityFilterEndpoint) throw configError("commodityFilterEndpoint is required for commodity options", { field: "commodityFilterEndpoint" });
    const url = new URL(validated.commodityFilterEndpoint, validated.baseUrl);
    url.searchParams.set("symbol", symbol);
    const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.commodityReferer });
    const opt = payload.data && payload.data.OPTFUT;
    const rawExpiries = opt && Array.isArray(opt.expiryDates) ? opt.expiryDates : null;
    if (!rawExpiries) throw schemaError("NSE commodity master-filter has no OPTFUT expiryDates");
    const seen = new Set();
    const expiries = [];
    for (const value of rawExpiries) {
      const expiry = canonicalExpiry(String(value || ""));
      if (!expiry || seen.has(expiry)) continue;
      seen.add(expiry);
      expiries.push({ expiry, providerValue: String(value).trim() });
    }
    expiries.sort((a, b) => a.expiry.localeCompare(b.expiry));
    if (!expiries.length) throw schemaError("NSE commodity master-filter has no valid OPTFUT expiries");
    return { kind: "option-contracts", market: "commodity", symbol, expiries, receivedAt: istIso(now()) };
  }

  // One OPTFUT watch row -> a normalized option leg (matches the equity leg shape so the
  // existing analysis works). The watch carries OI/volume/LTP only — no IV or bid/ask.
  function normalizeCommodityOptionLeg(raw, side, symbol, expiry, strike) {
    return {
      providerContractId: stringOrNull(raw.identifier),
      side,
      underlying: symbol,
      expiry,
      strike,
      underlyingValue: numberOrNull(raw.spotPrice),
      openInterest: numberOrNull(raw.openInterest),
      changeInOpenInterest: null,
      percentChangeInOpenInterest: null,
      volume: numberOrNull(legValue(raw, ["numberOfContractsTraded", "volume"])),
      impliedVolatility: null,
      lastPrice: numberOrNull(raw.lastPrice),
      change: numberOrNull(raw.change),
      percentChange: numberOrNull(legValue(raw, ["pChange", "pchange", "PChange"])),
      bidQuantity: null,
      bidPrice: null,
      askPrice: null,
      askQuantity: null,
    };
  }

  // A commodity's option chain for one expiry: the option watch filtered to this symbol+expiry,
  // grouped by strike into CE/PE legs. Keyed `commodity:<SYMBOL>:<ISO-EXPIRY>` (option-chain shape).
  async function getCommodityOptionChain(query) {
    const symbol = requireCommoditySymbol(query);
    const expiry = canonicalExpiry(String(query && query.expiry || ""));
    if (!expiry) throw new ProviderError("INVALID_QUERY", "expiry must be a valid date", { details: { field: "expiry" } });
    if (!validated.commodityOptionEndpoint) throw configError("commodityOptionEndpoint is required for commodity options", { field: "commodityOptionEndpoint" });
    const url = new URL(validated.commodityOptionEndpoint, validated.baseUrl);
    const payload = await readJson(options.fetchResponse, { url: url.toString(), referer: validated.commodityReferer });
    const records = dataRoot(payload);
    const rawRows = Array.isArray(records.data) ? records.data : Array.isArray(payload.data) ? payload.data : null;
    if (!rawRows) throw schemaError("NSE commodity option response has no data rows");
    const marketStatus = payload.marketStatus && typeof payload.marketStatus === "object" ? payload.marketStatus : records.marketStatus;
    const closed = /close/i.test(String((marketStatus && (marketStatus.marketStatus || marketStatus.marketStatusMessage)) || ""));
    const rowsByStrike = new Map();
    let underlyingValue = null;
    let discardedRows = 0;
    for (const raw of rawRows) {
      if (!raw || typeof raw !== "object" || String(raw.instrumentType || "").toUpperCase() !== "OPTFUT") { discardedRows += 1; continue; }
      if ((stringOrNull(raw.contract) || "").trim().toUpperCase() !== symbol) { discardedRows += 1; continue; }
      if (canonicalExpiry(String(raw.expiryDate || "")) !== expiry) { discardedRows += 1; continue; }
      const strike = numberOrNull(raw.strikePrice);
      const side = /^c/i.test(String(raw.optionType || "")) ? "CE" : /^p/i.test(String(raw.optionType || "")) ? "PE" : null;
      if (strike == null || !side) { discardedRows += 1; continue; }
      if (underlyingValue == null) underlyingValue = numberOrNull(raw.spotPrice);
      let row = rowsByStrike.get(strike);
      if (!row) { row = { strike, call: null, put: null }; rowsByStrike.set(strike, row); }
      const key = side === "CE" ? "call" : "put";
      if (!row[key]) row[key] = normalizeCommodityOptionLeg(raw, side, symbol, expiry, strike);
    }
    const rows = [...rowsByStrike.values()].sort((a, b) => a.strike - b.strike);
    if (!rows.length) throw schemaError("NSE commodity option response has no rows for this symbol/expiry", { symbol, expiry, discardedRows });
    const partial = rows.some((row) => !row.call || !row.put);
    return {
      kind: "option-chain",
      key: `commodity:${symbol}:${expiry}`,
      market: "commodity",
      symbol,
      expiry,
      transport: "rest",
      stale: closed,
      state: closed ? "closed" : partial ? "partial" : "live",
      reason: closed ? "market-closed" : partial ? "missing-leg" : null,
      data: { underlyingValue, rows },
      sourceTimestamp: sourceTimestamp(payload.timestamp || records.timestamp),
      receivedAt: istIso(now()),
      diagnostics: { totalRows: rawRows.length, validRows: rows.length, discardedRows },
    };
  }

  return { getEquitySymbols, getContracts, getOptionChain, getIndexFutures, getStockFutures, getStockFuturesExpiries, getCommoditySymbols, getCommodityFutures, getCommodityContracts, getCommodityOptionChain, normalizeStreamFrame };
}

module.exports = { createNseDerivatives, ProviderError, normalizeStreamFrame, providerExpiry };
