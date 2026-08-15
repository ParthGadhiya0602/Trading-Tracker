"use strict";

const fs = require("fs");
const path = require("path");

function createMarketCapture({
  base,
  captureDir,
  feedConfig,
  indexUrl,
  istNow,
  logInfo,
  logWarn,
  marketState,
  marketStatusStr,
  srcJson,
}) {
  const captureSeen = new Set();
  const lastStatusByScope = {};

  function captureFile() {
    return path.join(
      captureDir,
      `market-capture-${istNow().slice(0, 10)}.jsonl`,
    );
  }

  async function recordCapture(scope, marketStatus, timestamp, raw) {
    const previous = lastStatusByScope[scope];
    if (previous === marketStatus) return;
    lastStatusByScope[scope] = marketStatus;
    const key = `${istNow().slice(0, 10)}:${scope}:${marketStatus}`;
    const first = !captureSeen.has(key);
    if (first) captureSeen.add(key);
    const line = {
      at: istNow(),
      scope,
      ourState: marketState(),
      marketStatus,
      timestamp,
    };
    if (first) line.raw = raw;
    try {
      await fs.promises.mkdir(captureDir, { recursive: true });
      await fs.promises.appendFile(captureFile(), JSON.stringify(line) + "\n");
    } catch (error) {
      logWarn("capture.write", (error && error.message) || error);
    }
    logInfo(
      "capture",
      `${scope}: ${previous || "(start)"} -> ${marketStatus} (ourState=${marketState()})${first ? " [raw saved]" : ""}`,
    );
  }

  async function captureTick() {
    try {
      if (marketState() === "pre-open" && feedConfig.preopenEndpoint) {
        const response = await srcJson(
          `${base}${feedConfig.preopenEndpoint}ALL`,
        );
        await recordCapture(
          "preopen",
          "Pre-open",
          (response && response.timestamp) || null,
          response,
        );
      }
      const response = await srcJson(indexUrl("NIFTY 50"));
      const data = (response && response.data) || {};
      await recordCapture(
        "indices",
        marketStatusStr(data.marketStatus),
        data.timestamp || null,
        response,
      );
    } catch (error) {
      logWarn("capture.tick", (error && error.message) || error);
    }
  }

  return { recordCapture, captureTick, captureFile };
}

module.exports = { createMarketCapture };
