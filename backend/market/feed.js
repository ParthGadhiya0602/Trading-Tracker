"use strict";

function createMarketFeed({
  alerts,
  base,
  feedConfig,
  indexUrl,
  marketState,
  num,
  requireFeed,
  srcJson,
  store,
}) {
  const dashboardIndices = alerts.INDICES;

  function marketStatusStr(marketStatus) {
    if (!marketStatus) return null;
    if (typeof marketStatus === "string") return marketStatus;
    if (Array.isArray(marketStatus))
      return (marketStatus[0] && marketStatus[0].marketStatus) || null;
    return marketStatus.marketStatus || marketStatus.status || null;
  }

  function buildPayloadNext(rows, level, advance, stamp, status) {
    const data = rows.map((row) => ({
      symbol: row.symbol,
      companyName: row.companyName || null,
      open: num(row.open),
      dayHigh: num(row.dayHigh),
      dayLow: num(row.dayLow),
      lastPrice: num(row.lastPrice),
      prevClose: num(row.previousClose),
      change: num(row.change),
      pChange: num(row.pChange),
      totalTradedVolume: num(row.totalTradedVolume),
      totalTradedValue: num(row.totalTradedValue),
      yearHigh: num(row.yearHigh),
      yearLow: num(row.yearLow),
      nearWKH: num(row.nearWKH),
      nearWKL: num(row.nearWKL),
      perChange30d: num(row.perChange30d),
      perChange365d: num(row.perChange365d),
    }));
    return {
      source: "live",
      timestamp: stamp,
      marketStatus: status,
      marketDataLive: data.length > 0,
      level: level && level.last != null ? level : null,
      advance,
      data,
    };
  }

  async function fetchIndexNext(name) {
    requireFeed();
    const response = await srcJson(indexUrl(name));
    const data = (response && response.data) || {};
    const rows = Array.isArray(data.data) ? data.data : [];
    const index = rows.find((row) => row.symbol === name) || {};
    const stocks = rows.filter((row) => row.symbol && row.symbol !== name);
    if (!stocks.length && !(num(index.lastPrice) > 0))
      throw new Error(`no data for ${name}`);
    const level = {
      last: num(index.lastPrice),
      variation: num(index.change),
      pChange: num(index.pChange),
      open: num(index.open),
      high: num(index.dayHigh),
      low: num(index.dayLow),
      prevClose: num(index.previousClose),
      yearHigh: num(index.yearHigh),
      yearLow: num(index.yearLow),
      perChange30d: num(index.perChange30d),
      perChange365d: num(index.perChange365d),
    };
    const counts = data.aduCount || {};
    const advance = {
      advances: num(counts.advances) || 0,
      declines: num(counts.declines) || 0,
      unchanged: num(counts.unchange) || 0,
    };
    const stamp = index.lastUpdateTime || data.timestamp || null;
    return buildPayloadNext(
      stocks,
      level,
      advance,
      stamp,
      marketStatusStr(data.marketStatus),
    );
  }

  async function fetchAllIndices() {
    const payloads = await Promise.all(
      dashboardIndices.map((name) => fetchIndexNext(name)),
    );
    const output = {};
    dashboardIndices.forEach((name, index) => (output[name] = payloads[index]));
    return output;
  }

  async function fetchPreopen() {
    requireFeed();
    if (!feedConfig.preopenEndpoint)
      throw new Error("pre-open endpoint not configured");
    const response = await srcJson(`${base}${feedConfig.preopenEndpoint}ALL`);
    const rows = (response && response.data) || [];
    const bySymbol = new Map();
    for (const row of rows) {
      const metadata = row && row.metadata;
      if (metadata && metadata.symbol)
        bySymbol.set(metadata.symbol, {
          metadata,
          pom: (row.detail && row.detail.preOpenMarket) || null,
        });
    }
    const stamp = (response && response.timestamp) || null;
    const output = {};
    for (const index of dashboardIndices) {
      const symbols = alerts.symbols()[index] || [];
      const data = [];
      let advances = 0;
      let declines = 0;
      let unchanged = 0;
      for (const symbol of symbols) {
        const entry = bySymbol.get(symbol);
        if (!entry) continue;
        const metadata = entry.metadata;
        const iep = num(metadata.iep);
        const change = num(metadata.change);
        if (change > 0) advances++;
        else if (change < 0) declines++;
        else unchanged++;
        const row = {
          symbol,
          companyName: null,
          open: iep,
          dayHigh: iep,
          dayLow: iep,
          lastPrice: iep,
          prevClose: num(metadata.previousClose),
          change,
          pChange: num(metadata.pChange),
          totalTradedVolume: num(metadata.finalQuantity),
          totalTradedValue: num(metadata.totalTurnover),
          yearHigh: num(metadata.yearHigh),
          yearLow: num(metadata.yearLow),
          nearWKH: null,
          nearWKL: null,
          perChange30d: null,
          perChange365d: null,
        };
        const pom = entry.pom;
        if (pom && Array.isArray(pom.preopen)) {
          const ato = pom.ato || {};
          row.preOpen = {
            iep: num(pom.IEP) != null ? num(pom.IEP) : num(pom.finalPrice),
            ladder: pom.preopen.map((level) => ({
              price: num(level.price),
              buyQty: num(level.buyQty),
              sellQty: num(level.sellQty),
              iep: !!level.iep,
            })),
            totalBuyQty: num(pom.totalBuyQuantity),
            totalSellQty: num(pom.totalSellQuantity),
            ato: {
              buyQty:
                num(pom.atoBuyQty) != null
                  ? num(pom.atoBuyQty)
                  : num(ato.totalBuyQuantity),
              sellQty:
                num(pom.atoSellQty) != null
                  ? num(pom.atoSellQty)
                  : num(ato.totalSellQuantity),
            },
            finalQty: num(pom.finalQuantity),
            lastUpdateTime: pom.lastUpdateTime || null,
          };
        }
        data.push(row);
      }
      output[index] = {
        source: "live",
        timestamp: stamp,
        marketStatus: "Pre-open",
        marketDataLive: data.length > 0,
        level: null,
        advance: { advances, declines, unchanged },
        data,
      };
    }
    return output;
  }

  async function fetchMarketData() {
    return marketState() === "pre-open" ? fetchPreopen() : fetchAllIndices();
  }

  return {
    dashboardIndices,
    marketStatusStr,
    buildPayloadNext,
    fetchIndexNext,
    fetchAllIndices,
    fetchPreopen,
    fetchMarketData,
  };
}

module.exports = { createMarketFeed };
