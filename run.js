#!/usr/bin/env node
"use strict";
/**
 * Cross-platform launcher (Mac / Windows / Linux). Shell env-var syntax
 * (VAR=1 node ...) differs per OS; this reads flags and sets process.env
 * BEFORE loading the server, so the same command works everywhere.
 *
 *   node run.js                      # normal run
 *   node run.js --stream             # live WS feed (STREAM_WS)
 *   node run.js --capture            # market-status capture (MARKET_CAPTURE)
 *   node run.js --no-tick            # pause alert engine (ALERTS_NO_TICK)
 *   node run.js --no-telegram        # disable Telegram polling (TELEGRAM_DISABLED)
 *   node run.js --port=9000          # override PORT
 *   node run.js --stream --capture --port=9000   # combine freely
 *
 * npm equivalents: `npm start`, `npm run live`, `npm run stream`, `npm run capture`.
 */
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const val = (name) => {
  const hit = args.find((a) => a.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : null;
};

if (has("--stream")) process.env.STREAM_WS = "1";
if (has("--capture")) process.env.MARKET_CAPTURE = "1";
if (has("--no-tick")) process.env.ALERTS_NO_TICK = "1";
if (has("--no-telegram")) process.env.TELEGRAM_DISABLED = "1";
const port = val("--port");
if (port) process.env.PORT = port;

require("./backend/server.js");
