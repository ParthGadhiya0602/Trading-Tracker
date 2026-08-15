"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createNseDerivatives, ProviderError } = require("./nse-derivatives");

function response(status, body, contentType = "application/json", extraHeaders = {}) {
  const headers = new Map(Object.entries({ "content-type": contentType, ...extraHeaders }).map(([key, value]) => [key.toLowerCase(), value]));
  let reads = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers.get(name.toLowerCase()) || null; } },
    async text() { reads += 1; return body; },
    get reads() { return reads; },
  };
}

function provider(responses, options = {}) {
  const requests = [];
  const queue = Array.isArray(responses) ? responses.slice() : [responses];
  return {
    requests,
    api: createNseDerivatives({
      base: "https://www.nseindia.com/root/ignored",
      config: {
        contractInfoEndpoint: "/api/option-chain-contract-info?existing=1",
        optionChainEndpoint: "/api/option-chain-indices",
        referer: "/option-chain",
        enabledSymbols: ["NIFTY", "BANKNIFTY"],
      },
      fetchResponse: async (request) => { requests.push(request); return queue.shift(); },
      now: () => Date.UTC(2026, 7, 13, 4, 30, 15, 123),
      ...options,
    }),
  };
}

function chainPayload(rows, overrides = {}) {
  return JSON.stringify({
    records: { underlying: "NIFTY", timestamp: "13-Aug-2026 10:00:00", underlyingValue: 24500, data: rows },
    ...overrides,
  });
}

function leg(overrides = {}) {
  return {
    identifier: "OPT-NIFTY-24500-CE",
    underlying: "NIFTY",
    expiryDate: "28-Aug-2026",
    openInterest: 0,
    changeinOpenInterest: "-",
    pchangeinOpenInterest: 0,
    totalTradedVolume: "0",
    impliedVolatility: 12.5,
    lastPrice: 0,
    change: "-",
    pChange: 0,
    bidQty: 0,
    bidprice: 0,
    askPrice: 0,
    askQty: 0,
    ...overrides,
  };
}

test("rejects unsafe provider configuration before any request", () => {
  const base = { base: "https://nse.example", fetchResponse: async () => response(200, "{}") };
  for (const config of [
    { contractInfoEndpoint: "api/contracts", optionChainEndpoint: "/api/chain", referer: "x", enabledSymbols: ["NIFTY"] },
    { contractInfoEndpoint: "//evil.example/contracts", optionChainEndpoint: "/api/chain", referer: "x", enabledSymbols: ["NIFTY"] },
    { contractInfoEndpoint: "https://evil.example/contracts", optionChainEndpoint: "/api/chain", referer: "x", enabledSymbols: ["NIFTY"] },
    { contractInfoEndpoint: "/api/contracts", optionChainEndpoint: "/api/chain", referer: "", enabledSymbols: ["SENSEX"] },
    { contractInfoEndpoint: "/api/contracts", optionChainEndpoint: "/api/chain", referer: "https://evil.example/option-chain", enabledSymbols: ["NIFTY"] },
    { contractInfoEndpoint: "/api/contracts", optionChainEndpoint: "/api/chain", referer: "//evil.example/option-chain", enabledSymbols: ["NIFTY"] },
  ]) {
    assert.throws(() => createNseDerivatives({ ...base, config }), (error) => error instanceof ProviderError && error.code === "CONFIG_ERROR");
  }
});

test("contracts build an encoded root-relative URL and canonicalize sorted values", async () => {
  const { api, requests } = provider(response(200, JSON.stringify({
    records: { underlying: "NIFTY", timestamp: "13-Aug-2026 09:30:00", expiryDates: ["28-Aug-2026", "2026-08-21", "21-08-2026", "bad"], strikePrices: [25000, "24,500", 0, "-", "bad"] },
  })));
  const result = await api.getContracts({ market: "index", symbol: "NIFTY" });
  assert.equal(requests[0].url, "https://www.nseindia.com/api/option-chain-contract-info?existing=1&symbol=NIFTY");
  assert.equal(requests[0].referer, "/option-chain");
  assert.deepEqual(result.expiries, [
    { expiry: "2026-08-21", providerValue: "2026-08-21" },
    { expiry: "2026-08-28", providerValue: "28-Aug-2026" },
  ]);
  assert.deepEqual(result.strikes, [0, 24500, 25000]);
  assert.deepEqual(result.diagnostics, { discardedExpiries: 2, discardedStrikes: 2 });
  assert.equal(result.sourceTimestamp, "2026-08-13T09:30:00+05:30");
  assert.equal(result.receivedAt, "2026-08-13T10:00:15.123+05:30");
});

