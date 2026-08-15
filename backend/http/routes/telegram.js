"use strict";

module.exports = function createTelegramHandler(ctx) {
  const { auth, respond, sse, telegram } = ctx;
  const { getToken, readJson, sendJson } = respond;

  return async function handleTelegramApi(req, res, url, method, user) {
    if (url === "/api/telegram/status" && method === "GET") {
      const liveUser = auth.sessionUser(getToken(req)) || user;
      sendJson(res, 200, {
        telegram: liveUser.telegram,
        config: telegram.publicConfig(),
        deliveries: telegram.deliveryStatus(user.id),
      });
      return true;
    }
    if (url === "/api/telegram/link-code" && method === "POST") {
      if (!telegram.configured()) {
        sendJson(res, 503, { error: "Telegram bot is not configured" });
        return true;
      }
      const result = auth.createTelegramLinkCode(user.id);
      sendJson(res, result.error ? 400 : 201, result);
      return true;
    }
    if (url === "/api/telegram/link" && method === "DELETE") {
      const result = auth.unlinkTelegram(user.id);
      if (!result.error)
        sse.broadcastState({ kind: "telegram", userId: user.id });
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    if (url === "/api/telegram/enabled" && method === "POST") {
      const body = await readJson(req);
      const result = auth.setTelegramEnabled(user.id, body.enabled);
      if (!result.error)
        sse.broadcastState({ kind: "telegram", userId: user.id });
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    return false;
  };
};
