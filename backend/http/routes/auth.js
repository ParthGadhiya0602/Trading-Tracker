"use strict";

module.exports = function createAuthHandler(ctx) {
  const { auth, respond } = ctx;
  const { clearCookie, readJson, sendJson, sendJsonCookie, sessionCookie } =
    respond;

  return async function handleAuthApi(req, res, url, method, token) {
    if (url === "/api/auth/status" && method === "GET") {
      sendJson(res, 200, {
        needsSetup: auth.needsSetup(),
        user: auth.sessionUser(token),
      });
      return true;
    }
    if (url === "/api/auth/users-public" && method === "GET") {
      sendJson(res, 200, {
        users: auth.needsSetup() ? [] : auth.pickerUsers(),
      });
      return true;
    }
    if (url === "/api/auth/setup" && method === "POST") {
      const body = await readJson(req);
      const result = auth.setupAdmin(body);
      if (result.error)
        return (sendJson(res, 400, { error: result.error }), true);
      const login = auth.login(body.username, body.password);
      return (
        sendJsonCookie(
          res,
          201,
          { user: result.user },
          login.token ? sessionCookie(login.token) : undefined,
        ),
        true
      );
    }
    if (url === "/api/auth/login" && method === "POST") {
      const body = await readJson(req);
      const result = auth.login(body.username, body.password);
      if (result.error)
        return (sendJson(res, 401, { error: result.error }), true);
      return (
        sendJsonCookie(
          res,
          200,
          { user: result.user },
          sessionCookie(result.token),
        ),
        true
      );
    }
    if (url === "/api/auth/logout" && method === "POST") {
      auth.logout(token);
      return (sendJsonCookie(res, 200, { ok: true }, clearCookie()), true);
    }
    return false;
  };
};
