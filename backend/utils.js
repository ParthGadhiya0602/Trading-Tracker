"use strict";

function istNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).replace(" ", "T") + "+05:30";
}

function istFromMs(ms) {
  return new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).replace(" ", "T") + "+05:30";
}

function istLogTs() {
  const p = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .forEach((x) => (p[x.type] = x.value));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} IST`;
}

// Boolean env flag: on for any value EXCEPT unset / "" / "0" / "false" / "no" / "off"
// (case-insensitive). So FLAG=1 -> on, FLAG=0/false -> off, unset -> off.
function envFlag(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return !(s === "" || s === "0" || s === "false" || s === "no" || s === "off");
}

module.exports = { istNow, istFromMs, istLogTs, envFlag };
