"use strict";

const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

module.exports = function createStaticHandler(ctx) {
  const { frontendDir, respond } = ctx;
  const { send } = respond;

  return async function serveStatic(res, urlPath) {
    let relative = decodeURIComponent(urlPath);
    if (relative === "/" || relative === "") relative = "/index.html";
    const full = path.normalize(path.join(frontendDir, relative));
    if (
      full !== frontendDir &&
      !full.startsWith(frontendDir + path.sep)
    ) {
      send(res, 404, "Not found", "text/plain");
      return;
    }
    fs.readFile(full, (error, buffer) => {
      if (error) send(res, 404, "Not found", "text/plain");
      else
        send(
          res,
          200,
          buffer,
          MIME[path.extname(full)] || "application/octet-stream",
        );
    });
  };
};
