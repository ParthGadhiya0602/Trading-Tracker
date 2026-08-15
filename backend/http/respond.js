"use strict";

const SID = "sid";
const SESSION_MAX_AGE = 12 * 60 * 60;

function send(res, code, body, ctype) {
  res.writeHead(code, {
    "Content-Type": ctype,
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const output = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index > 0)
      output[part.slice(0, index).trim()] = decodeURIComponent(
        part.slice(index + 1).trim(),
      );
  });
  return output;
}

function getToken(req) {
  return parseCookies(req)[SID] || null;
}

function sessionCookie(token) {
  return `${SID}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

function clearCookie() {
  return `${SID}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function sendJsonCookie(res, code, obj, setCookie) {
  const body = JSON.stringify(obj);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  res.writeHead(code, headers);
  res.end(body);
}

function validDerivativeDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function derivativeExpiryIsValid(contracts, expiry) {
  return Boolean(
    contracts &&
      Array.isArray(contracts.expiries) &&
      contracts.expiries.some((entry) => entry && entry.expiry === expiry),
  );
}

function num(value) {
  if (value == null || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isNaN(number) ? null : number;
}

function createRespond({ alerts, authorize, DerivativesError, host }) {
  function finishAlert(res, result) {
    if (result.error)
      return sendJson(
        res,
        result.status || (result.error === "not found" ? 404 : 400),
        {
          error: result.error,
          ...(result.currentVersion == null
            ? {}
            : { currentVersion: result.currentVersion }),
        },
      );
    return sendJson(res, 200, {
      alert: result.alert,
      syncStatus: alerts.syncStatus(),
    });
  }

  function permit(res, user, action, alert) {
    const denied = authorize(user, action, alert);
    if (!denied) return true;
    sendJson(res, denied.status, { error: denied.error });
    return false;
  }

  function derivativeErrorResponse(res, error) {
    const code =
      error instanceof DerivativesError ? error.code : "SOURCE_ERROR";
    const status =
      code === "INVALID_QUERY" || code === "INVALID_KEY"
        ? 400
        : code === "SNAPSHOT_UNAVAILABLE" || code === "NOT_FOUND"
          ? 404
          : code === "REQUEST_BUDGET" || code === "CAPACITY"
            ? 429
            : code === "UPSTREAM_BLOCK" ||
                code === "SOURCE_BUSY" ||
                code === "CLOSED"
              ? 503
              : 502;
    const retryAfterMs =
      error && Number.isFinite(Number(error.retryAfterMs))
        ? Math.max(0, Number(error.retryAfterMs))
        : null;
    sendJson(res, status, {
      error:
        error instanceof DerivativesError
          ? error.message
          : "derivatives source request failed",
      code,
      ...(retryAfterMs == null ? {} : { retryAfterMs }),
    });
  }

  function derivativeQuery(req, fields, market = "index") {
    if ((req.url || "").length > 512)
      throw new DerivativesError("INVALID_QUERY", "query is too long");
    const query = new URL(req.url, `http://${host}`).searchParams;
    for (const name of query.keys()) {
      if (!fields.includes(name) || query.getAll(name).length !== 1) {
        throw new DerivativesError(
          "INVALID_QUERY",
          "invalid query parameters",
        );
      }
    }
    const result = {};
    for (const field of fields) {
      const value = query.get(field);
      const maxLength = field === "symbol" ? (market === "equity" || market === "stock" || market === "commodity" ? 30 : 12) : 10;
      if (typeof value !== "string" || !value || value.length > maxLength) {
        throw new DerivativesError("INVALID_QUERY", `invalid ${field}`);
      }
      result[field] = value;
    }
    if (
      market === "index" &&
      ![
        "NIFTY",
        "NIFTYNXT50",
        "FINNIFTY",
        "BANKNIFTY",
        "MIDCPNIFTY",
        "NIFTYFPI",
      ].includes(result.symbol)
    ) {
      throw new DerivativesError(
        "INVALID_QUERY",
        "symbol is not a supported index derivative",
      );
    }
    if (
      (market === "equity" || market === "stock" || market === "commodity") &&
      !/^[A-Z0-9][A-Z0-9&._-]{0,29}$/.test(result.symbol)
    ) {
      throw new DerivativesError("INVALID_QUERY", "invalid equity symbol");
    }
    if (result.expiry && !validDerivativeDate(result.expiry)) {
      throw new DerivativesError(
        "INVALID_QUERY",
        "expiry must be an ISO calendar date",
      );
    }
    return result;
  }

  return {
    send,
    sendJson,
    readJson,
    parseCookies,
    getToken,
    sessionCookie,
    clearCookie,
    sendJsonCookie,
    finishAlert,
    permit,
    derivativeErrorResponse,
    derivativeQuery,
    validDerivativeDate,
    derivativeExpiryIsValid,
    num,
  };
}

module.exports = {
  createRespond,
  send,
  sendJson,
  readJson,
  parseCookies,
  getToken,
  sessionCookie,
  clearCookie,
  sendJsonCookie,
  validDerivativeDate,
  derivativeExpiryIsValid,
  num,
};
