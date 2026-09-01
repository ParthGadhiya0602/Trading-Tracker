"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AlertPriceResolver } = require("./alert-price-resolver");

test("resolves a stock future by its saved symbol and expiry", () => {
  const store = {
    getStock: () => null,
    derivatives: {
      getSnapshot: () => ({
        data: {
          rows: [
            { symbol: "RELIANCE", expiry: "2026-09-24", lastPrice: 1450, highPrice: 1462, lowPrice: 1432 },
            { symbol: "RELIANCE", expiry: "2026-10-29", lastPrice: 1458, highPrice: 1470, lowPrice: 1441 },
          ],
        },
      }),
    },
  };
  const resolver = new AlertPriceResolver({ store });
  const quote = resolver.resolve({
    market: "stock-future",
    symbol: "RELIANCE",
    contractExpiry: "2026-09-24",
  });
  assert.equal(quote.lastPrice, 1450);
  assert.equal(quote.dayHigh, 1462);
  assert.equal(quote.dayLow, 1432);
  assert.equal(quote.preopen, false);
});

test("resolves an index future by its saved symbol and expiry", () => {
  const store = {
    getStock: () => null,
    derivatives: {
      getSnapshot: (key) => key === "future:index:NIFTY" ? {
        data: { rows: [{ expiry: "2026-09-24", lastPrice: 25110, highPrice: 25140, lowPrice: 25042 }] },
      } : null,
    },
  };
  const quote = new AlertPriceResolver({ store }).resolve({
    market: "index-future", symbol: "NIFTY", contractExpiry: "2026-09-24",
  });
  assert.equal(quote.lastPrice, 25110);
  assert.equal(quote.dayHigh, 25140);
  assert.equal(quote.dayLow, 25042);
});

test("resolves only the selected option leg at its saved strike", () => {
  const store = {
    getStock: () => null,
    derivatives: {
      getSnapshot: () => ({
        data: {
          rows: [
            {
              strike: 25000,
              call: { lastPrice: 182.5 },
              put: { lastPrice: 144.2 },
            },
          ],
        },
      }),
    },
  };
  const resolver = new AlertPriceResolver({ store });
  const quote = resolver.resolve({
    market: "index-option",
    symbol: "NIFTY",
    contractExpiry: "2026-09-24",
    strike: 25000,
    optionType: "PE",
  });
  assert.equal(quote.lastPrice, 144.2);
  assert.equal(quote.leg.lastPrice, 144.2);
});
