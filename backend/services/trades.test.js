"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const tradesSingleton = require("./trades");
const { TradesRepo } = tradesSingleton;

// Uses read-only paths (validate/derive/list/summary) + direct store seeding so no test
// ever writes store/trades.json.

test("singleton export is a TradesRepo with the full public API (drop-in)", () => {
  assert.ok(tradesSingleton instanceof TradesRepo);
  for (const m of ["load","list","get","find","create","update","remove","summary","backendName","derive","validate"])
    assert.strictEqual(typeof tradesSingleton[m], "function", `missing ${m}`);
});

test("validate rejects bad input", () => {
  const r = new TradesRepo();
  const { errors } = r.validate({});
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes("symbol")));
  assert.ok(errors.some((e) => e.includes("qty")));
});

test("validate accepts a clean open intraday trade", () => {
  const r = new TradesRepo();
  const { errors, clean } = r.validate({
    tradeType: "intraday", symbol: "reliance", side: "buy", qty: 10,
    entryPrice: 2900, entryDate: "2026-08-14", entryTime: "09:30",
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(clean.symbol, "RELIANCE");
  assert.strictEqual(clean.side, "BUY");
  assert.strictEqual(clean.exitPrice, null);
});

test("validate: intraday requires entryTime; SELL stop must be above entry", () => {
  const r = new TradesRepo();
  assert.ok(r.validate({ tradeType: "intraday", symbol: "X", side: "BUY", qty: 1, entryPrice: 100, entryDate: "2026-08-14" })
    .errors.some((e) => e.includes("entryTime is required")));
  assert.ok(r.validate({ tradeType: "swing", symbol: "X", side: "SELL", qty: 1, entryPrice: 100, entryDate: "2026-08-14", stopLoss: 90 })
    .errors.some((e) => e.includes("stop loss must be above")));
});

test("derive computes net P&L, %, and R for a closed BUY", () => {
  const r = new TradesRepo();
  const d = r.derive({
    side: "BUY", qty: 10, entryPrice: 100, exitPrice: 120, exitDate: "2026-08-14",
    stopLoss: 90, charges: 50,
    entryDate: "2026-08-14", entryTime: "09:30", exitTime: "10:30",
  });
  assert.strictEqual(d.grossPnl, 200); // (120-100)*10
  assert.strictEqual(d.netPnl, 150); // 200 - 50
  assert.strictEqual(d.pnlPct, 15); // 150 / 1000 * 100
  assert.strictEqual(d.rMultiple, 1.5); // 150 / (10*10)
  assert.strictEqual(d.holdingPeriodMinutes, 60);
});

test("derive leaves P&L null for an open trade", () => {
  const r = new TradesRepo();
  const d = r.derive({ side: "BUY", qty: 10, entryPrice: 100 });
  assert.strictEqual(d.netPnl, null);
  assert.strictEqual(d.rMultiple, null);
});

test("list filters + summary aggregate from a seeded store (no disk write)", () => {
  const r = new TradesRepo();
  r.store.trades = [
    { id: "1", tradeType: "intraday", symbol: "AAA", side: "BUY", qty: 10, entryPrice: 100,
      exitPrice: 120, exitDate: "2026-08-14", status: "closed", charges: 0, createdAt: "2026-08-14T10:00:00+05:30" },
    { id: "2", tradeType: "swing", symbol: "BBB", side: "BUY", qty: 5, entryPrice: 200,
      status: "open", charges: 0, createdAt: "2026-08-13T10:00:00+05:30" },
  ];
  assert.strictEqual(r.list({ status: "closed" }).length, 1);
  assert.strictEqual(r.list({ tradeType: "swing" })[0].symbol, "BBB");
  const s = r.summary();
  assert.strictEqual(s.open.count, 1);
  assert.strictEqual(s.closed.count, 1);
  assert.strictEqual(s.closed.wins, 1);
  assert.strictEqual(s.closed.netPnl, 200);
});
