// Read-only F&O workspace. It owns one selected-chain EventSource and keeps
// server envelopes atomic; no client polling or patch merging is performed.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let instrument = "options", optionMarket = "index", futuresMarket = "index", indexSymbol = "NIFTY", equitySymbol = "", stockFutureSymbol = "", symbol = "NIFTY";
  let expiry = null, stream = null, generation = 0, sequence = -1;
  let snapshot = null, analysis = null, active = false, bound = false, centerOnNext = false, hiddenTimer = null, futuresAvailable = false;
  let stockFutureOptionsSig = ""; // tracks the dropdown's current option set to avoid rebuilds
  const expandedStrikes = new Set();
  const equitySymbols = new Set();
  const isFuturesIndex = () => instrument === "futures" && futuresMarket === "index";
  const isFuturesStock = () => instrument === "futures" && futuresMarket === "stock";

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
  function selectedMarket() { return instrument === "futures" ? (futuresMarket === "stock" ? "stock" : "index") : optionMarket; }
  function optionApiPath(name) { return optionMarket === "equity" ? `/api/derivatives/equities/${name}` : `/api/derivatives/${name}`; }
  function selectedUrl(path) {
    if (isFuturesStock()) return path; // whole-market watch: no symbol/expiry params
    const params = new URLSearchParams({ symbol });
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
    symbol = "WATCH"; // matches the server envelope's symbol for the stock-futures watch
    const mine = generation;
    setState({ state: "loading" }, "Loading stock futures…");
    render();
    api("/api/derivatives/status").then((status) => {
      if (!active || mine !== generation) return;
      if (!(status.config && status.config.futuresEnabled)) {
        setState({ state: "error" }, "Stock futures are disabled. Enable DERIVATIVES_FUTURES_ENABLED and restart the server.");
        return;
      }
      futuresAvailable = true;
      openStream();
    }).catch((error) => {
      if (!active || mine !== generation) return;
      setState({ state: error.status === 429 ? "rate-limited" : error.status === 503 ? "blocked" : "error" }, `Could not load stock futures. ${error.message}`);
    });
  }
  function loadSelected() {
    if (isFuturesIndex()) void loadFutures();
    else if (isFuturesStock()) void loadStockFutures();
    else if (optionMarket === "equity" && !equitySymbols.size) void loadEquitySymbols();
    else if (symbol) void loadContracts();
    else { resetSelection(); clearExpiry("Select a stock first"); setState({ state: "loading" }, "Select a stock symbol to load its option contracts."); }
  }
  function openStream() {
    if (!active || (instrument === "options" && !expiry) || (instrument === "futures" && !futuresAvailable) || !navigator.onLine || document.hidden || !window.EventSource) return;
    closeStream(); const mine = generation;
    const subject = isFuturesIndex() ? "index futures" : isFuturesStock() ? "stock futures" : "option chain";
    setState({ state: "loading" }, snapshot ? `Refreshing ${subject}; last snapshot remains visible.` : `Loading ${subject}…`);
    const path = isFuturesStock() ? "/api/derivatives/stock-futures/stream" : isFuturesIndex() ? "/api/derivatives/futures/stream" : optionApiPath("stream");
    const es = stream = new EventSource(selectedUrl(path));
    es.addEventListener("snapshot", (event) => receive(event, mine));
    es.addEventListener("status", (event) => receive(event, mine));
    es.onerror = () => { if (mine === generation && active) setState(snapshot || { state: "error" }, "Stream reconnecting; last snapshot remains visible."); };
  }
  function receive(event, mine) {
    if (mine !== generation || !active) return;
    let next; try { next = JSON.parse(event.data); } catch (_) { return; }
    const nextSequence = Number(next && next.sequence), isSnapshot = event.type === "snapshot";
    const expectedKind = isFuturesIndex() ? "index-futures" : isFuturesStock() ? "stock-futures" : "option-chain";
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
      const path = expectedMarket === "equity" ? "/api/derivatives/equities/analysis" : "/api/derivatives/analysis";
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
    if (isFuturesStock()) {
      const all = snapshot && snapshot.data && Array.isArray(snapshot.data.rows) ? snapshot.data.rows : [];
      meta.textContent = snapshot ? `Source ${time(snapshot.sourceTimestamp || snapshot.receivedAt)}` : "";
      if (!all.length) { host.innerHTML = '<span class="fo-empty">Facts unavailable for this source snapshot.</span>'; return; }
      const symbols = new Set(all.map((r) => r.symbol));
      const chosen = stockFutureSymbol && symbols.has(stockFutureSymbol) ? stockFutureSymbol : null;
      const mine = chosen ? all.filter((r) => r.symbol === chosen) : [];
      const near = mine[0];
      host.innerHTML = [
        fact("Selected", chosen || "All"),
        fact("Contracts", numeric(chosen ? mine.length : all.length)),
        fact("Underlyings", numeric(symbols.size)),
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
    const optionWrap = $("#foTableWrap"), futuresWrap = $("#foFuturesTableWrap"), stockFuturesWrap = $("#foStockFuturesTableWrap"), marketControl = $("#foOptionMarketSeg"), futureMarketControl = $("#foFutureMarketSeg"), indexControl = $("#foIndexControl"), equityControl = $("#foEquityControl"), futureStockControl = $("#foFutureStockControl"), expiryControl = $("#foExpiryControl"), center = $("#foCenter"), title = $("#foChainTitle"), source = $("#foSource");
    const options = instrument === "options";
    const futures = instrument === "futures";
    const fIndex = isFuturesIndex();
    const fStock = isFuturesStock();
    marketControl.hidden = !options;             // Options: Index / Stocks toggle
    futureMarketControl.hidden = !futures;       // Futures: Index / Stock toggle
    indexControl.hidden = !((options && optionMarket === "index") || fIndex); // index dropdown: index-options OR index-futures
    equityControl.hidden = !(options && optionMarket === "equity");
    futureStockControl.hidden = !fStock;         // stock dropdown: stock-futures only
    optionWrap.hidden = !options;
    futuresWrap.hidden = !fIndex;
    stockFuturesWrap.hidden = !fStock;
    expiryControl.hidden = !options;
    center.hidden = !options;
    center.disabled = !options || !(snapshot && snapshot.data);
    title.textContent = fIndex ? "Index futures" : fStock ? "Stock futures" : "Option chain";
    source.textContent = snapshot ? `Source: ${time(snapshot.sourceTimestamp || snapshot.receivedAt)}` : "Source: not loaded";
    renderFacts();
    if (fIndex) renderFutures(); else if (fStock) renderStockFutures(); else renderOptions();
  }
  function syncStockDropdown(symbols) {
    const select = $("#foFutureStock");
    if (!select) return;
    const sig = symbols.join(",");
    if (sig !== stockFutureOptionsSig) {
      stockFutureOptionsSig = sig;
      if (!symbols.length) { select.innerHTML = "<option>Loading stocks…</option>"; select.disabled = true; return; }
      if (!stockFutureSymbol || !symbols.includes(stockFutureSymbol)) stockFutureSymbol = symbols[0]; // default to first
      select.innerHTML = symbols.map((s) => `<option value="${esc(s)}"${s === stockFutureSymbol ? " selected" : ""}>${esc(s)}</option>`).join("");
      select.disabled = false;
    } else if (symbols.length && select.value !== stockFutureSymbol) {
      select.value = stockFutureSymbol;
    }
  }
  function renderStockFutures() {
    const body = $("#foStockFutureBody"), meta = $("#foChainMeta"), wrap = $("#foStockFuturesTableWrap");
    const preservedScroll = wrap ? wrap.scrollTop : 0;
    const all = snapshot && snapshot.data && Array.isArray(snapshot.data.rows) ? snapshot.data.rows : [];
    const symbols = [...new Set(all.map((r) => r.symbol))].sort((a, b) => a.localeCompare(b));
    syncStockDropdown(symbols);
    if (!all.length) { body.innerHTML = '<tr><td colspan="7" class="fo-empty">Loading stock futures…</td></tr>'; meta.textContent = ""; return; }
    const chosen = stockFutureSymbol && symbols.includes(stockFutureSymbol) ? stockFutureSymbol : "";
    const rows = chosen ? all.filter((r) => r.symbol === chosen) : all;
    meta.textContent = chosen ? `${rows.length} ${chosen} contract${rows.length === 1 ? "" : "s"}` : `${all.length} contracts · ${symbols.length} underlyings`;
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
    const futuresSymbolFor = () => futuresMarket === "stock" ? "WATCH" : indexSymbol;
    $("#foInstrumentSeg").addEventListener("click", (event) => { const button = event.target.closest("[data-instrument]"); if (!button || button.dataset.instrument === instrument) return; instrument = button.dataset.instrument; symbol = instrument === "futures" ? futuresSymbolFor() : optionMarket === "index" ? indexSymbol : equitySymbol; $$("#foInstrumentSeg .seg").forEach((node) => { const on = node === button; node.classList.toggle("active", on); node.setAttribute("aria-selected", String(on)); }); loadSelected(); });
    $("#foOptionMarketSeg").addEventListener("click", (event) => { const button = event.target.closest("[data-option-market]"); if (!button || button.dataset.optionMarket === optionMarket) return; optionMarket = button.dataset.optionMarket; symbol = optionMarket === "index" ? indexSymbol : equitySymbol; $$("#foOptionMarketSeg .seg").forEach((node) => { const on = node === button; node.classList.toggle("active", on); node.setAttribute("aria-selected", String(on)); }); loadSelected(); });
    $("#foFutureMarketSeg").addEventListener("click", (event) => { const button = event.target.closest("[data-future-market]"); if (!button || button.dataset.futureMarket === futuresMarket) return; futuresMarket = button.dataset.futureMarket; symbol = futuresSymbolFor(); $$("#foFutureMarketSeg .seg").forEach((node) => { const on = node === button; node.classList.toggle("active", on); node.setAttribute("aria-selected", String(on)); }); loadSelected(); });
    $("#foFutureStock").addEventListener("change", (event) => { stockFutureSymbol = event.target.value; render(); }); // re-filter the watch, no re-fetch
    $("#foSymbol").addEventListener("change", (event) => { if (event.target.value === indexSymbol) return; indexSymbol = event.target.value; if (isFuturesIndex() || (instrument === "options" && optionMarket === "index")) { symbol = indexSymbol; loadSelected(); } });
    $("#foEquity").addEventListener("change", (event) => { const value = event.target.value.trim().toUpperCase(); event.target.value = value; if (!equitySymbols.has(value)) { equitySymbol = ""; symbol = ""; resetSelection(); clearExpiry("Select a stock first"); setState({ state: "error" }, "Select a stock from the NSE symbol list."); return; } if (value === equitySymbol) return; equitySymbol = value; symbol = value; loadSelected(); });
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
