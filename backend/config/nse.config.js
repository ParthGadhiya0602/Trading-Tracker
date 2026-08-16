"use strict";

const { logWarn } = require("../core/logger");
const { STREAM_WS } = require("./env");

const INDEX_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "NIFTY 50",
    sourceName: "Nifty 50",
    constituentsEnv: "MARKET_NIFTY50_CONSTITUENTS_PATH",
    levelEnv: "MARKET_NIFTY50_LEVEL_PATH",
  }),
  Object.freeze({
    key: "NIFTY NEXT 50",
    sourceName: "Nifty Next 50",
    constituentsEnv: "MARKET_NIFTYNEXT50_CONSTITUENTS_PATH",
    levelEnv: "MARKET_NIFTYNEXT50_LEVEL_PATH",
  }),
  Object.freeze({
    key: "NIFTY MIDCAP 50",
    sourceName: "Nifty Midcap 50",
    constituentsEnv: "MARKET_NIFTYMIDCAP50_CONSTITUENTS_PATH",
    levelEnv: "MARKET_NIFTYMIDCAP50_LEVEL_PATH",
  }),
  Object.freeze({
    key: "NIFTY MIDCAP 100",
    sourceName: "Nifty Midcap 100",
    constituentsEnv: "MARKET_NIFTYMIDCAP100_CONSTITUENTS_PATH",
    levelEnv: "MARKET_NIFTYMIDCAP100_LEVEL_PATH",
  }),
]);

const WARMUP_PATHS = Object.freeze([
  "/",
  "/get-quotes/equity?symbol=RELIANCE",
]);

const DERIVATIVE_ENV = Object.freeze({
  masterQuoteEndpoint: "MARKET_DERIVATIVE_MASTER_QUOTE_ENDPOINT",
  stockQuoteEndpoint: "MARKET_DERIVATIVE_STOCK_QUOTE_ENDPOINT",
  contractInfoEndpoint: "MARKET_DERIVATIVE_CONTRACT_INFO_ENDPOINT",
  optionChainEndpoint: "MARKET_DERIVATIVE_OPTION_CHAIN_ENDPOINT",
  futuresEndpoint: "MARKET_DERIVATIVE_FUTURES_ENDPOINT",
  referer: "MARKET_DERIVATIVE_REFERER",
  futuresReferer: "MARKET_DERIVATIVE_FUTURES_REFERER",
  commodityFuturesEndpoint: "MARKET_COMMODITY_FUTURES_ENDPOINT",
  commodityOptionEndpoint: "MARKET_COMMODITY_OPTION_ENDPOINT",
  commodityFilterEndpoint: "MARKET_COMMODITY_FILTER_ENDPOINT",
  commodityDetailEndpoint: "MARKET_COMMODITY_DETAIL_ENDPOINT",
  commodityReferer: "MARKET_COMMODITY_REFERER",
});

