// Market Watch view — live constituents by index + gainers/losers/most-active
// rail. Fetches /api/indices (same payload the dashboard uses); light polling
// only while the view is active. Self-contained IIFE, bridged via window.*.
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const POLL_MS = 5000;

  async function api(path) {
    const res = await fetch(path + (path.includes("?") ? "&" : "?") + "t=" + Date.now(), {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    const txt = await res.text();
    let j = {};
    try {
      j = txt ? JSON.parse(txt) : {};
    } catch (_) {}
    if (res.status === 401 && window.__onAuthExpired) window.__onAuthExpired();
    if (!res.ok || j.error) throw new Error(j.error || "HTTP " + res.status);
    return j;
  }
  function drawIcons() {
    try {
      if (window.lucide) window.lucide.createIcons();
    } catch (_) {}
  }

  // ---------- format ----------
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function rs(v) {
    if (v == null || isNaN(v)) return "-";
    return Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(v) {
    if (v == null || isNaN(v)) return "-";
    const n = Number(v);
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  }
  function cls(v) {
    if (v == null || isNaN(v)) return "flat";
    return v > 0 ? "up" : v < 0 ? "down" : "flat";
  }
  function vol(v) {
    if (v == null || isNaN(v)) return "-";
    const n = Number(v);
    if (n >= 1e7) return (n / 1e7).toFixed(2) + "Cr";
    if (n >= 1e5) return (n / 1e5).toFixed(2) + "L";
    return n.toLocaleString("en-IN");
  }
  // red = open==high (never above open); green = open==low (never below)
  function rowRank(r) {
    const o = Number(r.open);
    if (!(o > 0)) return 0;
    if (Number(r.dayHigh) <= o + 1e-9) return 1; // open = high (bearish, red)
    if (Number(r.dayLow) >= o - 1e-9) return -1; // open = low (bullish, green)
    return 0;
  }

  // ---------- state ----------
  let mwIndex = null;
  let mwFilter = "all"; // all | high (open=high) | low (open=low) | neutral
  let mwSort = { key: "pChange", dir: -1 };
  let cache = null;
  let pollTimer = null;
  let searchTimer = null;
  let bound = false;

  const COLS = [
    { key: "symbol", label: "Symbol", cls: "col-symbol", sort: "symbol" },
    { key: "lastPrice", label: "LTP", cls: "col-ltp num", sort: "lastPrice" },
    { key: "open", label: "Open", cls: "col-open num", sort: "open" },
    { key: "dayHigh", label: "High", cls: "col-high num", sort: "dayHigh" },
    { key: "dayLow", label: "Low", cls: "col-low num", sort: "dayLow" },
    { key: "prevClose", label: "Prev", cls: "col-prev num", sort: "prevClose" },
    { key: "change", label: "Change", cls: "col-change num", sort: "pChange" },
    { key: "totalTradedVolume", label: "Volume", cls: "col-vol num", sort: "totalTradedVolume" },
  ];
  const STR_SORT = new Set(["symbol"]);

  // ---------- load ----------
  async function load() {
    try {
      const j = await api("/api/indices");
      cache = j;
      if (!mwIndex || !cache[mwIndex]) mwIndex = Object.keys(cache)[0] || null;
      render();
    } catch (e) {
      showEmpty('<div class="state-block err"><i data-lucide="alert-triangle"></i><span>Couldn\'t load market data. ' + esc(e.message) + "</span></div>");
    }
  }
  function showEmpty(html) {
    const empty = $("#mwEmpty"), layout = $("#mwLayout");
    if (empty) { empty.hidden = false; empty.innerHTML = html; }
    if (layout) layout.hidden = true;
    drawIcons();
  }
  function showLayout() {
    const empty = $("#mwEmpty"), layout = $("#mwLayout");
    if (empty) empty.hidden = true;
    if (layout) layout.hidden = false;
  }

  function buildIndexSeg() {
    const seg = $("#mwIndexSeg");
    if (!seg || !cache) return;
    const keys = Object.keys(cache);
    seg.innerHTML = keys
      .map(
        (k) =>
          '<button type="button" class="seg' + (k === mwIndex ? " active" : "") +
          '" data-index="' + esc(k) + '" role="tab" aria-selected="' + (k === mwIndex) + '">' + esc(k) + "</button>",
      )
      .join("");
  }

  function render() {
    if (!cache || !mwIndex || !cache[mwIndex]) {
      showEmpty('<div class="state-block"><i data-lucide="candlestick-chart"></i><span>No market data available.</span></div>');
      return;
    }
    showLayout();
    buildIndexSeg();
    const idx = cache[mwIndex];
    renderKpis(idx);
    renderHead();
    renderTable(idx);
    renderRail(idx);
    $("#mwIdxName").textContent = mwIndex;
    const adv = idx.advance || {};
    $("#mwAdv").innerHTML =
      '<span class="up">▲ ' + (adv.advances || 0) + "</span> · " +
      '<span class="down">▼ ' + (adv.declines || 0) + "</span> · " +
      '<span class="flat">— ' + (adv.unchanged || 0) + "</span>";
    const meta = $("#mwMeta");
    if (meta) meta.textContent = (idx.marketStatus || "") + (idx.timestamp ? " · " + idx.timestamp : "");
    drawIcons();
  }

  function kpiCard(label, value, valClass, sub, icon, hero) {
    return (
      '<div class="kpi-card' + (hero ? " hero" : "") + '">' +
      '<div class="kpi-head"><span class="kpi-chip"><i data-lucide="' + icon + '"></i></span>' +
      '<span class="label">' + esc(label) + "</span></div>" +
      '<span class="value ' + (valClass || "") + '">' + value + "</span>" +
      (sub ? '<span class="sub">' + esc(sub) + "</span>" : "") +
      "</div>"
    );
  }
  function renderKpis(idx) {
    const lv = idx.level || {};
    const adv = idx.advance || {};
    $("#mwKpis").innerHTML =
      kpiCard("Level", lv.last != null ? rs(lv.last) : "-", cls(lv.pChange), (lv.variation != null ? (lv.variation > 0 ? "+" : "") + rs(lv.variation) : "") + " " + pct(lv.pChange), "candlestick-chart", true) +
      kpiCard("Day range", (lv.low != null ? rs(lv.low) : "-") + " – " + (lv.high != null ? rs(lv.high) : "-"), "", "open " + (lv.open != null ? rs(lv.open) : "-"), "move-vertical") +
      kpiCard("Advances", String(adv.advances || 0), "up", "declines " + (adv.declines || 0), "trending-up") +
      kpiCard("Prev close", lv.prevClose != null ? rs(lv.prevClose) : "-", "", "", "history");
  }

  function renderHead() {
    const tr = $("#mwHead");
    if (!tr) return;
    tr.innerHTML = COLS.map((c) => {
      const sorted = c.sort === mwSort.key;
      return (
        '<th class="' + c.cls + (sorted ? " sorted" : "") + '" data-sort="' + c.sort + '" tabindex="0" role="columnheader button" aria-sort="' +
        (sorted ? (mwSort.dir > 0 ? "ascending" : "descending") : "none") + '">' +
        esc(c.label) + ' <span class="arrow">' + (sorted ? (mwSort.dir > 0 ? "▲" : "▼") : "↕") + "</span></th>"
      );
    }).join("");
  }

  function sortRows(rows) {
    const k = mwSort.key, dir = mwSort.dir, str = STR_SORT.has(k);
    return rows.slice().sort((a, b) => {
      let x = a[k], y = b[k];
      if (str) return String(x || "").localeCompare(String(y || "")) * dir;
      x = x == null || isNaN(x) ? -Infinity : Number(x);
      y = y == null || isNaN(y) ? -Infinity : Number(y);
      return (x - y) * dir;
    });
  }

  function setFoot(shown, total, idx) {
    const f = $("#mwFoot");
    if (f) f.textContent = "Showing " + shown + " of " + total;
    const u = $("#mwUpdated");
    if (u) u.textContent = (idx.marketStatus || "") + (idx.timestamp ? " · " + idx.timestamp : "");
  }
  function renderTable(idx) {
    const body = $("#mwBody");
    const total = (idx.data || []).length;
    let rows = (idx.data || []).slice();
    const q = ($("#mw-search") && $("#mw-search").value.trim().toUpperCase()) || "";
    if (q) rows = rows.filter((r) => (r.symbol || "").toUpperCase().includes(q) || (r.companyName || "").toUpperCase().includes(q));
    if (mwFilter !== "all") {
      const want = mwFilter === "high" ? 1 : mwFilter === "low" ? -1 : 0;
      rows = rows.filter((r) => rowRank(r) === want);
    }
    setFoot(rows.length, total, idx);
    if (!rows.length) {
      const msg = q
        ? "No symbols match “" + esc(q) + "”."
        : mwFilter !== "all"
          ? "No constituents in this filter."
          : "No constituents — live only during market hours.";
      body.innerHTML = '<tr class="loading"><td colspan="8"><div class="state-block"><i data-lucide="search-x"></i><span>' + msg + "</span></div></td></tr>";
      drawIcons();
      return;
    }
    rows = sortRows(rows);
    body.innerHTML = rows
      .map((r) => {
        const rank = rowRank(r);
        const rowCls = rank === 1 ? "down-row" : rank === -1 ? "up-row" : "";
        const dot = rank === 1 ? "down" : rank === -1 ? "up" : "flat";
        return (
          '<tr class="' + rowCls + '">' +
          '<td class="col-symbol"><span class="dotmark ' + dot + '"></span><strong>' + esc(r.symbol) + "</strong></td>" +
          '<td class="col-ltp num">' + rs(r.lastPrice) + "</td>" +
          '<td class="col-open num">' + rs(r.open) + "</td>" +
          '<td class="col-high num">' + rs(r.dayHigh) + "</td>" +
          '<td class="col-low num">' + rs(r.dayLow) + "</td>" +
          '<td class="col-prev num">' + rs(r.prevClose) + "</td>" +
          '<td class="col-change num ' + cls(r.change) + '">' + (r.change > 0 ? "+" : "") + rs(r.change) + ' <span class="tr-dim">' + pct(r.pChange) + "</span></td>" +
          '<td class="col-vol num">' + vol(r.totalTradedVolume) + "</td>" +
          "</tr>"
        );
      })
      .join("");
    drawIcons();
  }

  function miniRows(rows, valFn, valClsFn) {
    if (!rows.length) return '<div class="chart-empty">No data.</div>';
    return rows
      .map(
        (r) =>
          '<div class="mini-row"><div class="mr-main"><strong>' + esc(r.symbol) +
          '</strong></div><span class="mr-val ' + (valClsFn ? valClsFn(r) : "") + '">' + valFn(r) + "</span></div>",
      )
      .join("");
  }
  function renderRail(idx) {
    const data = (idx.data || []).filter((r) => r.symbol);
    const byPct = data.slice().sort((a, b) => (b.pChange || 0) - (a.pChange || 0));
    const gainers = byPct.filter((r) => (r.pChange || 0) > 0).slice(0, 5);
    const losers = byPct.filter((r) => (r.pChange || 0) < 0).slice(-5).reverse();
    const active = data.slice().sort((a, b) => (b.totalTradedVolume || 0) - (a.totalTradedVolume || 0)).slice(0, 5);
    $("#mwGainers").innerHTML = miniRows(gainers, (r) => pct(r.pChange), () => "up");
    $("#mwLosers").innerHTML = miniRows(losers, (r) => pct(r.pChange), () => "down");
    $("#mwActive").innerHTML = miniRows(active, (r) => vol(r.totalTradedVolume), () => "");
  }

  // ---------- listeners ----------
  function bindOnce() {
    if (bound) return;
    bound = true;
    $("#mwIndexSeg").addEventListener("click", (e) => {
      const seg = e.target.closest(".seg");
      if (!seg || !cache) return;
      mwIndex = seg.dataset.index;
      render(); // cache already holds all indices
    });
    $("#mwFilterSeg").addEventListener("click", (e) => {
      const seg = e.target.closest(".seg");
      if (!seg) return;
      mwFilter = seg.dataset.filter;
      seg.parentElement.querySelectorAll(".seg").forEach((s) => {
        const on = s === seg;
        s.classList.toggle("active", on);
        s.setAttribute("aria-selected", String(on));
      });
      if (cache && mwIndex) renderTable(cache[mwIndex]);
    });
    $("#mwHead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      doSort(th.dataset.sort);
    });
    $("#mwHead").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      e.preventDefault();
      doSort(th.dataset.sort);
    });
    $("#mw-search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (cache && mwIndex) renderTable(cache[mwIndex]); }, 200);
    });
  }
  function doSort(key) {
    if (mwSort.key === key) mwSort.dir = -mwSort.dir;
    else { mwSort.key = key; mwSort.dir = key === "symbol" ? 1 : -1; }
    renderHead();
    if (cache && mwIndex) renderTable(cache[mwIndex]);
  }

  window.__initMarket = function () {
    bindOnce();
    load();
    if (!pollTimer) pollTimer = setInterval(load, POLL_MS);
  };
  window.__stopMarket = function () {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };
})();
