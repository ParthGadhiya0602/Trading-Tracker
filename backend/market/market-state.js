"use strict";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istTradingDate(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function nextDerivativeOpenDelayMs(nowMs = Date.now()) {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = ist.getUTCDate();
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = Date.UTC(year, month, day + offset, 3, 45);
    const weekday = new Date(candidate + IST_OFFSET_MS).getUTCDay();
    if (weekday === 0 || weekday === 6 || candidate <= nowMs) continue;
    return Math.max(1000, candidate - nowMs);
  }
  return 24 * 60 * 60 * 1000;
}

function marketState(d = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = {};
  formatter.formatToParts(d).forEach((part) => (parts[part.type] = part.value));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "closed";
  const mins =
    (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10);
  if (mins >= 9 * 60 && mins < 9 * 60 + 15) return "pre-open";
  if (mins >= 9 * 60 + 15 && mins < 15 * 60 + 30) return "open";
  return "closed";
}

module.exports = {
  marketState,
  istTradingDate,
  nextDerivativeOpenDelayMs,
  IST_OFFSET_MS,
};
