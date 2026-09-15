"use strict";

module.exports = function createAlertsHandler(ctx) {
  const {
    ACTION,
    alerts,
    alertPriceResolver,
    auth,
    config,
    derivativesService,
    eligibleAlertCreators,
    resolveAlertCreator,
    respond,
    store,
  } = ctx;
  const { finishAlert, num, permit, readJson, sendJson } = respond;

  function priceFor(input) {
    const quote = alertPriceResolver.resolveInput(input);
    return Number.isFinite(quote.lastPrice) ? quote.lastPrice : null;
  }

  function validateDerivativeContract(input) {
    const market = String(input.market || "cash");
    if (market === "cash") return null;
    if (!derivativesService) return "derivatives are unavailable";
    if (["stock-future", "index-future"].includes(market) && !config.DERIVATIVES_FUTURES_ENABLED)
      return "futures are unavailable";
    if (market === "stock-option" && !config.DERIVATIVES_STOCK_OPTIONS_ENABLED)
      return "stock options are unavailable";
    const quote = alertPriceResolver.resolveInput(input);
    if (["stock-future", "index-future"].includes(market))
      return quote.row ? null : "selected futures contract is unavailable";
    return quote.leg ? null : "selected option contract is unavailable";
  }

  async function loadContractChoices(input) {
    const market = String(input.market || "");
    const symbol = String(input.symbol || "").trim().toUpperCase();
    const expiry = String(input.expiry || "").trim();
    if (!derivativesService) throw new Error("derivatives are unavailable");
    if (!symbol) throw new Error("select a symbol first");
    const isFuture = ["index-future", "stock-future"].includes(market);
    const isOption = ["index-option", "stock-option"].includes(market);
    if (!isFuture && !isOption) throw new Error("invalid instrument");
    if (isFuture && !config.DERIVATIVES_FUTURES_ENABLED)
      throw new Error("futures are unavailable");
    if (market === "stock-option" && !config.DERIVATIVES_STOCK_OPTIONS_ENABLED)
      throw new Error("stock options are unavailable");

    if (isOption && !expiry) {
      const contracts = await derivativesService.getContracts({
        market: market === "index-option" ? "index" : "equity",
        symbol,
      });
      return { kind: "option-expiries", symbol, expiries: contracts.expiries || [] };
    }

    let demand;
    if (market === "index-future")
      demand = derivativesService.addFuturesDemand({ market: "index", symbol });
    else if (market === "stock-future")
      demand = derivativesService.addStockFuturesDemand({ symbol });
    else
      demand = derivativesService.addDemand({
        market: market === "index-option" ? "index" : "equity",
        symbol,
        expiry,
      });
    try {
      const snapshot = (await derivativesService.refresh(demand.key)) ||
        store.derivatives.getSnapshot(demand.key);
      const rows = snapshot && snapshot.data && Array.isArray(snapshot.data.rows)
        ? snapshot.data.rows
        : [];
      if (isFuture) {
        return {
          kind: "futures",
          symbol,
          contracts: rows.map((row) => ({
            expiry: row.expiry,
            lastPrice: Number(row.lastPrice) || null,
          })).filter((row) => row.expiry),
        };
      }
      return {
        kind: "option-chain",
        symbol,
        expiry,
        underlyingValue: Number(snapshot && snapshot.data && snapshot.data.underlyingValue) || null,
        contracts: rows.map((row) => ({
          strike: Number(row.strike),
          callPrice: row.call && Number(row.call.lastPrice),
          putPrice: row.put && Number(row.put.lastPrice),
        })).filter((row) => Number.isFinite(row.strike)),
      };
    } finally {
      demand.release();
    }
  }

  return async function handleAlertsApi(req, res, url, method, user) {
    if (url === "/api/alert-creators" && method === "GET") {
      if (!permit(res, user, ACTION.CREATE)) return true;
      sendJson(res, 200, {
        users: eligibleAlertCreators(auth.listUsers()),
      });
      return true;
    }
    if (url === "/api/symbols" && method === "GET") {
      sendJson(res, 200, alerts.symbols());
      return true;
    }
    if (url === "/api/alert-config" && method === "GET") {
      sendJson(res, 200, {
        ...alerts.config(),
        instruments: {
          indexFuture: Boolean(derivativesService && config.DERIVATIVES_FUTURES_ENABLED),
          stockFuture: Boolean(derivativesService && config.DERIVATIVES_FUTURES_ENABLED),
          indexOption: Boolean(derivativesService),
          stockOption: Boolean(derivativesService && config.DERIVATIVES_STOCK_OPTIONS_ENABLED),
        },
      });
      return true;
    }
    if (url === "/api/alert-contracts" && method === "GET") {
      if (!permit(res, user, ACTION.CREATE)) return true;
      const query = new URL(req.url, `http://${config.HOST}`).searchParams;
      const market = query.get("market") || "";
      const symbol = query.get("symbol") || "";
      const expiry = query.get("expiry") || "";
      if ([...query.keys()].some((key) =>
        !["market", "symbol", "expiry"].includes(key) || query.getAll(key).length !== 1,
      )) {
        sendJson(res, 400, { error: "invalid contract query" });
        return true;
      }
      try {
        sendJson(res, 200, await loadContractChoices({ market, symbol, expiry }));
      } catch (error) {
        sendJson(res, 400, { error: (error && error.message) || "contract lookup failed" });
      }
      return true;
    }
    if (url === "/api/price" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      const symbol = (query.searchParams.get("symbol") || "").toUpperCase();
      const market = query.searchParams.get("market") || "cash";
      const contractExpiry = query.searchParams.get("contractExpiry") || "";
      const strike = query.searchParams.get("strike") || "";
      const optionType = query.searchParams.get("optionType") || "";
      sendJson(res, 200, {
        symbol,
        price: priceFor({ market, symbol, contractExpiry, strike, optionType }),
      });
      return true;
    }
    if (url === "/api/alerts/active" && method === "GET") {
      sendJson(res, 200, {
        alerts: alertPriceResolver.enrich(alerts.active(user.id)),
      });
      return true;
    }
    if (url === "/api/alerts/all" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      const index = query.searchParams.get("index") || undefined;
      sendJson(res, 200, {
        alerts: alertPriceResolver.enrich(alerts.list(index)),
        archived: alertPriceResolver.enrich(alerts.listArchived(index)),
      });
      return true;
    }
    if (url === "/api/alerts/archived" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      sendJson(res, 200, {
        alerts: alertPriceResolver.enrich(
          alerts.listArchived(query.searchParams.get("index") || undefined),
        ),
      });
      return true;
    }
    if (url === "/api/alerts" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      sendJson(res, 200, {
        alerts: alertPriceResolver.enrich(
          alerts.list(query.searchParams.get("index") || undefined),
        ),
      });
      return true;
    }
    if (url === "/api/alerts" && method === "POST") {
      if (!permit(res, user, ACTION.CREATE)) return true;
      const body = await readJson(req);
      const creator = resolveAlertCreator(
        auth.listUsers(),
        body.creatorUserId,
        user,
      );
      delete body.creatorUserId;
      if (!creator) {
        sendJson(res, 400, {
          error: "select an enabled editor or admin as creator",
        });
        return true;
      }
      body.zoneCreator = creator.username;
      const formPrice = num(body.formPrice);
      delete body.formPrice;
      const contractError = validateDerivativeContract(body);
      if (contractError) {
        sendJson(res, 400, { error: contractError });
        return true;
      }
      const currentPrice = formPrice > 0 ? formPrice : priceFor(body);
      const result = alerts.create(body, currentPrice, creator, user);
      if (result.error) sendJson(res, 400, { error: result.error });
      else
        sendJson(res, 201, {
          alert: result.alert,
          syncStatus: alerts.syncStatus(),
        });
      return true;
    }
    const eventsMatch = url.match(/^\/api\/alerts\/([^/]+)\/events$/);
    if (eventsMatch && method === "GET") {
      const id = decodeURIComponent(eventsMatch[1]);
      if (!alerts.find(id)) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      sendJson(res, 200, { events: alerts.listEvents(id) });
      return true;
    }
    const detailMatch = url.match(/^\/api\/alerts\/([^/]+)$/);
    if (detailMatch && method === "GET") {
      const alert = alerts.find(decodeURIComponent(detailMatch[1]));
      sendJson(
        res,
        alert ? 200 : 404,
        alert ? { alert } : { error: "not found" },
      );
      return true;
    }
    const match = url.match(
      /^\/api\/alerts\/([^/]+)(?:\/(snooze|close|approve|reject|rearm))?$/,
    );
    if (match) {
      const id = decodeURIComponent(match[1]);
      const action = match[2];
      if (action === "snooze" && method === "POST") {
        const body = await readJson(req);
        finishAlert(res, alerts.snooze(id, user.id, body.minutes));
        return true;
      }
      if (action === "close" && method === "POST") {
        const alert = alerts.find(id);
        if (!alert) {
          finishAlert(res, { error: "not found" });
          return true;
        }
        if (!permit(res, user, ACTION.CLOSE, alert)) return true;
        const body = await readJson(req);
        finishAlert(res, alerts.close(id, user, body.expectedVersion));
        return true;
      }
      if (action === "rearm" && method === "POST") {
        const alert = alerts.find(id);
        if (!alert) {
          finishAlert(res, { error: "not found" });
          return true;
        }
        if (!permit(res, user, ACTION.REARM, alert)) return true;
        const body = await readJson(req);
        const currentPrice = alert ? priceFor(alert) : undefined;
        finishAlert(
          res,
          alerts.rearm(id, currentPrice, user, body.expectedVersion),
        );
        return true;
      }
      if ((action === "approve" || action === "reject") && method === "POST") {
        const alert = alerts.find(id);
        if (!alert) {
          finishAlert(res, { error: "not found" });
          return true;
        }
        if (!permit(res, user, ACTION.REVIEW, alert)) return true;
        const body = await readJson(req);
        finishAlert(
          res,
          alerts.review(
            id,
            action,
            body.reason,
            user,
            body.expectedVersion,
          ),
        );
        return true;
      }
      if (!action && method === "PATCH") {
        const alert = alerts.find(id);
        if (!alert) {
          finishAlert(res, { error: "not found" });
          return true;
        }
        if (!permit(res, user, ACTION.ALERT_EDIT, alert)) return true;
        const body = await readJson(req);
        delete body.zoneCreator;
        delete body.creatorUserId;
        const next = { ...alert, ...body };
        if (
          alert.market !== "cash" &&
          (next.market !== alert.market ||
            next.symbol !== alert.symbol ||
            next.contractExpiry !== alert.contractExpiry ||
            next.strike !== alert.strike ||
            next.optionType !== alert.optionType)
        ) {
          sendJson(res, 400, { error: "derivative contract cannot be changed" });
          return true;
        }
        const formPrice = num(body.formPrice);
        delete body.formPrice;
        const contractError = validateDerivativeContract(next);
        if (contractError) {
          sendJson(res, 400, { error: contractError });
          return true;
        }
        const currentPrice = formPrice > 0 ? formPrice : priceFor(next);
        finishAlert(
          res,
          alerts.update(id, body, currentPrice, user, body.expectedVersion),
        );
        return true;
      }
      if (!action && method === "DELETE") {
        const alert = alerts.find(id);
        if (!alert) {
          finishAlert(res, { error: "not found" });
          return true;
        }
        if (!permit(res, user, ACTION.DELETE, alert)) return true;
        const body = await readJson(req);
        const result = alerts.remove(id, user, body.expectedVersion);
        if (result.error) finishAlert(res, result);
        else
          sendJson(res, 200, {
            ok: true,
            syncStatus: alerts.syncStatus(),
          });
        return true;
      }
    }
    return false;
  };
};
