"use strict";

function createSse({
  derivativesEnabled,
  fanoutMinMs,
  marketState,
  store,
  streamWs,
}) {
  const sseClients = new Set();
  const derivativeSseClients = new Map();
  const stateSseClients = new Set();
  const stateChanges = [];
  let stateRevision = 0;
  let fanoutTimer = null;
  let lastFanoutMs = 0;
  let derivativeFanoutTimer = null;
  let derivativeLastFanoutMs = 0;
  const derivativePendingUpdates = new Map();

  function sseWrite(res, chunk) {
    try {
      if (res.writableEnded) {
        sseClients.delete(res);
        return;
      }
      res.write(chunk);
    } catch (_) {
      sseClients.delete(res);
    }
  }

  function fanoutNow() {
    fanoutTimer = null;
    lastFanoutMs = Date.now();
    if (!(streamWs && marketState() === "open" && sseClients.size > 0))
      return;
    const chunk = `event: patch\ndata: ${JSON.stringify(store.getSnapshot())}\n\n`;
    for (const client of sseClients) sseWrite(client, chunk);
  }

  // Per-message delta push: one WSS tick -> one tiny SSE `delta` event, no coalescing wait.
  // The client merges it into its cached snapshot; the periodic full `patch` (reseed) resyncs.
  function emitCashDelta(tick) {
    if (!tick || !(streamWs && marketState() === "open" && sseClients.size > 0))
      return;
    const chunk = `event: delta\ndata: ${JSON.stringify(tick)}\n\n`;
    for (const client of sseClients) sseWrite(client, chunk);
  }

  function scheduleFanout() {
    if (fanoutTimer) return;
    const since = Date.now() - lastFanoutMs;
    const wait = since >= fanoutMinMs ? 0 : fanoutMinMs - since;
    fanoutTimer = setTimeout(fanoutNow, wait);
    if (fanoutTimer.unref) fanoutTimer.unref();
  }

  function derivativeSseWrite(client, chunk) {
    try {
      if (client.res.writableEnded) return false;
      client.res.write(chunk);
      return true;
    } catch (_) {
      return false;
    }
  }

  function removeDerivativeClient(key, client) {
    const clients = derivativeSseClients.get(key);
    if (!clients || !clients.delete(client)) return;
    if (client.heartbeat) clearInterval(client.heartbeat);
    client.release();
    if (!clients.size) derivativeSseClients.delete(key);
  }

  function derivativeEvent(snapshot, type) {
    const event = type === "status" ? "status" : "snapshot";
    const id = Number.isFinite(snapshot && snapshot.sequence)
      ? `id: ${snapshot.sequence}\n`
      : "";
    return `event: ${event}\n${id}data: ${JSON.stringify(snapshot)}\n\n`;
  }

  // Per-message option-chain delta: one WSS strike frame -> one tiny SSE `delta` event to that
  // key's clients, immediately. The client merges it by strike; the ~5s REST snapshot resyncs.
  function emitDerivativeDelta(delta) {
    if (!derivativesEnabled || !delta || !delta.key) return;
    const clients = derivativeSseClients.get(delta.key);
    if (!clients || !clients.size) return;
    const id = Number.isFinite(delta.sequence) ? `id: ${delta.sequence}\n` : "";
    const chunk = `event: delta\n${id}data: ${JSON.stringify(delta)}\n\n`;
    for (const client of [...clients]) {
      if (!derivativeSseWrite(client, chunk))
        removeDerivativeClient(delta.key, client);
    }
  }

  function fanoutDerivativeNow() {
    derivativeFanoutTimer = null;
    derivativeLastFanoutMs = Date.now();
    for (const [key, type] of derivativePendingUpdates) {
      derivativePendingUpdates.delete(key);
      const clients = derivativeSseClients.get(key);
      const snapshot = store.derivatives.getSnapshot(key);
      if (!clients || !snapshot) continue;
      const chunk = derivativeEvent(snapshot, type);
      for (const client of [...clients]) {
        if (!derivativeSseWrite(client, chunk))
          removeDerivativeClient(key, client);
      }
    }
  }

  function scheduleDerivativeFanout(key, type) {
    if (!derivativesEnabled || !derivativeSseClients.has(key)) return;
    derivativePendingUpdates.set(key, type);
    if (derivativeFanoutTimer) return;
    const since = Date.now() - derivativeLastFanoutMs;
    derivativeFanoutTimer = setTimeout(
      fanoutDerivativeNow,
      Math.max(0, fanoutMinMs - since),
    );
    derivativeFanoutTimer.unref?.();
  }

  function stateSseWrite(client, chunk) {
    try {
      if (client.res.writableEnded) {
        stateSseClients.delete(client);
        return;
      }
      client.res.write(chunk);
    } catch (_) {
      stateSseClients.delete(client);
    }
  }

  function broadcastState(change) {
    const revisioned = { ...change, revision: ++stateRevision };
    stateChanges.push(revisioned);
    if (stateChanges.length > 500) stateChanges.shift();
    const chunk = `event: state\ndata: ${JSON.stringify(revisioned)}\n\n`;
    for (const client of stateSseClients) {
      if (revisioned.userId && revisioned.userId !== client.userId) continue;
      stateSseWrite(client, chunk);
    }
  }

  function close() {
    if (derivativeFanoutTimer) clearTimeout(derivativeFanoutTimer);
    derivativeFanoutTimer = null;
    derivativePendingUpdates.clear();
    for (const [key, clients] of derivativeSseClients) {
      for (const client of [...clients]) removeDerivativeClient(key, client);
    }
  }

  return {
    sseWrite,
    fanoutNow,
    scheduleFanout,
    emitCashDelta,
    derivativeSseWrite,
    removeDerivativeClient,
    derivativeEvent,
    fanoutDerivativeNow,
    scheduleDerivativeFanout,
    emitDerivativeDelta,
    stateSseWrite,
    broadcastState,
    close,
    sseClients,
    derivativeSseClients,
    stateSseClients,
    stateChanges,
    getStateRevision: () => stateRevision,
  };
}

module.exports = { createSse };
