"use strict";

class DerivativeAlertDemands {
  constructor({ alerts, derivativesService, logWarn = () => {} }) {
    this.alerts = alerts;
    this.derivativesService = derivativesService;
    this.logWarn = logWarn;
    this.demands = new Map();
  }

  sync() {
    const identities = new Map();
    for (const alert of this.alerts.list()) {
      const symbol = String(alert.symbol || "").trim().toUpperCase();
      if (!symbol) continue;
      if (alert.market === "stock-future") {
        identities.set(`future:stock:${symbol}`, { kind: "stock-future", symbol });
      } else if (alert.market === "index-future") {
        identities.set(`future:index:${symbol}`, { kind: "index-future", symbol });
      } else if (["index-option", "stock-option"].includes(alert.market)) {
        const market = alert.market === "index-option" ? "index" : "equity";
        const expiry = String(alert.contractExpiry || "");
        if (expiry) identities.set(`${market}:${symbol}:${expiry}`, { kind: "option", market, symbol, expiry });
      }
    }
    for (const [key, identity] of identities) {
      if (this.demands.has(key)) continue;
      try {
        this.demands.set(
          key,
          identity.kind === "stock-future"
            ? this.derivativesService.addStockFuturesDemand({ symbol: identity.symbol })
            : identity.kind === "index-future"
              ? this.derivativesService.addFuturesDemand({ market: "index", symbol: identity.symbol })
            : this.derivativesService.addDemand(identity),
        );
      } catch (error) {
        this.logWarn("derivative-alert-demand", `${key}: ${(error && error.message) || error}`);
      }
    }
    for (const [key, demand] of this.demands) {
      if (identities.has(key)) continue;
      demand.release();
      this.demands.delete(key);
    }
  }

  close() {
    for (const demand of this.demands.values()) demand.release();
    this.demands.clear();
  }
}

module.exports = { DerivativeAlertDemands };