test("option-chain accepts all expiry formats, encodes date, and preserves numeric zeroes", async () => {
  const { api, requests } = provider(response(200, chainPayload([
    { strikePrice: 24500, CE: leg(), PE: leg({ identifier: "OPT-NIFTY-24500-PE", PChange: 0 }) },
  ])));
  const result = await api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "2026-08-28" });
  assert.equal(requests[0].url, "https://www.nseindia.com/api/option-chain-indices?type=Indices&symbol=NIFTY&expiry=28-Aug-2026");
  assert.equal(result.key, "index:NIFTY:2026-08-28");
  assert.equal(result.state, "live");
  const call = result.data.rows[0].call;
  assert.equal(call.openInterest, 0);
  assert.equal(call.changeInOpenInterest, null);
  assert.equal(call.percentChange, 0);
  assert.equal(call.bidPrice, 0);
  assert.equal(call.side, "CE");
  assert.equal(result.stale, false);
  assert.equal(result.data.rows[0].put.providerContractId, "OPT-NIFTY-24500-PE");
  assert.equal(result.data.rows[0].put.percentChange, 0);
  assert.equal(result.sourceTimestamp, "2026-08-13T10:00:00+05:30");
  assert.deepEqual(result.diagnostics, {
    totalRows: 1,
    validRows: 1,
    discardedRows: 0,
    missingCallLegs: 0,
    missingPutLegs: 0,
    missingIvLegs: 0,
  });
});

test("option-chain accepts lowercase CE/PE and reports a one-leg chain as partial", async () => {
  const { api } = provider(response(200, chainPayload([
    { strikePrice: "24600", ce: leg(), pe: null },
    { strikePrice: 24400, call: leg({ pChange: "1.2" }), put: leg({ identifier: "P", pChange: "-", impliedVolatility: "-" }) },
  ])));
  const result = await api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "28-08-2026" });
  assert.equal(result.state, "partial");
  assert.equal(result.reason, "missing-leg");
  assert.deepEqual(result.data.rows.map((row) => row.strike), [24400, 24600]);
  assert.equal(result.data.rows[0].put.percentChange, null);
  assert.equal(result.data.rows[1].put, null);
  assert.deepEqual(result.diagnostics, {
    totalRows: 2,
    validRows: 2,
    discardedRows: 0,
    missingCallLegs: 0,
    missingPutLegs: 1,
    missingIvLegs: 1,
  });
});

test("uses NSE top-of-book fields and each leg's underlying value before the envelope fallback", async () => {
  const { api } = provider(response(200, chainPayload([
    {
      strikePrice: 24500,
      CE: leg({ underlyingValue: 24501, buyQuantity1: 11, buyPrice1: 12, sellPrice1: 13, sellQuantity1: 14 }),
      PE: leg({ identifier: "P", underlyingValue: "-", buyQuantity1: 0, buyPrice1: 0, sellPrice1: 0, sellQuantity1: 0 }),
    },
  ])));
  const result = await api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "28-Aug-2026" });
  assert.deepEqual(
    {
      underlyingValue: result.data.rows[0].call.underlyingValue,
      bidQuantity: result.data.rows[0].call.bidQuantity,
      bidPrice: result.data.rows[0].call.bidPrice,
      askPrice: result.data.rows[0].call.askPrice,
      askQuantity: result.data.rows[0].call.askQuantity,
      fallbackUnderlyingValue: result.data.rows[0].put.underlyingValue,
    },
    { underlyingValue: 24501, bidQuantity: 11, bidPrice: 12, askPrice: 13, askQuantity: 14, fallbackUnderlyingValue: 24500 },
  );
});

test("explicit market closure retains valid rows, while every empty chain is a schema error", async () => {
  const closed = provider(response(200, chainPayload([{ strikePrice: 24500, CE: leg(), PE: leg() }], { marketStatus: "Closed" })));
  const result = await closed.api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "28-Aug-2026" });
  assert.equal(result.state, "closed");
  assert.equal(result.reason, "market-closed");
  for (const payload of [chainPayload([]), chainPayload([], { marketStatus: "Closed" })]) {
    const open = provider(response(200, payload));
    await assert.rejects(open.api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "28-Aug-2026" }), (error) => error.code === "SCHEMA_ERROR");
  }
});

test("invalid query dates use calendar validation and response identity mismatches fail", async () => {
  const { api } = provider(response(200, chainPayload([])));
  for (const expiry of ["2026-02-29", "31-Apr-2026", "2026/08/28", ""]) {
    await assert.rejects(api.getOptionChain({ market: "index", symbol: "NIFTY", expiry }), (error) => error.code === "INVALID_QUERY");
  }
  await assert.rejects(api.getContracts({ market: "stock", symbol: "NIFTY" }), (error) => error.code === "INVALID_QUERY");
  const mismatch = provider(response(200, chainPayload([{ strikePrice: 24500, CE: leg({ expiryDate: "04-Sep-2026" }) }])));
  await assert.rejects(mismatch.api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "28-Aug-2026" }), (error) => error.code === "IDENTITY_MISMATCH");
  for (const row of [
    { strikePrice: 24500, expiryDates: ["04-Sep-2026"], CE: leg() },
    { strikePrice: 24500, expiryDate: "04-Sep-2026", CE: leg() },
    { strikePrice: 24500, CE: leg({ strikePrice: 24600 }) },
  ]) {
    const badIdentity = provider(response(200, chainPayload([row])));
    await assert.rejects(badIdentity.api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "28-Aug-2026" }), (error) => error.code === "IDENTITY_MISMATCH");
  }
});