function value(env, name) {
  const result = env[name];
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

function required(env, name) {
  const result = value(env, name);
  if (!result) throw new Error(`${name} is required (see .env.sample)`);
  return result;
}

function rootPath(env, name, isRequired = false) {
  const result = isRequired ? required(env, name) : value(env, name);
  if (result && (!result.startsWith("/") || result.startsWith("//"))) {
    throw new Error(`${name} must be a root-relative path`);
  }
  return result;
}

function streamRoute(env, name) {
  const result = value(env, name);
  if (!result) return null;
  const normalized = result.replace(/^\/+|\/+$/g, "");
  if (!normalized || /[?#]/.test(normalized)) {
    throw new Error(`${name} must be a WebSocket route without a query string`);
  }
  return normalized;
}

function baseUrl(env) {
  const raw = required(env, "MARKET_BASE_URL");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error("MARKET_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("MARKET_BASE_URL must be an HTTP(S) origin without credentials");
  }
  return parsed.origin;
}

function streamBaseUrl(env) {
  const raw = value(env, "MARKET_STREAM_BASE_URL");
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error("MARKET_STREAM_BASE_URL must be an absolute WebSocket URL");
  }
  if (!/^wss?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(
      "MARKET_STREAM_BASE_URL must be a WebSocket URL without credentials",
    );
  }
  return raw.replace(/\/$/, "");
}

function joinStreamUrl(base, path) {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function csv(env, name) {
  const raw = value(env, name);
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

function indexEntries(env, envField) {
  return Object.fromEntries(
    INDEX_DEFINITIONS.flatMap((definition) => {
      const path = streamRoute(env, definition[envField]);
      return path
        ? [[definition.key, { path, index: definition.sourceName }]]
        : [];
    }),
  );
}

function indexStream(env, sharedStreamBase, base) {
  const path = rootPath(env, "MARKET_INDEX_STREAM_PATH");
  const constituents = indexEntries(env, "constituentsEnv");
  const levels = indexEntries(env, "levelEnv");
  const requested = path || Object.keys(constituents).length || Object.keys(levels).length;
  if (!requested) return null;
  if (!sharedStreamBase) {
    throw new Error(
      "MARKET_STREAM_BASE_URL is required when index streaming is configured",
    );
  }
  if (!path) throw new Error("MARKET_INDEX_STREAM_PATH is required");
  return {
    wsBase: joinStreamUrl(sharedStreamBase, path),
    origin: base,
    indexParam: "index",
    constituents,
    levels,
  };
}

function derivatives(env, sharedStreamBase, base) {
  const configured =
    Object.values(DERIVATIVE_ENV).some((name) => value(env, name)) ||
    value(env, "MARKET_DERIVATIVE_SYMBOLS") ||
    value(env, "MARKET_DERIVATIVE_STREAM_PATH");
  if (!configured) return null;

  const result = {};
  for (const [property, envName] of Object.entries(DERIVATIVE_ENV)) {
    const configuredPath = rootPath(env, envName);
    if (configuredPath) result[property] = configuredPath;
  }
  result.enabledSymbols = csv(env, "MARKET_DERIVATIVE_SYMBOLS");

  const streamPath = rootPath(env, "MARKET_DERIVATIVE_STREAM_PATH");
  if (streamPath) {
    if (!sharedStreamBase) {
      throw new Error(
        "MARKET_STREAM_BASE_URL is required when derivative streaming is configured",
      );
    }
    result.stream = {
      wsBase: joinStreamUrl(sharedStreamBase, streamPath),
      origin: base,
      path: "mbp",
      symbolParam: "symbol",
      expiryParam: "expiry",
    };
  }
  return result;
}

function loadFeedConfig(env = process.env) {
  const hasConfig = value(env, "MARKET_BASE_URL") ||
    value(env, "MARKET_INDICES_ENDPOINT");
  if (!hasConfig) return null;

  const base = baseUrl(env);
  const sharedStreamBase = streamBaseUrl(env);
  const stream = indexStream(env, sharedStreamBase, base);
  const derivativeConfig = derivatives(env, sharedStreamBase, base);
  return {
    base,
    indicesEndpoint: rootPath(env, "MARKET_INDICES_ENDPOINT", true),
    preopenEndpoint: rootPath(env, "MARKET_PREOPEN_ENDPOINT"),
    referer: rootPath(env, "MARKET_REFERER", true),
    warmupPaths: [...WARMUP_PATHS],
    ...(stream ? { stream } : {}),
    ...(derivativeConfig ? { derivatives: derivativeConfig } : {}),
  };
}

const FEED = loadFeedConfig();
const BASE = FEED ? FEED.base : null;
const FEED_REF = FEED && FEED.referer ? `${BASE}${FEED.referer}` : null;
const INDEX_URL = (name) => {
  if (!FEED) throw new Error("market source is not configured");
  return `${BASE}${FEED.indicesEndpoint}${encodeURIComponent(name)}`;
};

function requireFeed() {
  if (!FEED) {
    throw new Error(
      "market source is not configured - set MARKET_BASE_URL and MARKET_INDICES_ENDPOINT (see .env.sample)",
    );
  }
}

function requireStream() {
  if (!STREAM_WS) return null;
  const stream = FEED && FEED.stream;
  if (
    !stream ||
    !stream.wsBase ||
    !Object.keys(stream.constituents || {}).length
  ) {
    logWarn(
      "stream",
      "STREAM_WS is set but index stream variables are missing/incomplete " +
        "(see .env.sample) - continuing in pure-REST mode.",
    );
    return null;
  }
  return stream;
}

module.exports = {
  BASE,
  FEED,
  FEED_REF,
  INDEX_DEFINITIONS,
  INDEX_URL,
  WARMUP_PATHS,
  loadFeedConfig,
  requireFeed,
  requireStream,
};
