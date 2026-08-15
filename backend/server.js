#!/usr/bin/env node
/**
 * Trading Tracker - market proxy, application APIs, and static server.
 *
 * Feed transport uses the Node 24 LTS built-in fetch. Data-source endpoints
 * come from the FEED_JSON environment variable and are never hardcoded here.
 */
"use strict";

const http = require("http");
const path = require("path");
const alerts = require("./services/alerts");
const auth = require("./services/auth");
const stream = require("./market/stream");
const telegram = require("./services/telegram");
const llm = require("./services/llm");
const trades = require("./services/trades");
const store = require("./core/market-store");
const { createNseDerivatives } = require("./derivatives/nse-derivatives");
const {
  DerivativesError,
  DerivativesService,
} = require("./derivatives/derivatives");
const {
  DerivativesOptionStream,
} = require("./derivatives/derivatives-stream");
const { logInfo, logWarn } = require("./core/logger");
const { istNow } = require("./core/utils");
const config = require("./config/env");
const feedConfig = require("./config/feed");
const { createNseSession } = require("./net/nse-session");
const {
  istTradingDate,
  marketState,
  nextDerivativeOpenDelayMs,
} = require("./market/market-state");
const { createMarketFeed } = require("./market/feed");
const { createMarketCapture } = require("./market/capture");
const { createMarketLive } = require("./market/live");
const { createRespond } = require("./http/respond");
const { createSse } = require("./http/sse");
const createRouter = require("./http/router");
const {
  ACTION,
  authorize,
  eligibleAlertCreators,
  resolveAlertCreator,
} = require("./services/alert-policy");

function createDerivativesRuntime({ nseSession, sse }) {
  if (!config.DERIVATIVES_ENABLED) return null;
  if (!feedConfig.FEED || !feedConfig.FEED.derivatives) {
    throw new Error(
      "derivatives are enabled but FEED_JSON.derivatives is missing (see .env.sample)",
    );
  }
  const provider = createNseDerivatives({
    base: feedConfig.BASE,
    config: feedConfig.FEED.derivatives,
    fetchResponse: nseSession.derivativeResponse,
  });
  const optionStream = feedConfig.FEED.derivatives.stream
    ? new DerivativesOptionStream({
        config: feedConfig.FEED.derivatives.stream,
        userAgent: config.USER_AGENTS[0],
        log: (message) => console.log(`  ${message}`),
      })
    : null;
  return new DerivativesService({
    provider,
    store,
    optionStream,
    streamEnabled: config.STREAM_WS && !!optionStream,
    isMarketOpen: () => marketState() === "open",
    nextOpenDelayMs: () => nextDerivativeOpenDelayMs(),
    tradingDate: () => istTradingDate(),
    sourceStatus: () => nseSession.sourceTraffic.status(),
    onUpdate: (snapshot, type) =>
      sse.scheduleDerivativeFanout(snapshot.key, type),
    config: {
      refreshMs:
        Math.max(3, Number(process.env.DERIVATIVES_POLL_SECONDS) || 5) * 1000,
      graceMs:
        Math.max(
          0,
          Number(process.env.DERIVATIVES_IDLE_GRACE_SECONDS) || 60,
        ) * 1000,
      chainBudget: Math.max(
        1,
        Number(process.env.DERIVATIVES_REQUEST_BUDGET_PER_MINUTE) || 24,
      ),
      metadataBudget: Math.max(
        2,
        Number(process.env.DERIVATIVES_METADATA_BUDGET_PER_MINUTE) || 12,
      ),
      maxActiveKeys: 24,
      maxCalls: 2,
      allowClosedReview: config.DERIVATIVES_ALLOW_CLOSED_REVIEW,
      futuresEnabled: config.DERIVATIVES_FUTURES_ENABLED,
      stockOptionsEnabled: config.DERIVATIVES_STOCK_OPTIONS_ENABLED,
      commodityEnabled: config.DERIVATIVES_COMMODITY_ENABLED,
    },
  });
}

