"use strict";

/**
 * Central logger (zero dependencies).
 *
 * One file per IST day: logs/YYYY-MM-DD.log. Every line is
 *   [YYYY-MM-DD HH:MM:SS IST] LEVEL [scope] message
 * Levels: ERROR / WARN (-> stderr) and INFO (-> stdout). The active file rolls
 * automatically at IST midnight (the filename is derived per write), and on each
 * roll we prune files older than RETENTION_DAYS. Logging must never throw.
 *
 * All backend modules log through here: alerts.js re-exports logError, and it is
 * injected into telegram/durable-outbox/llm so the whole app shares this rotation.
 */

const fs = require("fs");
const path = require("path");
const { istNow, istLogTs } = require("./utils");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const RETENTION_DAYS = 14;

let lastPrunedDate = null;

function todayIST() {
  return istNow().slice(0, 10); // YYYY-MM-DD (IST)
}

function logFileFor(date) {
  return path.join(LOG_DIR, `${date}.log`);
}

// Delete day files older than the retention window. Runs once per new day.
function prune(today) {
  try {
    const cutoff = Date.parse(today) - RETENTION_DAYS * 86_400_000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      const m = name.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      if (Date.parse(m[1]) < cutoff) {
        try {
          fs.unlinkSync(path.join(LOG_DIR, name));
        } catch (_) {
          /* ignore - a file we can't remove shouldn't break logging */
        }
      }
    }
  } catch (_) {
    /* logging must never throw */
  }
}

function write(level, scope, msg) {
  const text = msg && msg.message ? msg.message : String(msg == null ? "" : msg);
  const date = todayIST();
  const line = `[${istLogTs()}] ${level} [${scope}] ${text}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFileFor(date), line);
    if (date !== lastPrunedDate) {
      lastPrunedDate = date;
      prune(date);
    }
  } catch (_) {
    /* logging must never throw */
  }
  (level === "INFO" ? console.log : console.error)("  " + line.trimEnd());
  return line;
}

function logError(scope, err) {
  return write("ERROR", scope, err);
}
function logWarn(scope, msg) {
  return write("WARN", scope, msg);
}
function logInfo(scope, msg) {
  return write("INFO", scope, msg);
}

module.exports = { logError, logWarn, logInfo, LOG_DIR };
