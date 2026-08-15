"use strict";

const createAlertsHandler = require("./routes/alerts");
const createAnalysisHandler = require("./routes/analysis");
const createAuthHandler = require("./routes/auth");
const createDerivativesHandler = require("./routes/derivatives");
const createNotificationsHandler = require("./routes/notifications");
const createStaticHandler = require("./routes/static");
const createTelegramHandler = require("./routes/telegram");
const createTradesHandler = require("./routes/trades");
const createUsersHandler = require("./routes/users");

module.exports = function createRouter(ctx) {
  const handleAlertsApi = createAlertsHandler(ctx);
  const handleAnalysisApi = createAnalysisHandler(ctx);
  const handleAuthApi = createAuthHandler(ctx);
  const handleDerivativesApi = createDerivativesHandler(ctx);
  const handleNotificationsApi = createNotificationsHandler(ctx);
  const serveStatic = createStaticHandler(ctx);
  const handleTelegramApi = createTelegramHandler(ctx);
  const handleTradesApi = createTradesHandler(ctx);
  const handleUsersApi = createUsersHandler(ctx);
  const { alerts, auth, config, live, respond, sse } = ctx;
  const { getToken, send, sendJson } = respond;

  return async function route(req, res) {
    const url = (req.url || "/").split("?")[0];
    const method = req.method || "GET";
    if (url.startsWith("/api/")) {
      try {
        if (
          method !== "GET" &&
          method !== "HEAD" &&
          req.headers["x-requested-with"] !== "XMLHttpRequest"
        ) {
          sendJson(res, 403, { error: "missing X-Requested-With header" });
          return;
        }
        const token = getToken(req);
        if (await handleAuthApi(req, res, url, method, token)) return;
        if (
          !config.DERIVATIVES_ENABLED &&
          url.startsWith("/api/derivatives")
        ) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const user = auth.sessionUser(token);
        if (!user) {
          sendJson(res, 401, { error: "authentication required" });
          return;
        }
        if (url.startsWith("/api/users")) {
          if (user.role !== "admin") {
            sendJson(res, 403, { error: "admin only" });
            return;
          }
          if (await handleUsersApi(req, res, url, method, user)) return;
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (url.startsWith("/api/notifications")) {
          if (await handleNotificationsApi(req, res, url, method, user)) return;
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (url.startsWith("/api/telegram")) {
          if (await handleTelegramApi(req, res, url, method, user)) return;
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (url.startsWith("/api/derivatives")) {
          if (await handleDerivativesApi(req, res, url, method)) return;
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (url.startsWith("/api/analysis")) {
          if (await handleAnalysisApi(req, res, url, method, user)) return;
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (url === "/api/changes" && method === "GET") {
          const requestUrl = new URL(req.url, `http://${config.HOST}`);
          const since = Math.max(
            0,
            Number(requestUrl.searchParams.get("since")) || 0,
          );
          const stateRevision = sse.getStateRevision();
          const oldestRevision = sse.stateChanges.length
            ? sse.stateChanges[0].revision
            : stateRevision + 1;
          const resetRequired =
            since > stateRevision ||
            (since > 0 && since < oldestRevision - 1);
          const changes = resetRequired
            ? []
            : sse.stateChanges.filter(
                (change) =>
                  change.revision > since &&
                  (!change.userId || change.userId === user.id),
              );
          sendJson(res, 200, {
            revision: stateRevision,
            resetRequired,
            changes,
          });
          return;
        }
        if (url === "/api/events" && method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.write("retry: 3000\n\n");
          res.write(
            `event: state\ndata: ${JSON.stringify({ kind: "ready", revision: sse.getStateRevision(), syncStatus: alerts.syncStatus() })}\n\n`,
          );
          const client = { res, userId: user.id };
          sse.stateSseClients.add(client);
          req.on("close", () => sse.stateSseClients.delete(client));
          return;
        }
        if (url === "/api/sync-status" && method === "GET") {
          sendJson(res, 200, alerts.syncStatus());
          return;
        }
        if (
          url === "/api/symbols" ||
          url === "/api/alert-config" ||
          url === "/api/alert-creators" ||
          url === "/api/price" ||
          url.startsWith("/api/alerts")
        ) {
          if (await handleAlertsApi(req, res, url, method, user)) return;
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (url.startsWith("/api/trades")) {
          if (await handleTradesApi(req, res, url, method, user)) return;
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (url === "/api/indices") {
          const data = await live.getMarketData();
          send(
            res,
            200,
            JSON.stringify(data),
            "application/json; charset=utf-8",
          );
          return;
        }
        if (url === "/api/stream") {
          if (!config.STREAM_WS) {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.write("retry: 3000\n\n");
          res.write(
            `event: snapshot\ndata: ${JSON.stringify(await live.getMarketData())}\n\n`,
          );
          sse.sseClients.add(res);
          req.on("close", () => sse.sseClients.delete(res));
          return;
        }
        sendJson(res, 404, { error: "not found" });
      } catch (error) {
        sendJson(res, 400, {
          error: String((error && error.message) || error),
        });
      }
      return;
    }
    await serveStatic(res, url);
  };
};
