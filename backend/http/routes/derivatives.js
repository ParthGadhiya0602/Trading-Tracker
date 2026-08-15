"use strict";

module.exports = function createDerivativesHandler(ctx) {
  const {
    DerivativesError,
    config,
    derivativesService,
    respond,
    sse,
    store,
  } = ctx;
  const {
    derivativeErrorResponse,
    derivativeExpiryIsValid,
    derivativeQuery,
    sendJson,
  } = respond;

  return async function handleDerivativesApi(req, res, url, method) {
    let requestClosed = false;
    if (!config.DERIVATIVES_ENABLED) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    if (!derivativesService) {
      sendJson(res, 503, { error: "derivatives service unavailable" });
      return true;
    }
    if (url.includes("futures") && !config.DERIVATIVES_FUTURES_ENABLED) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    if (
      url.includes("/equities") &&
      !config.DERIVATIVES_STOCK_OPTIONS_ENABLED
    ) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    try {
      if (url === "/api/derivatives/equities" && method === "GET") {
        if (new URL(req.url, `http://${config.HOST}`).search)
          throw new DerivativesError(
            "INVALID_QUERY",
            "equities accepts no query parameters",
          );
        sendJson(res, 200, await derivativesService.getEquitySymbols());
        return true;
      }
      if (
        (url === "/api/derivatives/analysis" ||
          url === "/api/derivatives/equities/analysis") &&
        method === "GET"
      ) {
        const market = url.includes("/equities/") ? "equity" : "index";
        const { symbol, expiry } = derivativeQuery(
          req,
          ["symbol", "expiry"],
          market,
        );
        sendJson(
          res,
          200,
          derivativesService.getAnalysis({ market, symbol, expiry }),
        );
        return true;
      }
      if (
        (url === "/api/derivatives/contracts" ||
          url === "/api/derivatives/equities/contracts") &&
        method === "GET"
      ) {
        const market = url.includes("/equities/") ? "equity" : "index";
        const { symbol } = derivativeQuery(req, ["symbol"], market);
        sendJson(
          res,
          200,
          await derivativesService.getContracts({ market, symbol }),
        );
        return true;
      }
      if (
        (url === "/api/derivatives/options" ||
          url === "/api/derivatives/equities/options") &&
        method === "GET"
      ) {
        const market = url.includes("/equities/") ? "equity" : "index";
        const { symbol, expiry } = derivativeQuery(
          req,
          ["symbol", "expiry"],
          market,
        );
        const snapshot = store.derivatives.getSnapshot(
          `${market}:${symbol}:${expiry}`,
        );
        if (!snapshot)
          sendJson(res, 404, { error: "option chain snapshot unavailable" });
        else sendJson(res, 200, snapshot);
        return true;
      }
      if (url === "/api/derivatives/futures" && method === "GET") {
        const { symbol } = derivativeQuery(req, ["symbol"]);
        const snapshot = store.derivatives.getSnapshot(
          `future:index:${symbol}`,
        );
        if (!snapshot)
          sendJson(res, 404, {
            error: "index futures snapshot unavailable",
          });
        else sendJson(res, 200, snapshot);
        return true;
      }
      if (url === "/api/derivatives/stock-futures" && method === "GET") {
        if (new URL(req.url, `http://${config.HOST}`).search)
          throw new DerivativesError(
            "INVALID_QUERY",
            "stock-futures accepts no query parameters",
          );
        const snapshot = store.derivatives.getSnapshot("future:stock:watch");
        if (!snapshot)
          sendJson(res, 404, {
            error: "stock futures snapshot unavailable",
          });
        else sendJson(res, 200, snapshot);
        return true;
      }
      if (url === "/api/derivatives/status" && method === "GET") {
        if (new URL(req.url, `http://${config.HOST}`).search)
          throw new DerivativesError(
            "INVALID_QUERY",
            "status accepts no query parameters",
          );
        sendJson(res, 200, derivativesService.getStatus());
        return true;
      }
      if (
        (url === "/api/derivatives/stream" ||
          url === "/api/derivatives/equities/stream" ||
          url === "/api/derivatives/futures/stream" ||
          url === "/api/derivatives/stock-futures/stream") &&
        method === "GET"
      ) {
        const isStockFutures =
          url === "/api/derivatives/stock-futures/stream";
        const isFutures = url === "/api/derivatives/futures/stream";
        const market = isStockFutures
          ? "stock"
          : url === "/api/derivatives/equities/stream"
            ? "equity"
            : "index";
        const { symbol, expiry } = derivativeQuery(
          req,
          isStockFutures
            ? []
            : isFutures
              ? ["symbol"]
              : ["symbol", "expiry"],
          market,
        );
        let streamClosed = false;
        let demand = null;
        let key = null;
        let client = null;
        let clientRegistered = false;
        let streamStarted = false;
        const closeStream = () => {
          requestClosed = true;
          streamClosed = true;
          if (clientRegistered && client && key)
            sse.removeDerivativeClient(key, client);
          else if (demand) demand.release();
        };
        req.once("close", closeStream);
        if (!isFutures && !isStockFutures) {
          const contracts = await derivativesService.getContracts({
            market,
            symbol,
          });
          if (
            streamClosed ||
            req.destroyed ||
            res.destroyed ||
            res.writableEnded
          )
            return true;
          if (!derivativeExpiryIsValid(contracts, expiry)) {
            throw new DerivativesError(
              "INVALID_QUERY",
              "expiry is not available for this symbol",
            );
          }
        }
        demand = isStockFutures
          ? derivativesService.addStockFuturesDemand()
          : isFutures
            ? derivativesService.addFuturesDemand({
                market: "index",
                symbol,
              })
            : derivativesService.addDemand({ market, symbol, expiry });
        key = demand.key;
        if (
          streamClosed ||
          req.destroyed ||
          res.destroyed ||
          res.writableEnded
        ) {
          demand.release();
          return true;
        }
        try {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          streamStarted = true;
          res.write("retry: 3000\n\n");
          client = { res, release: demand.release, heartbeat: null };
          const clients = sse.derivativeSseClients.get(key) || new Set();
          clients.add(client);
          sse.derivativeSseClients.set(key, clients);
          clientRegistered = true;
          if (
            streamClosed ||
            req.destroyed ||
            res.destroyed ||
            res.writableEnded
          ) {
            sse.removeDerivativeClient(key, client);
            return true;
          }
          const current = store.derivatives.getSnapshot(key);
          if (
            !current ||
            !sse.derivativeSseWrite(
              client,
              sse.derivativeEvent(current, "snapshot"),
            )
          ) {
            sse.removeDerivativeClient(key, client);
            return true;
          }
          client.heartbeat = setInterval(() => {
            if (!sse.derivativeSseWrite(client, ": heartbeat\n\n"))
              sse.removeDerivativeClient(key, client);
          }, 15_000);
          client.heartbeat.unref?.();
        } catch (error) {
          if (clientRegistered && client)
            sse.removeDerivativeClient(key, client);
          else if (demand) demand.release();
          if (
            streamStarted ||
            streamClosed ||
            req.destroyed ||
            res.destroyed ||
            res.writableEnded
          ) {
            if (streamStarted && !res.destroyed && !res.writableEnded) {
              try {
                res.end();
              } catch (_) {}
            }
            return true;
          }
          throw error;
        }
        return true;
      }
    } catch (error) {
      if (
        requestClosed ||
        req.destroyed ||
        res.destroyed ||
        res.writableEnded
      )
        return true;
      derivativeErrorResponse(res, error);
      return true;
    }
    return false;
  };
};