test("source timestamps are timezone-aware only after explicit calendar validation", async () => {
  const contracts = provider(response(200, JSON.stringify({
    records: { expiryDates: ["28-Aug-2026"], timestamp: "2026-08-13T10:00:00.120Z" },
  })));
  const contractResult = await contracts.api.getContracts({ market: "index", symbol: "NIFTY" });
  assert.equal(contractResult.sourceTimestamp, "2026-08-13T10:00:00.120Z");

  const chain = provider(response(200, chainPayload([{ strikePrice: 24500, CE: leg() }], {
    records: { underlying: "NIFTY", timestamp: "2026-08-13T10:00:00+05:30", underlyingValue: 24500, data: [{ strikePrice: 24500, CE: leg() }] },
  })));
  const chainResult = await chain.api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "28-Aug-2026" });
  assert.equal(chainResult.sourceTimestamp, "2026-08-13T10:00:00+05:30");

  const invalidChain = provider(response(200, chainPayload([{ strikePrice: 24500, CE: leg() }], {
    records: { underlying: "NIFTY", timestamp: "2026-08-13T10:00:00+25:00", underlyingValue: 24500, data: [{ strikePrice: 24500, CE: leg() }] },
  })));
  const invalidChainResult = await invalidChain.api.getOptionChain({ market: "index", symbol: "NIFTY", expiry: "28-Aug-2026" });
  assert.equal(invalidChainResult.sourceTimestamp, null);

  for (const timestamp of ["13-Aug-2026 25:00:00", "31-Apr-2026 10:00:00", "2026-08-13T10:00:00", "2026-08-13T10:00:00+25:00"]) {
    const invalid = provider(response(200, JSON.stringify({ records: { expiryDates: ["28-Aug-2026"], timestamp } })));
    const result = await invalid.api.getContracts({ market: "index", symbol: "NIFTY" });
    assert.equal(result.sourceTimestamp, null);
  }
});

test("response classification checks status, content type, then parses its body once", async () => {
  const cases = [
    [response(200, "<html>blocked</html>", "text/html"), "NON_JSON_RESPONSE", null],
    [response(200, "{}", "text/json"), "NON_JSON_RESPONSE", null],
    [response(200, "{}", "application/problem+json; charset=utf-8"), "SCHEMA_ERROR", 1],
    [response(200, "{", "application/json; charset=utf-8"), "MALFORMED_JSON", 1],
    [response(401, "secret"), "UPSTREAM_BLOCKED", 0],
    [response(403, "secret"), "UPSTREAM_BLOCKED", 0],
    [response(404, "secret"), "NOT_FOUND", 0],
    [response(429, "secret", "application/json", { "retry-after": "30" }), "RATE_LIMITED", 0],
    [response(503, "secret"), "UPSTREAM_HTTP", 0],
  ];
  for (const [upstream, code, reads] of cases) {
    const { api } = provider(upstream);
    await assert.rejects(api.getContracts({ market: "index", symbol: "NIFTY" }), (error) => {
      assert.equal(error.code, code);
      if (code === "RATE_LIMITED") assert.equal(error.retryAfter, "30");
      assert.equal(error.details, null);
      return true;
    });
    if (reads != null) assert.equal(upstream.reads, reads);
  }
  const dateRetry = provider(response(429, "secret", "application/json", { "retry-after": " Wed, 21 Oct 2015 07:28:00 GMT " }));
  await assert.rejects(dateRetry.api.getContracts({ market: "index", symbol: "NIFTY" }), (error) => error.code === "RATE_LIMITED" && error.retryAfter === "Wed, 21 Oct 2015 07:28:00 GMT");
});

test("transport errors retain only the cause and no response payload", async () => {
  const api = createNseDerivatives({
    base: "https://www.nseindia.com",
    config: { contractInfoEndpoint: "/api/contracts", optionChainEndpoint: "/api/chain", referer: "/", enabledSymbols: ["NIFTY"] },
    fetchResponse: async () => { throw new Error("offline"); },
  });
  await assert.rejects(api.getContracts({ market: "index", symbol: "NIFTY" }), (error) => error.code === "TRANSPORT_ERROR" && error.retryable && error.cause.message === "offline");
});

test("rejects Response-like values without a consistent boolean ok", async () => {
  const malformed = {
    status: 200,
    ok: "true",
    headers: { get() { return "application/json"; } },
    async text() { return "{}"; },
  };
  const { api } = provider(malformed);
  await assert.rejects(api.getContracts({ market: "index", symbol: "NIFTY" }), (error) => error.code === "TRANSPORT_ERROR");
  const inconsistent = provider({ ...malformed, ok: false });
  await assert.rejects(inconsistent.api.getContracts({ market: "index", symbol: "NIFTY" }), (error) => error.code === "TRANSPORT_ERROR");
});
