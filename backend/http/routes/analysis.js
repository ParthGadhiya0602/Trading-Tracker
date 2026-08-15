"use strict";

module.exports = function createAnalysisHandler(ctx) {
  const { ACTION, config, live, llm, respond } = ctx;
  const { permit, sendJson } = respond;

  return async function handleAnalysisApi(req, res, url, method, user) {
    if (url === "/api/analysis" && method === "GET") {
      if (!llm.configured()) {
        sendJson(res, 200, { status: "unavailable" });
        return true;
      }
      const query = new URL(req.url, `http://${config.HOST}`);
      const symbol = (query.searchParams.get("symbol") || "")
        .toUpperCase()
        .trim();
      if (!symbol) {
        sendJson(res, 400, { error: "symbol parameter required" });
        return true;
      }
      const analysis = llm.getAnalysis(symbol);
      if (analysis) {
        sendJson(res, 200, {
          status: "ready",
          date: llm.cacheDate(),
          analysis,
        });
      } else {
        const status = llm.getStatus();
        sendJson(res, 200, {
          status: status === "ready" ? "pending" : status,
          date: llm.cacheDate(),
          error: status === "error" ? llm.lastErrorMessage() : undefined,
        });
      }
      return true;
    }
    if (url === "/api/analysis/refresh" && method === "POST") {
      if (!permit(res, user, ACTION.CREATE)) return true;
      if (!llm.configured()) {
        sendJson(res, 200, { status: "unavailable" });
        return true;
      }
      llm.clearCache();
      const payload = await live.getMarketData();
      llm.analyze(payload).catch(() => {});
      sendJson(res, 200, { status: "queued" });
      return true;
    }
    return false;
  };
};
