"use strict";

class AlertPriceResolver {
  constructor({ store }) {
    this.store = store;
  }

  resolve(alert, cashPayload = null) {
    if (alert && alert.market === "stock-future") {
      return this.#stockFuture(alert.symbol, alert.contractExpiry);
    }
    if (alert && alert.market === "index-future") {
      return this.#indexFuture(alert.symbol, alert.contractExpiry);
    }
    if (alert && ["index-option", "stock-option"].includes(alert.market)) {
      return this.#option(alert);
    }
    const index = alert && alert.index;
    const symbol = String((alert && alert.symbol) || "").toUpperCase();
    const row =
      ((cashPayload && cashPayload[index] && cashPayload[index].data) || []).find(
        (item) => item && item.symbol === symbol,
      ) || this.store.getStock(symbol);
    return {
      lastPrice: row && Number(row.lastPrice),
      dayHigh: row && Number(row.dayHigh),
      dayLow: row && Number(row.dayLow),
      preopen:
        !!(cashPayload && cashPayload[index]) &&
        cashPayload[index].marketStatus === "Pre-open",
    };
  }

  resolveInput({ market, symbol, contractExpiry, strike, optionType }) {
    if (market === "stock-future")
      return this.#stockFuture(symbol, contractExpiry);
    if (market === "index-future")
      return this.#indexFuture(symbol, contractExpiry);
    if (market === "index-option" || market === "stock-option")
      return this.#option({ market, symbol, contractExpiry, strike, optionType });
    return this.resolve({ market: "cash", symbol });
  }

  enrich(alerts) {
    return (alerts || []).map((alert) => {
      const quote = this.resolve(alert);
      return {
        ...alert,
        currentPrice: Number.isFinite(quote.lastPrice) ? quote.lastPrice : null,
      };
    });
  }

  #stockFuture(symbol, contractExpiry) {
    const normalizedSymbol = String(symbol || "").trim().toUpperCase();
    const expiry = String(contractExpiry || "").trim();
    const snapshot = this.store.derivatives.getSnapshot(
      `future:stock:${normalizedSymbol}`,
    );
    const row =
      snapshot && snapshot.data && Array.isArray(snapshot.data.rows)
        ? snapshot.data.rows.find(
            (item) => item && item.symbol === normalizedSymbol && item.expiry === expiry,
          )
        : null;
    return {
      lastPrice: row && Number(row.lastPrice),
      dayHigh: row && Number(row.highPrice),
      dayLow: row && Number(row.lowPrice),
      preopen: false,
      snapshot,
      row,
    };
  }

  #indexFuture(symbol, contractExpiry) {
    const normalizedSymbol = String(symbol || "").trim().toUpperCase();
    const expiry = String(contractExpiry || "").trim();
    const snapshot = this.store.derivatives.getSnapshot(
      `future:index:${normalizedSymbol}`,
    );
    const row =
      snapshot && snapshot.data && Array.isArray(snapshot.data.rows)
        ? snapshot.data.rows.find((item) => item && item.expiry === expiry)
        : null;
    return {
      lastPrice: row && Number(row.lastPrice),
      dayHigh: row && Number(row.highPrice),
      dayLow: row && Number(row.lowPrice),
      preopen: false,
      snapshot,
      row,
    };
  }

  #option({ market, symbol, contractExpiry, strike, optionType }) {
    const optionMarket = market === "index-option" ? "index" : "equity";
    const normalizedSymbol = String(symbol || "").trim().toUpperCase();
    const expiry = String(contractExpiry || "").trim();
    const numericStrike = Number(strike);
    const legKey = String(optionType || "").toUpperCase() === "PE" ? "put" : "call";
    const snapshot = this.store.derivatives.getSnapshot(
      `${optionMarket}:${normalizedSymbol}:${expiry}`,
    );
    const row =
      snapshot && snapshot.data && Array.isArray(snapshot.data.rows)
        ? snapshot.data.rows.find((item) => item && Number(item.strike) === numericStrike)
        : null;
    const leg = row && row[legKey];
    return {
      lastPrice: leg && Number(leg.lastPrice),
      dayHigh: NaN,
      dayLow: NaN,
      preopen: false,
      snapshot,
      row,
      leg,
    };
  }
}

module.exports = { AlertPriceResolver };
