"use strict";

module.exports = function createTradesHandler(ctx) {
  const { ACTION, config, respond, trades } = ctx;
  const { permit, readJson, sendJson } = respond;

  return async function handleTradesApi(req, res, url, method, user) {
    if (url === "/api/trades/summary" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      sendJson(res, 200, {
        summary: trades.summary({
          tradeType: query.searchParams.get("tradeType") || undefined,
          from: query.searchParams.get("from") || undefined,
          to: query.searchParams.get("to") || undefined,
        }),
      });
      return true;
    }
    if (url === "/api/trades" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      sendJson(res, 200, {
        trades: trades.list({
          tradeType: query.searchParams.get("tradeType") || undefined,
          status: query.searchParams.get("status") || undefined,
          symbol: query.searchParams.get("symbol") || undefined,
          side: query.searchParams.get("side") || undefined,
          from: query.searchParams.get("from") || undefined,
          to: query.searchParams.get("to") || undefined,
          strategy: query.searchParams.get("strategy") || undefined,
        }),
      });
      return true;
    }
    if (url === "/api/trades" && method === "POST") {
      if (!permit(res, user, ACTION.CREATE)) return true;
      const body = await readJson(req);
      const result = trades.create(body, user);
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 201, { trade: result.trade });
      return true;
    }
    const detail = url.match(/^\/api\/trades\/([^/]+)$/);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      if (method === "GET") {
        const trade = trades.get(id);
        sendJson(
          res,
          trade ? 200 : 404,
          trade ? { trade } : { error: "not found" },
        );
        return true;
      }
      if (method === "PATCH") {
        const existing = trades.find(id);
        if (!existing) {
          sendJson(res, 404, { error: "not found" });
          return true;
        }
        if (!permit(res, user, ACTION.EDIT, existing)) return true;
        const body = await readJson(req);
        const result = trades.update(id, body, user);
        if (result.error)
          sendJson(res, result.status || 400, { error: result.error });
        else sendJson(res, 200, { trade: result.trade });
        return true;
      }
      if (method === "DELETE") {
        const existing = trades.find(id);
        if (!existing) {
          sendJson(res, 404, { error: "not found" });
          return true;
        }
        if (!permit(res, user, ACTION.DELETE, existing)) return true;
        const result = trades.remove(id);
        if (result.error)
          sendJson(res, result.status || 400, { error: result.error });
        else sendJson(res, 200, { ok: true });
        return true;
      }
    }
    return false;
  };
};
