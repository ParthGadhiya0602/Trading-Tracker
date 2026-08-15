"use strict";

module.exports = function createUsersHandler(ctx) {
  const { auth, respond, sse, telegram } = ctx;
  const { readJson, sendJson } = respond;

  return async function handleUsersApi(req, res, url, method, actor) {
    if (url === "/api/users" && method === "GET") {
      sendJson(res, 200, { users: auth.listUsers() });
      return true;
    }
    if (url === "/api/users" && method === "POST") {
      const result = auth.createUser(await readJson(req), actor.id);
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 201, { user: result.user });
      return true;
    }
    const telegramMatch = url.match(
      /^\/api\/users\/([^/]+)\/telegram\/(link-code|link)$/,
    );
    if (telegramMatch) {
      const id = decodeURIComponent(telegramMatch[1]);
      const action = telegramMatch[2];
      if (action === "link-code" && method === "POST") {
        if (!telegram.configured()) {
          sendJson(res, 503, { error: "Telegram bot is not configured" });
          return true;
        }
        const result = auth.createTelegramLinkCode(id);
        sendJson(
          res,
          result.error ? (result.error === "not found" ? 404 : 400) : 201,
          {
            ...result,
            botUsername: telegram.publicConfig().botUsername,
          },
        );
        return true;
      }
      if (action === "link" && method === "DELETE") {
        const result = auth.unlinkTelegram(id);
        if (!result.error) {
          sse.broadcastState({ kind: "telegram", userId: id });
          sse.broadcastState({ kind: "users" });
        }
        sendJson(
          res,
          result.error ? (result.error === "not found" ? 404 : 400) : 200,
          result,
        );
        return true;
      }
    }
    const match = url.match(/^\/api\/users\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (method === "PATCH") {
        const result = auth.updateUser(id, await readJson(req));
        sendJson(
          res,
          result.error ? (result.error === "not found" ? 404 : 400) : 200,
          result,
        );
        return true;
      }
      if (method === "DELETE") {
        const result = auth.deleteUser(id);
        sendJson(
          res,
          result.error ? (result.error === "not found" ? 404 : 400) : 200,
          result,
        );
        return true;
      }
    }
    return false;
  };
};
