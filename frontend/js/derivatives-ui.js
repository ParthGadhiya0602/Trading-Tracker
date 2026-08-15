// Read-only F&O workspace. It owns one selected-chain EventSource and keeps
// server envelopes atomic; no client polling or patch merging is performed.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let instrument = "options", optionMarket = "index", futuresMarket = "index", indexSymbol = "NIFTY", equitySymbol = "", stockFutureSymbol = "", commodityFutureSymbol = "", commodityOptionSymbol = "", symbol = "NIFTY";
  let expiry = null, stream = null, generation = 0, sequence = -1;
  let snapshot = null, analysis = null, active = false, bound = false, centerOnNext = false, hiddenTimer = null, futuresAvailable = false;
  let stockFutureOptionsSig = "", commodityOptionsSig = "", commodityOptSig = ""; // track datalist option sets to avoid rebuilds
  const expandedStrikes = new Set();
  const equitySymbols = new Set();
  const commoditySymbols = new Set();
  const isFuturesIndex = () => instrument === "futures" && futuresMarket === "index";
  const isFuturesStock = () => instrument === "futures" && futuresMarket === "stock";
  const isFuturesCommodity = () => instrument === "futures" && futuresMarket === "commodity";
  const activeFuturesSymbol = () => isFuturesCommodity() ? commodityFutureSymbol : stockFutureSymbol;

  async function api(path) {
    const res = await fetch(path, { headers: { "X-Requested-With": "XMLHttpRequest" } });
    const text = await res.text(); let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (res.status === 401 && window.__onAuthExpired) window.__onAuthExpired();
    if (!res.ok || data.error) { const error = new Error(data.error || `HTTP ${res.status}`); error.status = res.status; throw error; }
    return data;
  }
  const numeric = (value, digits = 0) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const finite = (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  const percent = (value) => value == null || !Number.isFinite(Number(value)) ? "—" : `${numeric(value, 2)}%`;
  const price = (value) => numeric(value, 2);
  const time = (value) => value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" }) : "Unavailable";
  const retry = (value) => value ? ` Retry after ${time(value)}.` : "";
  function stateCopy(envelope) {
    const state = envelope && envelope.state || "loading";
    const labels = { loading: "Loading selected chain…", live: "Live source snapshot.", partial: "Partial source snapshot: one or more option legs are unavailable.", stale: "Stale snapshot retained; source is delayed.", closed: "Market closed; last available snapshot retained.", blocked: "Source temporarily blocked; last available snapshot retained.", "rate-limited": "Source rate limit reached; last available snapshot retained.", error: "Source error; last available snapshot retained." };
    return labels[state] || "Snapshot status unavailable.";
  }
  function stateClass(envelope) { return `fo-state ${envelope && envelope.state || "loading"}`; }
  function setState(envelope, fallback) {
    const node = $("#foState"); if (!node) return;
    node.className = stateClass(envelope);
    node.textContent = fallback || stateCopy(envelope) + retry(envelope && envelope.retryAt);
  }
  function closeStream() { generation += 1; if (stream) stream.close(); stream = null; }
  function selectedMarket() { return instrument === "futures" ? (futuresMarket === "stock" ? "stock" : futuresMarket === "commodity" ? "commodity" : "index") : optionMarket; }
  function optionApiPath(name) { return optionMarket === "equity" ? `/api/derivatives/equities/${name}` : optionMarket === "commodity" ? `/api/derivatives/commodities/${name}` : `/api/derivatives/${name}`; }
  function selectedUrl(path) {
    const params = new URLSearchParams({ symbol }); // stock-futures/index-futures send symbol only
    if (instrument === "options") params.set("expiry", expiry);
    return `${path}?${params}`;
  }
  function clearExpiry(message) {
    const select = $("#foExpiry");
    select.disabled = true;
    select.innerHTML = `<option>${esc(message)}</option>`;
  }
  function resetSelection() { closeStream(); sequence = -1; snapshot = null; analysis = null; centerOnNext = true; expandedStrikes.clear(); render(); }

  async function loadContracts() {
    closeStream(); expiry = null; snapshot = null; analysis = null; sequence = -1; centerOnNext = true; expandedStrikes.clear();
    const mine = generation;
    const select = $("#foExpiry"); select.disabled = true; select.innerHTML = "<option>Loading expiries…</option>";
    setState({ state: "loading" }, `Loading ${symbol} expiries…`); render();
    try {
      const contracts = await api(`${optionApiPath("contracts")}?symbol=${encodeURIComponent(symbol)}`);
      const expiries = Array.isArray(contracts.expiries) ? contracts.expiries : [];
      if (!active || mine !== generation) return;
      if (!expiries.length) { select.innerHTML = "<option>No expiries available</option>"; setState({ state: "error" }, "No expiries are available for this symbol."); return; }
      expiry = expiries[0].expiry;
      select.innerHTML = expiries.map((entry) => `<option value="${esc(entry.expiry)}">${esc(entry.expiry)}</option>`).join("");
      select.disabled = false; openStream();
    } catch (error) {
      if (!active || mine !== generation) return;
      select.innerHTML = "<option>Expiries unavailable</option>";
      setState({ state: error.status === 429 ? "rate-limited" : error.status === 503 ? "blocked" : "error" }, `Could not load expiries. ${error.message}`);
    }
  }
  async function loadEquitySymbols() {
    closeStream(); expiry = null; snapshot = null; analysis = null; sequence = -1; centerOnNext = true; expandedStrikes.clear();
    const mine = generation, input = $("#foEquity"), list = $("#foEquitySymbols");
    input.disabled = true;
    clearExpiry("Select a stock first");
    setState({ state: "loading" }, "Loading stock-option symbols…");
    render();
    try {
      const result = await api("/api/derivatives/equities");
      if (!active || mine !== generation) return;
      const symbols = Array.isArray(result.symbols) ? result.symbols : [];
      equitySymbols.clear();
      for (const value of symbols) if (typeof value === "string") equitySymbols.add(value);
      list.innerHTML = [...equitySymbols].map((value) => `<option value="${esc(value)}"></option>`).join("");
      input.disabled = false;
      if (equitySymbol && equitySymbols.has(equitySymbol)) {
        input.value = equitySymbol;
        symbol = equitySymbol;
        void loadContracts();
      } else {
        equitySymbol = ""; symbol = ""; input.value = "";
        setState({ state: "loading" }, "Select a stock symbol to load its option contracts.");
        render();
      }
    } catch (error) {
      if (!active || mine !== generation) return;
      setState({ state: error.status === 429 ? "rate-limited" : error.status === 503 ? "blocked" : "error" }, `Could not load stock symbols. ${error.message}`);
    }
  }
  async function loadCommoditySymbols() {
    closeStream(); expiry = null; snapshot = null; analysis = null; sequence = -1; centerOnNext = true; expandedStrikes.clear();
    const mine = generation, input = $("#foCommodity"), list = $("#foCommoditySymbols");
    input.disabled = true;
    clearExpiry("Select a commodity first");
    setState({ state: "loading" }, "Loading commodity symbols…");
    render();
    try {
      const result = await api("/api/derivatives/commodities");
      if (!active || mine !== generation) return;
      const symbols = Array.isArray(result.symbols) ? result.symbols.map((x) => (x && x.symbol) || x).filter((v) => typeof v === "string") : [];
      commoditySymbols.clear();
      for (const value of symbols) commoditySymbols.add(value);
      if (commodityOptSig !== symbols.join(",")) { commodityOptSig = symbols.join(","); list.innerHTML = [...commoditySymbols].map((value) => `<option value="${esc(value)}"></option>`).join(""); }
      input.disabled = false;
      if (commodityOptionSymbol && commoditySymbols.has(commodityOptionSymbol)) {
        input.value = commodityOptionSymbol; symbol = commodityOptionSymbol; void loadContracts();
      } else {
        commodityOptionSymbol = ""; symbol = ""; input.value = "";
        setState({ state: "loading" }, "Select a commodity to load its option contracts.");
        render();
      }
    } catch (error) {
      if (!active || mine !== generation) return;
      setState({ state: error.status === 429 ? "rate-limited" : error.status === 503 ? "blocked" : "error" }, `Could not load commodities. ${error.message}`);
    }
  }
  async function loadFutures() {
    closeStream(); expiry = null; snapshot = null; analysis = null; sequence = -1; centerOnNext = false; expandedStrikes.clear();
    futuresAvailable = false;
    const mine = generation;
    setState({ state: "loading" }, `Loading ${symbol} futures…`);
    render();
    try {
      const status = await api("/api/derivatives/status");
      if (!active || mine !== generation) return;
      if (!(status.config && status.config.futuresEnabled)) {
        setState({ state: "error" }, "Index futures are disabled. Enable DERIVATIVES_FUTURES_ENABLED and restart the server.");
        return;
      }
      futuresAvailable = true;
      openStream();
    } catch (error) {
      if (!active || mine !== generation) return;
      setState({ state: error.status === 429 ? "rate-limited" : error.status === 503 ? "blocked" : "error" }, `Could not load index futures. ${error.message}`);
    }
  }
  function loadStockFutures() {
    closeStream(); expiry = null; snapshot = null; analysis = null; sequence = -1; centerOnNext = false; expandedStrikes.clear();
    futuresAvailable = false;
    const mine = generation;
    setState({ state: "loading" }, "Loading stock list…");
    render();
    // Stock list is the same equity master used by options; pick a stock -> its futures strip.
    Promise.all([api("/api/derivatives/status"), api("/api/derivatives/equities")]).then(([status, eq]) => {
      if (!active || mine !== generation) return;
      if (!(status.config && status.config.futuresEnabled)) {
        setState({ state: "error" }, "Stock futures are disabled. Enable DERIVATIVES_FUTURES_ENABLED and restart the server.");
        return;
      }
      const list = Array.isArray(eq.symbols) ? eq.symbols.filter((v) => typeof v === "string").sort((a, b) => a.localeCompare(b)) : [];
      equitySymbols.clear();
      for (const value of list) equitySymbols.add(value);
      futuresAvailable = true;
      syncStockDropdown(list); // defaults stockFutureSymbol to the first stock if unset
      if (stockFutureSymbol && equitySymbols.has(stockFutureSymbol)) {
        symbol = stockFutureSymbol;
        openStream();
      } else {
        symbol = "";
        setState({ state: "loading" }, "Select a stock to load its futures.");
        render();
      }
    }).catch((error) => {
      if (!active || mine !== generation) return;
      setState({ state: error.status === 429 ? "rate-limited" : error.status === 503 ? "blocked" : "error" }, `Could not load stock futures. ${error.message}`);
    });
  }
  function syncCommodityDropdown(symbols) {
    const input = $("#foFutureCommodity"), list = $("#foFutureCommoditySymbols");
    if (!input || !list) return;
    const sig = symbols.join(",");
    if (sig !== commodityOptionsSig) {
      commodityOptionsSig = sig;
      list.innerHTML = symbols.map((s) => `<option value="${esc(s)}"></option>`).join("");
      input.disabled = !symbols.length;
    }
    if (commodityFutureSymbol && input.value !== commodityFutureSymbol) input.value = commodityFutureSymbol;
  }
  function loadCommodityFutures() {
    closeStream(); expiry = null; snapshot = null; analysis = null; sequence = -1; centerOnNext = false; expandedStrikes.clear();
    futuresAvailable = false;
    const mine = generation;
    setState({ state: "loading" }, "Loading commodity list…");
    render();
    api("/api/derivatives/commodities").then((result) => {
      if (!active || mine !== generation) return;
      const list = Array.isArray(result.symbols) ? result.symbols.map((x) => (x && x.symbol) || x).filter((v) => typeof v === "string").sort((a, b) => a.localeCompare(b)) : [];
      commoditySymbols.clear();
      for (const value of list) commoditySymbols.add(value);
      futuresAvailable = true;
      syncCommodityDropdown(list);
      if (commodityFutureSymbol && commoditySymbols.has(commodityFutureSymbol)) { symbol = commodityFutureSymbol; openStream(); }
      else { symbol = ""; setState({ state: "loading" }, "Select a commodity to load its futures."); render(); }
    }).catch((error) => {
      if (!active || mine !== generation) return;
      setState({ state: error.status === 429 ? "rate-limited" : error.status === 503 ? "blocked" : "error" }, `Could not load commodities. ${error.message}`);
    });
  }
  function loadSelected() {
    if (isFuturesIndex()) void loadFutures();
    else if (isFuturesStock()) void loadStockFutures();
    else if (isFuturesCommodity()) void loadCommodityFutures();
    else if (optionMarket === "equity" && !equitySymbols.size) void loadEquitySymbols();
    else if (optionMarket === "commodity" && !commoditySymbols.size) void loadCommoditySymbols();
    else if (symbol) void loadContracts();
    else { resetSelection(); clearExpiry("Select a stock first"); setState({ state: "loading" }, "Select a stock symbol to load its option contracts."); }
  }
  function openStream() {
    if (!active || (instrument === "options" && !expiry) || (instrument === "futures" && !futuresAvailable) || ((isFuturesStock() || isFuturesCommodity()) && !symbol) || !navigator.onLine || document.hidden || !window.EventSource) return;
    closeStream(); const mine = generation;
    sequence = -1; // a fresh subscription must accept the server's first snapshot regardless of any prior chain's sequence
    const subject = isFuturesIndex() ? "index futures" : isFuturesStock() ? "stock futures" : isFuturesCommodity() ? "commodity futures" : "option chain";
    setState({ state: "loading" }, snapshot ? `Refreshing ${subject}; last snapshot remains visible.` : `Loading ${subject}…`);
    const path = isFuturesCommodity() ? "/api/derivatives/commodity-futures/stream" : isFuturesStock() ? "/api/derivatives/stock-futures/stream" : isFuturesIndex() ? "/api/derivatives/futures/stream" : optionApiPath("stream");
    const es = stream = new EventSource(selectedUrl(path));
    es.addEventListener("snapshot", (event) => receive(event, mine));
    es.addEventListener("status", (event) => receive(event, mine));
    es.onerror = () => { if (mine === generation && active) setState(snapshot || { state: "error" }, "Stream reconnecting; last snapshot remains visible."); };
  }
  function receive(event, mine) {
    if (mine !== generation || !active) return;
    let next; try { next = JSON.parse(event.data); } catch (_) { return; }
    const nextSequence = Number(next && next.sequence), isSnapshot = event.type === "snapshot";
    const expectedKind = isFuturesIndex() ? "index-futures" : isFuturesStock() ? "stock-futures" : isFuturesCommodity() ? "commodity-futures" : "option-chain";
    if (!next || next.kind !== expectedKind || next.market !== selectedMarket() || next.symbol !== symbol || (instrument === "options" && next.expiry !== expiry) || !Number.isFinite(nextSequence) || (isSnapshot ? nextSequence <= sequence : nextSequence < sequence)) return;
    sequence = Math.max(sequence, nextSequence);
    if (next.data && Array.isArray(next.data.rows) && next.data.rows.length) snapshot = next;
    else if (snapshot) snapshot = { ...snapshot, ...next, data: snapshot.data };
    else snapshot = next;
    setState(snapshot); render();
    if (isSnapshot && snapshot.data && instrument === "options") void loadAnalysis(mine, nextSequence, selectedMarket(), symbol, expiry);
  }
  async function loadAnalysis(mine, expectedSequence, expectedMarket, expectedSymbol, expectedExpiry) {
    try {
      const path = expectedMarket === "equity" ? "/api/derivatives/equities/analysis" : expectedMarket === "commodity" ? "/api/derivatives/commodities/analysis" : "/api/derivatives/analysis";
      const next = await api(`${path}?symbol=${encodeURIComponent(expectedSymbol)}&expiry=${encodeURIComponent(expectedExpiry)}`);
      if (mine !== generation || expectedMarket !== selectedMarket() || expectedSymbol !== symbol || expectedExpiry !== expiry || Number(next.sequence) !== expectedSequence || sequence !== expectedSequence) return;
      analysis = next;
      render();
      if (centerOnNext) { centerOnNext = false; requestAnimationFrame(centerAtm); }
    } catch (_) { /* chain state is still usable */ }
  }
  function fact(label, value, detail = "") { return `<div class="fo-fact"><span>${esc(label)}</span><strong>${value}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</div>`; }
  function renderFacts() {
    const host = $("#foFacts"), meta = $("#foFactsMeta"); if (!host) return;
    if (isFuturesStock() || isFuturesCommodity()) {
      const commodity = isFuturesCommodity();
      const rows = snapshot && snapshot.data && Array.isArray(snapshot.data.rows) ? snapshot.data.rows : [];
      meta.textContent = snapshot ? `Source ${time(snapshot.sourceTimestamp || snapshot.receivedAt)}` : "";
      if (!rows.length) { host.innerHTML = '<span class="fo-empty">Facts unavailable for this source snapshot.</span>'; return; }
      const near = rows[0]; // nearest expiry
      host.innerHTML = [
        fact(commodity ? "Commodity" : "Stock", activeFuturesSymbol() || "—"),
        commodity ? fact("Category", (snapshot.data && snapshot.data.category) || near.category || "—") : fact("Underlying", near ? price(near.underlyingValue) : "—"),
        commodity ? fact("Unit", (snapshot.data && snapshot.data.unit) || near.unit || "—") : fact("Expiries", numeric(rows.length)),
        fact("Near expiry", near ? esc(near.expiry) : "—"),
        fact("Near LTP", near ? price(near.lastPrice) : "—"),
        fact("Near OI", near ? numeric(near.openInterest) : "—"),
      ].join("");
      return;
    }
    if (isFuturesIndex()) {
      const rows = snapshot && snapshot.data && Array.isArray(snapshot.data.rows) ? snapshot.data.rows : [];
      meta.textContent = snapshot ? `Source ${time(snapshot.sourceTimestamp || snapshot.receivedAt)}` : "";
      if (!rows.length) { host.innerHTML = '<span class="fo-empty">Facts unavailable for this source snapshot.</span>'; return; }
      const near = rows[0], futuresPrice = finite(near.lastPrice), underlying = finite(near.underlyingValue);
      const basisValue = futuresPrice == null || underlying == null ? null : futuresPrice - underlying;
      const basisPercent = basisValue != null && underlying ? basisValue / underlying * 100 : null;
      host.innerHTML = [
        fact("Underlying", price(near.underlyingValue)), fact("Near expiry", esc(near.expiry)),
        fact("Near futures LTP", price(near.lastPrice)), fact("Basis", basisValue == null ? "Unavailable" : price(basisValue)),
        fact("Basis %", basisPercent == null ? "Unavailable" : percent(basisPercent)), fact("Open interest", numeric(near.openInterest)),
        fact("Volume", numeric(near.volume)), fact("Day range", `${price(near.lowPrice)} – ${price(near.highPrice)}`),
        fact("Contracts", numeric(rows.length)),
      ].join("");
      return;
    }
    const facts = analysis && analysis.facts;
    const liquidity = analysis && analysis.diagnostics && analysis.diagnostics.liquidity;
    meta.textContent = snapshot ? `Source ${time(snapshot.sourceTimestamp || snapshot.receivedAt)}` : "";
    if (!facts) { host.innerHTML = '<span class="fo-empty">Facts unavailable for this source snapshot.</span>'; return; }
    const highest = (entry) => entry ? `${numeric(entry.value)} @ ${numeric(entry.strike)}` : "Unavailable";
    host.innerHTML = [
      fact("Underlying", price(facts.underlying)), fact("ATM", facts.atm ? numeric(facts.atm.strike) : "Unavailable"),
      fact("PCR · OI", facts.pcr && facts.pcr.openInterest && facts.pcr.openInterest.value != null ? numeric(facts.pcr.openInterest.value, 2) : "Unavailable"), fact("PCR · volume", facts.pcr && facts.pcr.volume && facts.pcr.volume.value != null ? numeric(facts.pcr.volume.value, 2) : "Unavailable"),
      fact("Max pain", facts.maxPain ? numeric(facts.maxPain.strike) : "Unavailable"), fact("Highest call OI", highest(facts.highestOpenInterest && facts.highestOpenInterest.call)),
      fact("Highest put OI", highest(facts.highestOpenInterest && facts.highestOpenInterest.put)), fact("Call ΔOI", highest(facts.highestChangeInOpenInterest && facts.highestChangeInOpenInterest.call)),
      fact("Put ΔOI", highest(facts.highestChangeInOpenInterest && facts.highestChangeInOpenInterest.put)), fact("ATM IV C / P / skew", facts.atmImpliedVolatility ? `${percent(facts.atmImpliedVolatility.call)} / ${percent(facts.atmImpliedVolatility.put)} / ${percent(facts.atmImpliedVolatility.putMinusCall)}` : "Unavailable"),
      fact("Leg coverage", liquidity ? `C ${numeric(liquidity.callLegs)} · P ${numeric(liquidity.putLegs)}` : "Unavailable", liquidity ? `OI ${numeric(liquidity.oiAvailableLegs)} · volume ${numeric(liquidity.volumeAvailableLegs)} available · invalid OI ${numeric(liquidity.invalidOi)} · volume ${numeric(liquidity.invalidVolume)}` : ""),
    ].join("");
  }
  function cells(leg, call) {
    const value = (key, cls, formatter = numeric) => `<td class="${cls} num">${formatter(leg && leg[key])}</td>`;
    const values = [value("openInterest", "fo-oi"), value("changeInOpenInterest", "fo-change"), value("volume", "fo-volume"), value("impliedVolatility", "fo-iv", percent), value("bidPrice", "fo-bid", price), value("askPrice", "fo-ask", price), value("lastPrice", "fo-ltp", price)];
    return (call ? values : values.slice().reverse()).join("");
  }
  function renderOptions() {
    const body = $("#foBody"), meta = $("#foChainMeta"), wrap = $("#foTableWrap");
    const preservedScroll = wrap && !centerOnNext ? wrap.scrollTop : null;
    if (!snapshot || !snapshot.data || !Array.isArray(snapshot.data.rows)) { body.innerHTML = '<tr><td colspan="15" class="fo-empty">Loading option chain…</td></tr>'; meta.textContent = ""; return; }
    const atm = analysis && analysis.facts && analysis.facts.atm && analysis.facts.atm.strike;
    const rows = snapshot.data.rows.slice().sort((a, b) => Number(a.strike) - Number(b.strike));
    const diagnostics = snapshot.diagnostics || {};
    const missingCalls = Number(diagnostics.missingCallLegs) || 0, missingPuts = Number(diagnostics.missingPutLegs) || 0;
    const validRows = Number(diagnostics.validRows) || rows.length, totalRows = Number(diagnostics.totalRows) || rows.length;
    meta.textContent = `${rows.length} visible strikes · ${validRows}/${totalRows} source-valid · missing legs: C ${missingCalls}, P ${missingPuts}`;
    body.innerHTML = rows.map((row, index) => {
      const strikeKey = String(row.strike), isAtm = Number(row.strike) === Number(atm), id = `fo-detail-${index}`;
      const expanded = expandedStrikes.has(strikeKey);
      return `<tr class="fo-data-row${isAtm ? " fo-atm" : ""}${expanded ? " is-expanded" : ""}" data-strike="${esc(strikeKey)}" data-detail="${id}" tabindex="0" aria-expanded="${expanded}" aria-controls="${id}">${cells(row.call, true)}<td class="fo-strike">${numeric(row.strike)}${isAtm ? ' <span class="fo-atm-badge">ATM</span>' : ""}</td>${cells(row.put, false)}</tr><tr id="${id}" class="fo-detail-row"${expanded ? "" : " hidden"}><td colspan="15"><dl><div><dt>Call ΔOI</dt><dd>${numeric(row.call && row.call.changeInOpenInterest)}</dd></div><div><dt>Put ΔOI</dt><dd>${numeric(row.put && row.put.changeInOpenInterest)}</dd></div><div><dt>Call volume</dt><dd>${numeric(row.call && row.call.volume)}</dd></div><div><dt>Put volume</dt><dd>${numeric(row.put && row.put.volume)}</dd></div><div><dt>Call IV</dt><dd>${percent(row.call && row.call.impliedVolatility)}</dd></div><div><dt>Put IV</dt><dd>${percent(row.put && row.put.impliedVolatility)}</dd></div><div><dt>Call bid / ask</dt><dd>${price(row.call && row.call.bidPrice)} / ${price(row.call && row.call.askPrice)}</dd></div><div><dt>Put bid / ask</dt><dd>${price(row.put && row.put.bidPrice)} / ${price(row.put && row.put.askPrice)}</dd></div></dl></td></tr>`;
    }).join("");
    if (wrap && preservedScroll != null) wrap.scrollTop = preservedScroll;
  }
  function renderFutures() {
    const body = $("#foFutureBody"), meta = $("#foChainMeta"), wrap = $("#foFuturesTableWrap");
    const preservedScroll = wrap ? wrap.scrollTop : 0;
    const rows = snapshot && snapshot.data && Array.isArray(snapshot.data.rows) ? snapshot.data.rows : [];
    if (!rows.length) { body.innerHTML = '<tr><td colspan="11" class="fo-empty">Loading index futures…</td></tr>'; meta.textContent = ""; return; }
    meta.textContent = `${rows.length} contracts · nearest expiry first`;
    body.innerHTML = rows.map((row) => {
      const futuresPrice = finite(row.lastPrice), underlying = finite(row.underlyingValue);
      const basis = futuresPrice == null || underlying == null ? null : futuresPrice - underlying;
      const change = finite(row.change), changeClass = change > 0 ? "up" : change < 0 ? "down" : "";
      return `<tr><td>${esc(row.expiry)}</td><td class="num">${price(row.lastPrice)}</td><td class="num ${changeClass}">${price(row.change)}</td><td class="num ${changeClass}">${percent(row.percentChange)}</td><td class="num fo-future-ohl">${price(row.openPrice)}</td><td class="num fo-future-ohl">${price(row.highPrice)}</td><td class="num fo-future-ohl">${price(row.lowPrice)}</td><td class="num">${price(row.underlyingValue)}</td><td class="num">${basis == null ? "—" : price(basis)}</td><td class="num fo-future-activity">${numeric(row.openInterest)}</td><td class="num fo-future-activity">${numeric(row.volume)}</td></tr>`;
    }).join("");
    wrap.scrollTop = preservedScroll;
  }
  function render() {
    const optionWrap = $("#foTableWrap"), futuresWrap = $("#foFuturesTableWrap"), stockFuturesWrap = $("#foStockFuturesTableWrap"), marketControl = $("#foOptionMarketSeg"), futureMarketControl = $("#foFutureMarketSeg"), indexControl = $("#foIndexControl"), equityControl = $("#foEquityControl"), commodityControl = $("#foCommodityControl"), futureStockControl = $("#foFutureStockControl"), futureCommodityControl = $("#foFutureCommodityControl"), expiryControl = $("#foExpiryControl"), center = $("#foCenter"), title = $("#foChainTitle"), source = $("#foSource");
    const options = instrument === "options";
    const futures = instrument === "futures";
    const fIndex = isFuturesIndex();
    const fStock = isFuturesStock();
    const fCommodity = isFuturesCommodity();
    const perSymbolFutures = fStock || fCommodity; // both use the same strip table
    const set = (el, hidden) => { if (el) el.hidden = hidden; }; // null-safe: a missing node never breaks the whole render
    set(marketControl, !options);                // Options: Index / Stocks / Commodity toggle
    set(futureMarketControl, !futures);          // Futures: Index / Stock / Commodity toggle
    set(indexControl, !((options && optionMarket === "index") || fIndex)); // index dropdown: index-options OR index-futures
    set(equityControl, !(options && optionMarket === "equity"));
    set(commodityControl, !(options && optionMarket === "commodity")); // commodity option search
    set(futureStockControl, !fStock);            // stock search: stock-futures only
    set(futureCommodityControl, !fCommodity);    // commodity search: commodity-futures only
    set(optionWrap, !options);
    set(futuresWrap, !fIndex);
    set(stockFuturesWrap, !perSymbolFutures);
    set(expiryControl, !options);
    set(center, !options);
    if (center) center.disabled = !options || !(snapshot && snapshot.data);
    if (title) title.textContent = fIndex ? "Index futures" : fStock ? "Stock futures" : fCommodity ? "Commodity futures" : "Option chain";
    if (source) source.textContent = snapshot ? `Source: ${time(snapshot.sourceTimestamp || snapshot.receivedAt)}` : "Source: not loaded";
    renderFacts();
    if (fIndex) renderFutures(); else if (perSymbolFutures) renderStockFutures(); else renderOptions();
  }
  // Fill the searchable stock input's datalist (same UX as the option-stock search).
  function syncStockDropdown(symbols) {
    const input = $("#foFutureStock"), list = $("#foFutureStockSymbols");
    if (!input || !list) return;
    const sig = symbols.join(",");
    if (sig !== stockFutureOptionsSig) {
      stockFutureOptionsSig = sig;
      list.innerHTML = symbols.map((s) => `<option value="${esc(s)}"></option>`).join("");
      input.disabled = !symbols.length;
    }
    if (stockFutureSymbol && input.value !== stockFutureSymbol) input.value = stockFutureSymbol;
  }
  function renderStockFutures() {
    const body = $("#foStockFutureBody"), meta = $("#foChainMeta"), wrap = $("#foStockFuturesTableWrap");
    const preservedScroll = wrap ? wrap.scrollTop : 0;
    // Each snapshot is one stock's full expiry strip (the dropdown is populated from the equity list).
    const rows = snapshot && snapshot.data && Array.isArray(snapshot.data.rows) ? snapshot.data.rows : [];
    if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="fo-empty">Loading stock futures…</td></tr>'; meta.textContent = ""; return; }
    meta.textContent = `${activeFuturesSymbol()} · ${rows.length} expir${rows.length === 1 ? "y" : "ies"}`;
    body.innerHTML = rows.map((row) => {
      const change = finite(row.change), changeClass = change > 0 ? "up" : change < 0 ? "down" : "";
      return `<tr><td>${esc(row.symbol)}</td><td>${esc(row.expiry)}</td><td class="num">${price(row.lastPrice)}</td><td class="num ${changeClass}">${price(row.change)}</td><td class="num ${changeClass}">${percent(row.percentChange)}</td><td class="num fo-future-activity">${numeric(row.openInterest)}</td><td class="num fo-future-activity">${numeric(row.volume)}</td></tr>`;
    }).join("");
    wrap.scrollTop = preservedScroll;
  }
  function centerAtm() { const row = $("#foBody .fo-atm"), wrap = $("#foTableWrap"); if (row && wrap) wrap.scrollTop = Math.max(0, row.offsetTop - wrap.clientHeight / 2 + row.offsetHeight / 2); }
  function toggleRow(row) {
    const detail = document.getElementById(row.dataset.detail);
    if (!detail) return;
    const expanded = row.getAttribute("aria-expanded") === "true";
    row.setAttribute("aria-expanded", String(!expanded));
    row.classList.toggle("is-expanded", !expanded);
    detail.hidden = expanded;
    if (expanded) expandedStrikes.delete(row.dataset.strike);
    else expandedStrikes.add(row.dataset.strike);
  }
  function bind() {
    if (bound) return; bound = true;
    const futuresSymbolFor = () => futuresMarket === "stock" ? stockFutureSymbol : futuresMarket === "commodity" ? commodityFutureSymbol : indexSymbol;
    $("#foInstrumentSeg").addEventListener("click", (event) => { const button = event.target.closest("[data-instrument]"); if (!button || button.dataset.instrument === instrument) return; instrument = button.dataset.instrument; symbol = instrument === "futures" ? futuresSymbolFor() : optionMarket === "index" ? indexSymbol : equitySymbol; $$("#foInstrumentSeg .seg").forEach((node) => { const on = node === button; node.classList.toggle("active", on); node.setAttribute("aria-selected", String(on)); }); loadSelected(); });
    $("#foOptionMarketSeg").addEventListener("click", (event) => { const button = event.target.closest("[data-option-market]"); if (!button || button.dataset.optionMarket === optionMarket) return; optionMarket = button.dataset.optionMarket; symbol = optionMarket === "index" ? indexSymbol : optionMarket === "commodity" ? commodityOptionSymbol : equitySymbol; $$("#foOptionMarketSeg .seg").forEach((node) => { const on = node === button; node.classList.toggle("active", on); node.setAttribute("aria-selected", String(on)); }); loadSelected(); });
    $("#foFutureMarketSeg").addEventListener("click", (event) => { const button = event.target.closest("[data-future-market]"); if (!button || button.dataset.futureMarket === futuresMarket) return; futuresMarket = button.dataset.futureMarket; symbol = futuresSymbolFor(); $$("#foFutureMarketSeg .seg").forEach((node) => { const on = node === button; node.classList.toggle("active", on); node.setAttribute("aria-selected", String(on)); }); loadSelected(); });
    $("#foFutureStock").addEventListener("change", (event) => { const value = event.target.value.trim().toUpperCase(); event.target.value = value; if (!equitySymbols.has(value)) { stockFutureSymbol = ""; symbol = ""; resetSelection(); setState({ state: "error" }, "Select a stock from the NSE symbol list."); return; } if (value === stockFutureSymbol && snapshot) return; stockFutureSymbol = value; symbol = value; resetSelection(); openStream(); }); // fetch the chosen stock's futures strip
    $("#foFutureCommodity").addEventListener("change", (event) => { const value = event.target.value.trim().toUpperCase(); event.target.value = value; if (!commoditySymbols.has(value)) { commodityFutureSymbol = ""; symbol = ""; resetSelection(); setState({ state: "error" }, "Select a commodity from the list."); return; } if (value === commodityFutureSymbol && snapshot) return; commodityFutureSymbol = value; symbol = value; resetSelection(); openStream(); }); // fetch the chosen commodity's futures strip
    $("#foSymbol").addEventListener("change", (event) => { if (event.target.value === indexSymbol) return; indexSymbol = event.target.value; if (isFuturesIndex() || (instrument === "options" && optionMarket === "index")) { symbol = indexSymbol; loadSelected(); } });
    $("#foEquity").addEventListener("change", (event) => { const value = event.target.value.trim().toUpperCase(); event.target.value = value; if (!equitySymbols.has(value)) { equitySymbol = ""; symbol = ""; resetSelection(); clearExpiry("Select a stock first"); setState({ state: "error" }, "Select a stock from the NSE symbol list."); return; } if (value === equitySymbol) return; equitySymbol = value; symbol = value; loadSelected(); });
    $("#foCommodity").addEventListener("change", (event) => { const value = event.target.value.trim().toUpperCase(); event.target.value = value; if (!commoditySymbols.has(value)) { commodityOptionSymbol = ""; symbol = ""; resetSelection(); clearExpiry("Select a commodity first"); setState({ state: "error" }, "Select a commodity from the list."); return; } if (value === commodityOptionSymbol) return; commodityOptionSymbol = value; symbol = value; loadSelected(); });
    $("#foExpiry").addEventListener("change", (event) => { expiry = event.target.value; resetSelection(); openStream(); });
    $("#foCenter").addEventListener("click", centerAtm);
    $("#foBody").addEventListener("click", (event) => { const row = event.target.closest(".fo-data-row"); if (row) toggleRow(row); });
    $("#foBody").addEventListener("keydown", (event) => { const row = event.target.closest(".fo-data-row"); if (!row || (event.key !== "Enter" && event.key !== " ")) return; event.preventDefault(); toggleRow(row); });
    window.addEventListener("online", () => { if (active) openStream(); }); window.addEventListener("offline", () => { closeStream(); setState(snapshot || { state: "error" }, "Offline; last available snapshot retained."); });
    window.addEventListener("beforeunload", closeStream);
    document.addEventListener("visibilitychange", () => { if (!active) return; if (document.hidden) hiddenTimer = setTimeout(closeStream, 30000); else { clearTimeout(hiddenTimer); hiddenTimer = null; openStream(); } });
  }
  const $$ = (s) => document.querySelectorAll(s);
  window.__initDerivatives = () => { active = true; bind(); if (!expiry) loadSelected(); else openStream(); };
  window.__stopDerivatives = () => { active = false; clearTimeout(hiddenTimer); hiddenTimer = null; closeStream(); };
})();
