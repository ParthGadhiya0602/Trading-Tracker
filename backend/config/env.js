"use strict";

const { envFlag } = require("../core/utils");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);

const DERIVATIVES_ENABLED = envFlag(process.env.DERIVATIVES_ENABLED);
const DERIVATIVES_FUTURES_ENABLED = envFlag(
  process.env.DERIVATIVES_FUTURES_ENABLED,
);
const DERIVATIVES_STOCK_OPTIONS_ENABLED = envFlag(
  process.env.DERIVATIVES_STOCK_OPTIONS_ENABLED,
);
const DERIVATIVES_COMMODITY_ENABLED = envFlag(
  process.env.DERIVATIVES_COMMODITY_ENABLED,
);
const DERIVATIVES_ALLOW_CLOSED_REVIEW = envFlag(
  process.env.DERIVATIVES_ALLOW_CLOSED_REVIEW,
);
const STREAM_WS = envFlag(process.env.STREAM_WS);
const NO_TICK = envFlag(process.env.ALERTS_NO_TICK);
const MARKET_CAPTURE = envFlag(process.env.MARKET_CAPTURE);

const SESSION_TTL = 600_000;
const STALE_MAX_MS = 15_000;
const SLOW_REFRESH_MS = 15_000;
const FANOUT_MIN_MS = 150;
const STORE_REFRESH_MS =
  Math.max(1, Number(process.env.STORE_REFRESH_SECONDS) || 3) * 1000;
const ALERT_POLL_MS =
  Math.max(2, Number(process.env.ALERT_POLL_SECONDS) || 5) * 1000;

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];

module.exports = {
  HOST,
  PORT,
  DERIVATIVES_ENABLED,
  DERIVATIVES_FUTURES_ENABLED,
  DERIVATIVES_STOCK_OPTIONS_ENABLED,
  DERIVATIVES_COMMODITY_ENABLED,
  DERIVATIVES_ALLOW_CLOSED_REVIEW,
  STREAM_WS,
  NO_TICK,
  MARKET_CAPTURE,
  SESSION_TTL,
  STALE_MAX_MS,
  SLOW_REFRESH_MS,
  FANOUT_MIN_MS,
  STORE_REFRESH_MS,
  ALERT_POLL_MS,
  USER_AGENTS,
};
