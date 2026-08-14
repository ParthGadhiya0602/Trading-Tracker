// Read-only F&O workspace. It owns one selected-chain EventSource and keeps
// server envelopes atomic; no client polling or patch merging is performed.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let symbol = "NIFTY", expiry = null, stream = null, generation = 0, sequence = -1;
  let snapshot = null, analysis = null, active = false, bound = false, centerOnNext = false, hiddenTimer = null;
  const expandedStrikes = new Set();

  async function api(path) {
    const res = await fetch(path, { headers: { "X-Requested-With": "XMLHttpRequest" } });
    const text = await res.text(); let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (res.status === 401 && window.__onAuthExpired) window.__onAuthExpired();
    if (!res.ok || data.error) { const error = new Error(data.error || `HTTP ${res.status}`); error.status = res.status; throw error; }
    return data;
  }
  const numeric = (value, digits = 0) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
  function selectedUrl(path) { return `${path}?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`; }
  function resetSelection() { closeStream(); sequence = -1; snapshot = null; analysis = null; centerOnNext = true; expandedStrikes.clear(); render(); }

  async function loadContracts() {
    closeStream(); expiry = null; snapshot = null; analysis = null; sequence = -1; centerOnNext = true; expandedStrikes.clear();
    const mine = generation;
    const select = $("#foExpiry"); select.disabled = true; select.innerHTML = "<option>Loading expiries…</option>";
    setState({ state: "loading" }, `Loading ${symbol} expiries…`); render();
    try {
      const contracts = await api(`/api/derivatives/contracts?symbol=${encodeURIComponent(symbol)}`);
      const expiries = Array.isArray(contracts.expiries) ? contracts.expiries : [];
      if (!active || mine !== generation) return;
      if (!expiries.length) { select.innerHTML = "<option>No expiries available</option>"; setState({ state: "error" }, "No expiries are available for this index."); return; }
      expiry = expiries[0].expiry;
      select.innerHTML = expiries.map((entry) => `<option value="${esc(entry.expiry)}">${esc(entry.expiry)}</option>`).join("");
      select.disabled = false; openStream();
    } catch (error) {
      if (!active || mine !== generation) return;
      select.innerHTML = "<option>Expiries unavailable</option>";
      setState({ state: error.status === 429 ? "rate-limited" : error.status === 503 ? "blocked" : "error" }, `Could not load expiries. ${error.message}`);
    }
  }
  function openStream() {
    if (!active || !expiry || !navigator.onLine || document.hidden || !window.EventSource) return;
    closeStream(); const mine = generation;
    setState({ state: "loading" }, snapshot ? "Refreshing selected chain; last snapshot remains visible." : "Loading selected chain…");
    const es = stream = new EventSource(selectedUrl("/api/derivatives/stream"));
    es.addEventListener("snapshot", (event) => receive(event, mine));
    es.addEventListener("status", (event) => receive(event, mine));
    es.onerror = () => { if (mine === generation && active) setState(snapshot || { state: "error" }, "Stream reconnecting; last snapshot remains visible."); };
  }
  function receive(event, mine) {
    if (mine !== generation || !active) return;
    let next; try { next = JSON.parse(event.data); } catch (_) { return; }
    const nextSequence = Number(next && next.sequence), isSnapshot = event.type === "snapshot";
    if (!next || next.symbol !== symbol || next.expiry !== expiry || !Number.isFinite(nextSequence) || (isSnapshot ? nextSequence <= sequence : nextSequence < sequence)) return;
    sequence = Math.max(sequence, nextSequence);
    if (next.data && Array.isArray(next.data.rows) && next.data.rows.length) snapshot = next;
    else if (snapshot) snapshot = { ...snapshot, ...next, data: snapshot.data };
    else snapshot = next;
    setState(snapshot); render();
    if (isSnapshot && snapshot.data) void loadAnalysis(mine, nextSequence, symbol, expiry);
  }
  async function loadAnalysis(mine, expectedSequence, expectedSymbol, expectedExpiry) {
    try {
      const next = await api(`/api/derivatives/analysis?symbol=${encodeURIComponent(expectedSymbol)}&expiry=${encodeURIComponent(expectedExpiry)}`);
      if (mine !== generation || expectedSymbol !== symbol || expectedExpiry !== expiry || Number(next.sequence) !== expectedSequence || sequence !== expectedSequence) return;
      analysis = next;
      render();
      if (centerOnNext) { centerOnNext = false; requestAnimationFrame(centerAtm); }
    } catch (_) { /* chain state is still usable */ }
  }
  function fact(label, value, detail = "") { return `<div class="fo-fact"><span>${esc(label)}</span><strong>${value}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</div>`; }
  function renderFacts() {
    const host = $("#foFacts"), meta = $("#foFactsMeta"); if (!host) return;
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
  function render() {
    const body = $("#foBody"), meta = $("#foChainMeta"), source = $("#foSource"), center = $("#foCenter"), wrap = $("#foTableWrap"); if (!body) return;
    const preservedScroll = wrap && !centerOnNext ? wrap.scrollTop : null;
    renderFacts(); center.disabled = !(snapshot && snapshot.data);
    source.textContent = snapshot ? `Source: ${time(snapshot.sourceTimestamp || snapshot.receivedAt)}` : "Source: not loaded";
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
    $("#foSymbolSeg").addEventListener("click", (event) => { const button = event.target.closest("[data-symbol]"); if (!button || button.dataset.symbol === symbol) return; symbol = button.dataset.symbol; $$("#foSymbolSeg .seg").forEach((node) => { const on = node === button; node.classList.toggle("active", on); node.setAttribute("aria-selected", String(on)); }); void loadContracts(); });
    $("#foExpiry").addEventListener("change", (event) => { expiry = event.target.value; resetSelection(); openStream(); });
    $("#foCenter").addEventListener("click", centerAtm);
    $("#foBody").addEventListener("click", (event) => { const row = event.target.closest(".fo-data-row"); if (row) toggleRow(row); });
    $("#foBody").addEventListener("keydown", (event) => { const row = event.target.closest(".fo-data-row"); if (!row || (event.key !== "Enter" && event.key !== " ")) return; event.preventDefault(); toggleRow(row); });
    window.addEventListener("online", () => { if (active) openStream(); }); window.addEventListener("offline", () => { closeStream(); setState(snapshot || { state: "error" }, "Offline; last available snapshot retained."); });
    window.addEventListener("beforeunload", closeStream);
    document.addEventListener("visibilitychange", () => { if (!active) return; if (document.hidden) hiddenTimer = setTimeout(closeStream, 30000); else { clearTimeout(hiddenTimer); hiddenTimer = null; openStream(); } });
  }
  const $$ = (s) => document.querySelectorAll(s);
  window.__initDerivatives = () => { active = true; bind(); if (!expiry) void loadContracts(); else openStream(); };
  window.__stopDerivatives = () => { active = false; clearTimeout(hiddenTimer); hiddenTimer = null; closeStream(); };
})();
