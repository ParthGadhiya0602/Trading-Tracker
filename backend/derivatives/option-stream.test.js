"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeStreamFrame } = require("./nse-derivatives");
const { MarketStore } = require("../core/market-store");

const CTX = { market: "index", symbol: "NIFTY", expiry: "2026-08-18" };

function seededChain() {
  return {
    key: "index:NIFTY:2026-08-18",
    kind: "option-chain",
    market: "index",
    symbol: "NIFTY",
    expiry: "2026-08-18",
    state: "live",
    sourceTimestamp: "2026-08-14T15:39:00+05:30",
    receivedAt: "2026-08-14T15:39:01+05:30",
    data: {
      underlyingValue: 24010,
      rows: [
        { strike: 24000,
          call: { openInterest: 5000, volume: 200, impliedVolatility: 12.5, bidPrice: 100, askPrice: 101, lastPrice: 100 },
          put:  { openInterest: 4000, volume: 150, impliedVolatility: 13.1, bidPrice: 80, askPrice: 81, lastPrice: 80 } },
      ],
    },
  };
}

test("normalizeStreamFrame maps WSS legs -> pruned patch delta", () => {
  const frame = {
    timestamp: "2026-08-14 15:40:00", strikePrice: 24000, expiryDates: "18-Aug-2026",
    CE: { buyPrice1: 120.5, sellPrice1: 121.0, buyQuantity1: 1500, sellQuantity1: 1800, lastPrice: 120.75, change: -3.25 },
    PE: { buyPrice1: 79.0, sellPrice1: 79.5, buyQuantity1: 900, sellQuantity1: 1100, lastPrice: 79.25, change: 1.1 },
  };
  const d = normalizeStreamFrame(frame, CTX);
  assert.strictEqual(d.key, "index:NIFTY:2026-08-18");
  assert.strictEqual(d.kind, "option-chain");
  assert.strictEqual(d.strike, 24000);
  assert.deepStrictEqual(d.call, { lastPrice: 120.75, change: -3.25, bidPrice: 120.5, askPrice: 121.0, bidQuantity: 1500, askQuantity: 1800 });
  assert.strictEqual(d.put.bidPrice, 79.0);
  // WSS never carries OI/vol/IV -> not in the patch
  assert.strictEqual("openInterest" in d.call, false);
});

test("normalizeStreamFrame preserves zeros, rejects junk", () => {
  const zeros = normalizeStreamFrame({ strikePrice: 24000, CE: { buyPrice1: 0, lastPrice: 0, change: 0 } }, CTX);
  assert.strictEqual(zeros.call.bidPrice, 0); // 0 is a real price, not pruned
  assert.strictEqual(zeros.call.lastPrice, 0);
  assert.strictEqual(normalizeStreamFrame({ CE: {} }, CTX), null); // no strike
  assert.strictEqual(normalizeStreamFrame({ strikePrice: 24000 }, CTX), null); // no legs
  assert.strictEqual(normalizeStreamFrame("not json", CTX), null);
  assert.strictEqual(normalizeStreamFrame({ strikePrice: 1 }, { market: "index" }), null); // bad context
});

test("applyTick merges price/bid/ask/ltp, preserves REST OI/vol/IV, bumps sequence", () => {
  const s = new MarketStore();
  s.derivatives.ingestSnapshot(seededChain());
  const before = s.derivatives.getSnapshot("index:NIFTY:2026-08-18");
  assert.strictEqual(before.sequence, 1);

  const delta = normalizeStreamFrame({
    strikePrice: 24000,
    CE: { buyPrice1: 120.5, sellPrice1: 121, lastPrice: 120.75, change: -3.25 },
  }, CTX);
  const after = s.derivatives.applyTick(delta);
  assert.ok(after, "applyTick returned an updated snapshot");
  const call = after.data.rows[0].call;
  assert.strictEqual(call.bidPrice, 120.5);   // merged from WSS
  assert.strictEqual(call.lastPrice, 120.75); // merged from WSS
  assert.strictEqual(call.openInterest, 5000); // preserved from REST
  assert.strictEqual(call.volume, 200);        // preserved from REST
  assert.strictEqual(call.impliedVolatility, 12.5); // preserved from REST
  assert.strictEqual(after.data.rows[0].put.lastPrice, 80); // untouched leg preserved
  assert.strictEqual(after.sequence, 2);       // bumped
  assert.strictEqual(after.transport, "wss");
});

test("applyTick refuses to seed / create strikes / cross identities", () => {
  const s = new MarketStore();
  // no REST seed yet
  assert.strictEqual(s.derivatives.applyTick(normalizeStreamFrame({ strikePrice: 24000, CE: { lastPrice: 1 } }, CTX)), null);
  s.derivatives.ingestSnapshot(seededChain());
  // unknown strike -> ignored
  assert.strictEqual(s.derivatives.applyTick(normalizeStreamFrame({ strikePrice: 99999, CE: { lastPrice: 1 } }, CTX)), null);
  // wrong symbol identity -> ignored
  assert.strictEqual(s.derivatives.applyTick({ key: "index:BANKNIFTY:2026-08-18", market: "index", symbol: "BANKNIFTY", expiry: "2026-08-18", strike: 24000, call: { lastPrice: 1 } }), null);
  // sequence unchanged after all no-ops
  assert.strictEqual(s.derivatives.getSnapshot("index:NIFTY:2026-08-18").sequence, 1);
});

test("applyTick only merges onto an existing REST leg (never fabricates a leg)", () => {
  const s = new MarketStore();
  const chain = seededChain();
  chain.data.rows[0].put = null; // REST had no put leg at this strike
  s.derivatives.ingestSnapshot(chain);
  const after = s.derivatives.applyTick(normalizeStreamFrame({ strikePrice: 24000, PE: { lastPrice: 5 } }, CTX));
  assert.strictEqual(after, null); // nothing to merge onto -> no change
});
