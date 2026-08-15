"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { MarketStore } = require("./market-store");

function samplePayload() {
  return {
    "NIFTY 50": {
      level: { last: 24000, pChange: 0.5 },
      data: [
        { symbol: "RELIANCE", lastPrice: 2900, pChange: 1.2, totalTradedVolume: 5000 },
        { symbol: "TCS", lastPrice: 3800, pChange: -0.8, totalTradedVolume: 3000 },
      ],
      marketStatus: "open",
      timestamp: 1,
    },
  };
}

test("singleton export is a MarketStore instance, class attached", () => {
  const store = require("./market-store");
  assert.ok(store instanceof MarketStore);
  assert.strictEqual(store.MarketStore, MarketStore);
});

test("ingestSnapshot populates snapshot + bySymbol + stamp", () => {
  const s = new MarketStore();
  assert.strictEqual(s.hasData(), false);
  s.ingestSnapshot(samplePayload());
  assert.strictEqual(s.hasData(), true);
  assert.strictEqual(s.getPrice("RELIANCE"), 2900);
  assert.strictEqual(s.getStock("TCS").lastPrice, 3800);
  assert.strictEqual(s.getIndex("NIFTY 50").marketStatus, "open");
  assert.ok(s.stamp() > 0);
});

test("ingestSnapshot ignores junk without wiping state", () => {
  const s = new MarketStore();
  s.ingestSnapshot(samplePayload());
  s.ingestSnapshot(null);
  s.ingestSnapshot("nope");
  assert.strictEqual(s.getPrice("RELIANCE"), 2900);
});

test("applyTick(stock) merges patch, preserves untouched fields", () => {
  const s = new MarketStore();
  s.ingestSnapshot(samplePayload());
  s.applyTick({ index: "NIFTY 50", kind: "stock", symbol: "RELIANCE", patch: { lastPrice: 2950 } });
  assert.strictEqual(s.getPrice("RELIANCE"), 2950);
  assert.strictEqual(s.getStock("RELIANCE").pChange, 1.2); // untouched
});

test("applyTick ignores unknown symbol / unknown index", () => {
  const s = new MarketStore();
  s.ingestSnapshot(samplePayload());
  s.applyTick({ index: "NIFTY 50", kind: "stock", symbol: "GHOST", patch: { lastPrice: 1 } });
  s.applyTick({ index: "NO SUCH", kind: "stock", symbol: "RELIANCE", patch: { lastPrice: 1 } });
  assert.strictEqual(s.getStock("GHOST"), null);
  assert.strictEqual(s.getPrice("RELIANCE"), 2900);
});

test("applyTick(level) merges into index level", () => {
  const s = new MarketStore();
  s.ingestSnapshot(samplePayload());
  s.applyTick({ index: "NIFTY 50", kind: "level", patch: { last: 24100 } });
  assert.strictEqual(s.getIndex("NIFTY 50").level.last, 24100);
  assert.strictEqual(s.getIndex("NIFTY 50").level.pChange, 0.5); // preserved
});

test("getPrice null for missing symbol / missing lastPrice", () => {
  const s = new MarketStore();
  assert.strictEqual(s.getPrice("RELIANCE"), null);
  s.ingestSnapshot({ X: { data: [{ symbol: "NOPRICE" }] } });
  assert.strictEqual(s.getPrice("NOPRICE"), null);
});

test("isFresh reflects the stamp window", () => {
  const s = new MarketStore();
  assert.strictEqual(s.isFresh(1000), false);
  s.ingestSnapshot(samplePayload());
  assert.strictEqual(s.isFresh(10_000), true);
  assert.strictEqual(s.isFresh(0), false);
});

test("enrichAlerts adds currentPrice per symbol", () => {
  const s = new MarketStore();
  s.ingestSnapshot(samplePayload());
  const out = s.enrichAlerts([{ symbol: "RELIANCE", id: "a" }, { symbol: "GHOST", id: "b" }]);
  assert.strictEqual(out[0].currentPrice, 2900);
  assert.strictEqual(out[1].currentPrice, null);
  assert.strictEqual(out[0].id, "a"); // original fields kept
});

test("gainers / losers / mostActive derive correctly", () => {
  const s = new MarketStore();
  s.ingestSnapshot(samplePayload());
  assert.deepStrictEqual(s.gainers("NIFTY 50").map((r) => r.symbol), ["RELIANCE"]);
  assert.deepStrictEqual(s.losers("NIFTY 50").map((r) => r.symbol), ["TCS"]);
  assert.strictEqual(s.mostActive("NIFTY 50")[0].symbol, "RELIANCE");
});
