"use strict";

function createMarketLive({
  alertPollMs,
  alerts,
  fetchAllIndices,
  fetchMarketData,
  llm,
  marketState,
  noTick,
  scheduleFanout,
  store,
  storeRefreshMs,
  streamWs,
}) {
  let refreshingStore = false;
  let evaluating = false;

  function seedLiveCache(payload) {
    store.ingestSnapshot(payload);
  }

  function applyTick(tick) {
    store.applyTick(tick);
  }

  async function reseedLiveCache() {
    if (!(streamWs && marketState() === "open")) return;
    try {
      store.ingestSnapshot(await fetchAllIndices());
      scheduleFanout();
    } catch (_) {
      /* transient - keep serving the existing store snapshot */
    }
  }

  async function getMarketData() {
    if (!store.hasData()) {
      try {
        store.ingestSnapshot(await fetchMarketData());
      } catch (_) {
        /* fall through - return whatever the store has (possibly {}) */
      }
    }
    return store.getSnapshot();
  }

  async function refreshStore() {
    if (refreshingStore) return;
    refreshingStore = true;
    try {
      store.ingestSnapshot(await fetchMarketData());
      if (streamWs) scheduleFanout();
    } catch (_) {
      /* transient upstream error - keep the last good snapshot */
    } finally {
      refreshingStore = false;
    }
  }

  function startStoreUpdater() {
    refreshStore();
    setInterval(() => {
      const state = marketState();
      if (streamWs && state === "open") return;
      if (state === "pre-open" || state === "open") refreshStore();
    }, storeRefreshMs);
    setInterval(() => {
      if (marketState() === "closed") refreshStore();
    }, 60_000);
  }

  async function alertTick() {
    const state = marketState();
    if (
      evaluating ||
      noTick ||
      (state !== "open" && state !== "pre-open")
    )
      return;
    evaluating = true;
    try {
      const payload = await getMarketData();
      if (state === "open") alerts.updateSymbols(payload);
      alerts.evaluate(payload);
      if (state === "pre-open" && llm.configured())
        llm.analyze(payload).catch(() => {});
    } catch (_) {
      /* transient network error - try again next tick */
    } finally {
      evaluating = false;
    }
  }

  function startAlertTickLoop() {
    if (noTick) return null;
    return setInterval(alertTick, alertPollMs);
  }

  return {
    seedLiveCache,
    applyTick,
    reseedLiveCache,
    getMarketData,
    refreshStore,
    startStoreUpdater,
    alertTick,
    startAlertTickLoop,
  };
}

module.exports = { createMarketLive };