async function main() {
  console.log(
    "\n  Trading Tracker - NSE market dashboard and journal (Node)",
  );
  console.log(
    feedConfig.FEED
      ? "  Data source: configured from FEED_JSON"
      : "  Data source: NOT configured - set FEED_JSON (see .env.sample)",
  );

  const nseSession = createNseSession({
    base: feedConfig.BASE,
    referer: feedConfig.FEED_REF,
    userAgents: config.USER_AGENTS,
    warmupPaths: feedConfig.FEED && feedConfig.FEED.warmupPaths,
    sessionTtl: config.SESSION_TTL,
    log: { logInfo, logWarn },
    requireFeed: feedConfig.requireFeed,
    DerivativesError,
  });
  const sse = createSse({
    derivativesEnabled: config.DERIVATIVES_ENABLED,
    fanoutMinMs: config.FANOUT_MIN_MS,
    marketState,
    store,
    streamWs: config.STREAM_WS,
  });
  const respond = createRespond({
    alerts,
    authorize,
    DerivativesError,
    host: config.HOST,
  });
  const marketFeed = createMarketFeed({
    alerts,
    base: feedConfig.BASE,
    feedConfig: feedConfig.FEED,
    indexUrl: feedConfig.INDEX_URL,
    marketState,
    num: respond.num,
    requireFeed: feedConfig.requireFeed,
    srcJson: nseSession.srcJson,
    store,
  });
  const capture = createMarketCapture({
    base: feedConfig.BASE,
    captureDir: path.join(__dirname, "..", "logs"),
    feedConfig: feedConfig.FEED,
    indexUrl: feedConfig.INDEX_URL,
    istNow,
    logInfo,
    logWarn,
    marketState,
    marketStatusStr: marketFeed.marketStatusStr,
    srcJson: nseSession.srcJson,
  });
  const live = createMarketLive({
    alertPollMs: config.ALERT_POLL_MS,
    alerts,
    fetchAllIndices: marketFeed.fetchAllIndices,
    fetchMarketData: marketFeed.fetchMarketData,
    llm,
    marketState,
    noTick: config.NO_TICK,
    scheduleFanout: sse.scheduleFanout,
    store,
    storeRefreshMs: config.STORE_REFRESH_MS,
    streamWs: config.STREAM_WS,
  });
  const derivativesService = createDerivativesRuntime({ nseSession, sse });
  console.log(
    derivativesService
      ? `  Derivatives: enabled · futures: ${config.DERIVATIVES_FUTURES_ENABLED ? "on" : "off"} · stock options: ${config.DERIVATIVES_STOCK_OPTIONS_ENABLED ? "on" : "off"} · commodity: ${config.DERIVATIVES_COMMODITY_ENABLED ? "on" : "off"} · closed-hours review: ${config.DERIVATIVES_ALLOW_CLOSED_REVIEW ? "on" : "off"} (idle until demand)`
      : "  Derivatives: disabled",
  );

  const ctx = {
    ACTION,
    DerivativesError,
    alerts,
    auth,
    config,
    derivativesService,
    eligibleAlertCreators,
    feed: marketFeed,
    frontendDir: path.join(__dirname, "..", "frontend"),
    live,
    llm,
    marketState,
    respond,
    resolveAlertCreator,
    sse,
    store,
    telegram,
    trades,
  };
  const server = http.createServer(createRouter(ctx));
  server.on("close", () => {
    sse.close();
    if (derivativesService) derivativesService.close();
    nseSession.sourceTraffic.close();
  });

  await auth.load();
  console.log(
    `  Auth: ${auth.listUsers().length} user(s) · store: ${auth.backendName()}` +
      ` · password pepper: ${auth.passwordPepperConfigured() ? "configured" : "NOT configured"}` +
      (auth.needsSetup()
        ? " · NEEDS SETUP (create admin on first open)"
        : ""),
  );
  const [, , telegramBackend] = await Promise.all([
    alerts.load({
      users: auth.listUsers(),
      usersProvider: () => auth.listUsers(),
    }),
    trades.load(),
    telegram.load({
      auth,
      logError: alerts.logError,
      isMarketOpen: () => {
        const state = marketState();
        return state === "open" || state === "pre-open";
      },
      onUserChange: (userId) => {
        sse.broadcastState({ kind: "telegram", userId });
        sse.broadcastState({ kind: "users" });
      },
    }),
  ]);
  alerts.setEventSink((event) => telegram.enqueue(event));
  alerts.setChangeSink((change) => sse.broadcastState(change));
  console.log(
    `  Alerts: ${alerts.list().length} saved · store: ${alerts.backendName()} · eval every ${config.ALERT_POLL_MS / 1000}s in market hours`,
  );
  console.log(
    `  Trades: ${trades.list().length} saved · store: ${trades.backendName()}`,
  );
  console.log(
    `  Telegram: ${telegram.configured() ? `configured · store: ${telegramBackend}` : "not configured (in-page only)"}`,
  );
  llm.load({ logError: alerts.logError });
  console.log(`  LLM: ${llm.configured() ? "configured" : "not configured"}`);
  const streamCfg = feedConfig.requireStream();
  console.log(
    config.STREAM_WS
      ? `  Live WS feed: STREAM_WS on · ${streamCfg ? "feed.stream configured" : "feed.stream NOT configured - pure-REST fallback"} · SSE ${streamCfg ? "available at /api/stream" : "disabled (404)"}`
      : "  Live WS feed: STREAM_WS off - pure REST (today's behaviour), /api/stream disabled (404)",
  );

  void (async () => {
    console.log("  Self-test: fetching indices from the data source ...");
    try {
      const payload = await marketFeed.fetchAllIndices();
      store.ingestSnapshot(payload);
      alerts.updateSymbols(payload);
      for (const key of marketFeed.dashboardIndices) {
        const count = (payload[key].data || []).length;
        const level = payload[key].level;
        if (level && level.last != null) {
          console.log(
            `  [${key}] level ${level.last} (${level.variation >= 0 ? "+" : ""}${level.variation}, ${level.pChange >= 0 ? "+" : ""}${level.pChange}%)`,
          );
        }
        if (count > 0) {
          const row = payload[key].data[0];
          console.log(
            `  OK [${key}] - got ${count} constituents (stamp: ${payload[key].timestamp})`,
          );
          console.log(
            `    sample: ${row.symbol} open=${row.open} high=${row.dayHigh} low=${row.dayLow} ltp=${row.lastPrice} pChg=${row.pChange}%`,
          );
          const noOpen = payload[key].data.filter(
            (entry) => entry.open == null,
          ).length;
          if (noOpen)
            console.log(
              `    note: ${noOpen}/${count} rows missing open (pre-open not merged) - O→High/Low show - for those.`,
            );
        } else {
          console.log(
            `  OK [${key}] - data source reachable, but constituents list is EMPTY (market closed).`,
          );
        }
      }
      console.log(
        "  Live data flows Mon–Fri 09:15–15:30 IST; the dashboard fills automatically then.",
      );
    } catch (error) {
      console.log(`  WARNING - fetch failed: ${(error && error.message) || error}`);
      console.log(
        "  If HTTP 401/403, the data source's anti-bot blocked this network (VPN/datacentre).",
      );
    }
  })();

  server.listen(config.PORT, config.HOST, () => {
    logInfo(
      "server",
      `serving on http://${config.HOST}:${config.PORT}/ (stream ${config.STREAM_WS ? "on" : "off"})`,
    );
    console.log("  Open that URL in your browser. Ctrl-C to stop.\n");
    if (config.NO_TICK)
      console.log(
        "  ALERTS_NO_TICK set - alert engine PAUSED (read-only, no fires).\n",
      );
    else live.startAlertTickLoop();
    live.startStoreUpdater();
    if (config.MARKET_CAPTURE) {
      console.log(
        "  Market capture: ON - transitions + raw samples -> logs/market-capture-<date>.jsonl",
      );
      capture.captureTick().catch(() => {});
      const captureTimer = setInterval(
        () => capture.captureTick().catch(() => {}),
        30_000,
      );
      if (captureTimer.unref) captureTimer.unref();
    }
    if (config.STREAM_WS && streamCfg) {
      stream.start({
        feed: feedConfig.FEED,
        onTick: (tick) => {
          live.applyTick(tick);
          sse.scheduleFanout();
        },
        isOpen: () => marketState() === "open",
        log: (message) => console.log(`  ${message}`),
        userAgent: config.USER_AGENTS[0],
      });
      setInterval(live.reseedLiveCache, config.SLOW_REFRESH_MS);
      setInterval(() => {
        for (const client of sse.sseClients) sse.sseWrite(client, ":\n\n");
      }, 15_000);
    }
    setInterval(() => {
      for (const client of sse.stateSseClients)
        sse.stateSseWrite(client, ":\n\n");
    }, 15_000);
  });
}

main();
