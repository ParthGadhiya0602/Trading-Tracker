"use strict";

module.exports = function createAlertsHandler(ctx) {
  const {
    ACTION,
    alerts,
    auth,
    config,
    eligibleAlertCreators,
    resolveAlertCreator,
    respond,
    store,
  } = ctx;
  const { finishAlert, num, permit, readJson, sendJson } = respond;

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
      sendJson(res, 200, alerts.config());
      return true;
    }
    if (url === "/api/price" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      const symbol = (query.searchParams.get("symbol") || "").toUpperCase();
      sendJson(res, 200, {
        symbol,
        price: store.getPrice(symbol) ?? null,
      });
      return true;
    }
    if (url === "/api/alerts/active" && method === "GET") {
      sendJson(res, 200, {
        alerts: store.enrichAlerts(alerts.active(user.id)),
      });
      return true;
    }
    if (url === "/api/alerts/all" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      const index = query.searchParams.get("index") || undefined;
      sendJson(res, 200, {
        alerts: store.enrichAlerts(alerts.list(index)),
        archived: store.enrichAlerts(alerts.listArchived(index)),
      });
      return true;
    }
    if (url === "/api/alerts/archived" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      sendJson(res, 200, {
        alerts: store.enrichAlerts(
          alerts.listArchived(query.searchParams.get("index") || undefined),
        ),
      });
      return true;
    }
    if (url === "/api/alerts" && method === "GET") {
      const query = new URL(req.url, `http://${config.HOST}`);
      sendJson(res, 200, {
        alerts: store.enrichAlerts(
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
      const currentPrice =
        formPrice > 0
          ? formPrice
          : store.getPrice(String(body.symbol || "").toUpperCase());
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
        const currentPrice = alert
          ? store.getPrice(alert.symbol)
          : undefined;
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
        const formPrice = num(body.formPrice);
        delete body.formPrice;
        const currentPrice =
          formPrice > 0
            ? formPrice
            : store.getPrice(String(body.symbol || "").toUpperCase());
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
