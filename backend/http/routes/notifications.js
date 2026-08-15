"use strict";

module.exports = function createNotificationsHandler(ctx) {
  const { alerts, respond } = ctx;
  const { readJson, sendJson } = respond;

  return async function handleNotificationsApi(req, res, url, method, user) {
    if (url === "/api/notifications" && method === "GET") {
      sendJson(res, 200, {
        notifications: alerts.listNotifications(user.id),
      });
      return true;
    }
    const match = url.match(
      /^\/api\/notifications\/([^/]+)\/(read|dismiss|snooze)$/,
    );
    if (!match || method !== "POST") return false;
    const eventId = decodeURIComponent(match[1]);
    const action = match[2];
    const body = await readJson(req);
    const result = alerts.updateNotification(user.id, eventId, action, body);
    if (result.error)
      sendJson(res, result.error === "not found" ? 404 : 400, {
        error: result.error,
      });
    else sendJson(res, 200, { ...result, syncStatus: alerts.syncStatus() });
    return true;
  };
};
