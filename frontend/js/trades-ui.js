// Trades view — manual trade journal UI (self-contained IIFE, bridged via window.*).
// Mirrors alerts-ui.js structure/patterns; consumes the system.css primitives.
// Backend: /api/trades (+ /summary). No live/stream wiring (refresh on activate + after mutation).
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const PAGE_SIZE = 20;

  // ---------- api ----------
  async function api(path, method = "GET", body) {
    const headers = { "X-Requested-With": "XMLHttpRequest" };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await res.text();
    let j = {};
    try {
      j = txt ? JSON.parse(txt) : {};
    } catch (_) {}
    if (res.status === 401 && window.__onAuthExpired) window.__onAuthExpired();
    if (!res.ok || j.error) {
      const error = new Error(j.error || "HTTP " + res.status);
      error.status = res.status;
      throw error;
    }
    return j;
  }
  function drawIcons() {
    try {
      if (window.lucide) window.lucide.createIcons();
    } catch (_) {}
  }

  // ---------- formatters ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }
  function rs(v) {
    if (v == null || isNaN(v)) return "-";
    return (
      "₹" +
      Number(v).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  function signed(v) {
    if (v == null || isNaN(v)) return "-";
    const n = Number(v);
    const a =
      "₹" +
      Math.abs(n).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    return (n < 0 ? "-" : "+") + a;
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

  // ---------- state ----------
  let trType = "intraday";
  let trStatus = "open"; // open | closed | journal
  let trSort = { key: "entryDate", dir: -1 };
  let trPage = 1;
  let trRows = [];
  let searchTimer = null;
  let bound = false;

  // ---------- permissions (mirror shipped alert-policy: creator-only, no admin bypass) ----------
  const currentUser = () => (window.APP_AUTH && window.APP_AUTH.user) || null;
  const canWrite = () => {
    const u = currentUser();
    return !!u && (u.role === "editor" || u.role === "admin");
  };
  const isTradeCreator = (t) => {
    const u = currentUser();
    return !!u && !!t && t.createdByUserId === u.id;
  };
  const canWriteTrade = (t) => canWrite() && isTradeCreator(t);

  // ---------- columns ----------
  const COLS = [
    { key: "symbol", label: "Symbol", cls: "col-symbol", sort: "symbol" },
    { key: "tradeType", label: "Type", cls: "col-type", sort: "tradeType" },
    { key: "side", label: "Side", cls: "col-side", sort: "side" },
    { key: "qty", label: "Qty", cls: "col-qty num", sort: "qty" },
    { key: "entry", label: "Entry", cls: "col-entry num", sort: "entryDate" },
    { key: "exit", label: "Exit", cls: "col-exit num", sort: "exitDate" },
    { key: "netPnl", label: "Net P&L", cls: "col-netpnl num", sort: "netPnl" },
    { key: "pnlPct", label: "P&L %", cls: "col-pnlpct num", sort: "pnlPct" },
    { key: "rMultiple", label: "R", cls: "col-r num", sort: "rMultiple" },
    { key: "status", label: "Status", cls: "col-status", sort: "status" },
  ];
  const NUMERIC_SORT = new Set(["qty", "netPnl", "pnlPct", "rMultiple"]);

  // ---------- KPI + counts ----------
  async function loadKpis() {
    try {
      const [all, scoped] = await Promise.all([
        api("/api/trades/summary"),
        api("/api/trades/summary?tradeType=" + encodeURIComponent(trType)),
      ]);
      const bt = (all.summary && all.summary.byType) || {};
      const iCnt = (bt.intraday && bt.intraday.open + bt.intraday.closed) || 0;
      const sCnt = (bt.swing && bt.swing.open + bt.swing.closed) || 0;
      setText("#trCntIntraday", iCnt);
      setText("#trCntSwing", sCnt);

      const s = scoped.summary || {};
      const closed = s.closed || { count: 0, netPnl: 0, wins: 0, losses: 0, winRate: 0 };
      const open = s.open || { count: 0 };
      const netEl = $("#trKpiNet");
      const netCard = netEl && netEl.closest(".kpi-card");
      if (closed.count > 0) {
        netEl.textContent = signed(closed.netPnl);
        netEl.className = "value " + cls(closed.netPnl);
        setText("#trKpiNetSub", closed.wins + "W · " + closed.losses + "L");
        if (netCard) netCard.classList.remove("is-empty");
        setText("#trKpiWin", closed.winRate + "%");
        setText("#trKpiWinSub", closed.wins + "/" + (closed.wins + closed.losses));
      } else {
        netEl.textContent = "-";
        netEl.className = "value flat";
        setText("#trKpiNetSub", "No closed trades");
        if (netCard) netCard.classList.add("is-empty");
        setText("#trKpiWin", "-");
        setText("#trKpiWinSub", "");
      }
      setText("#trKpiOpen", open.count);
      setText("#trKpiClosed", closed.count);
    } catch (_) {
      /* KPI failure is non-fatal; table load surfaces the error */
    }
  }
  function setText(sel, v) {
    const el = $(sel);
    if (el) el.textContent = v;
  }

  // ---------- list ----------
  async function loadTrades() {
    const params = new URLSearchParams();
    params.set("tradeType", trType);
    if (trStatus !== "journal") params.set("status", trStatus);
    const sym = ($("#tr-search") && $("#tr-search").value.trim()) || "";
    if (sym) params.set("symbol", sym);
    const side = ($("#tr-side") && $("#tr-side").value) || "";
    if (side) params.set("side", side);
    const from = ($("#tr-from") && $("#tr-from").value) || "";
    if (from) params.set("from", from);
    const to = ($("#tr-to") && $("#tr-to").value) || "";
    if (to) params.set("to", to);
    const body = $("#trBody");
    try {
      const j = await api("/api/trades?" + params.toString());
      trRows = Array.isArray(j.trades) ? j.trades : [];
      trPage = 1;
      renderHead();
      renderTable();
    } catch (e) {
      if (body)
        body.innerHTML =
          '<tr class="loading"><td colspan="10"><div class="state-block err">Couldn\'t load trades. ' +
          esc(e.message || "") +
          "</div></td></tr>";
    }
  }

  function renderHead() {
    const tr = $("#trHead");
    if (!tr) return;
    tr.innerHTML = "";
    COLS.forEach((c) => {
      const th = document.createElement("th");
      const sorted = c.sort === trSort.key;
      th.className = c.cls + (sorted ? " sorted" : "");
      th.tabIndex = 0;
      th.setAttribute("role", "columnheader button");
      th.setAttribute(
        "aria-sort",
        sorted ? (trSort.dir > 0 ? "ascending" : "descending") : "none",
      );
      th.innerHTML =
        esc(c.label) +
        ' <span class="arrow">' +
        (sorted ? (trSort.dir > 0 ? "▲" : "▼") : "↕") +
        "</span>";
      const doSort = () => {
        if (trSort.key === c.sort) trSort.dir = -trSort.dir;
        else {
          trSort.key = c.sort;
          trSort.dir = c.sort === "symbol" ? 1 : -1;
        }
        renderHead();
        renderTable();
      };
      th.onclick = doSort;
      th.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          doSort();
        }
      };
      tr.appendChild(th);
    });
  }

  function sortRows(rows) {
    const k = trSort.key;
    const dir = trSort.dir;
    const numeric = NUMERIC_SORT.has(k);
    return rows.slice().sort((a, b) => {
      let x = a[k];
      let y = b[k];
      if (numeric) {
        x = x == null || isNaN(x) ? -Infinity : Number(x);
        y = y == null || isNaN(y) ? -Infinity : Number(y);
        return (x - y) * dir;
      }
      x = String(x == null ? "" : x);
      y = String(y == null ? "" : y);
      return x.localeCompare(y) * dir;
    });
  }

  function sidePill(side) {
    const up = side === "BUY";
    return (
      '<span class="pill ' +
      (up ? "up" : "down") +
      '"><span class="dotmark ' +
      (up ? "up" : "down") +
      '"></span>' +
      esc(side) +
      "</span>"
    );
  }
  function statusPill(t) {
    if (t.status === "open")
      return '<span class="pill flat"><span class="dotmark flat"></span>Open</span>';
    const c = cls(t.netPnl);
    return '<span class="pill ' + c + '">Closed</span>';
  }

  function renderTable() {
    const body = $("#trBody");
    if (!body) return;
    if (!trRows.length) {
      const filtered =
        ($("#tr-search") && $("#tr-search").value) ||
        ($("#tr-side") && $("#tr-side").value) ||
        ($("#tr-from") && $("#tr-from").value) ||
        ($("#tr-to") && $("#tr-to").value);
      const msg = filtered
        ? "No trades match the current filters."
        : canWrite()
          ? "No " + trType + " trades yet — click “New trade” to log one."
          : "No " + trType + " trades yet.";
      body.innerHTML =
        '<tr class="loading"><td colspan="10"><div class="state-block"><i data-lucide="notebook-pen"></i><span>' +
        esc(msg) +
        "</span></div></td></tr>";
      renderFoot(0);
      drawIcons();
      return;
    }
    const sorted = sortRows(trRows);
    const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    if (trPage > pages) trPage = pages;
    const start = (trPage - 1) * PAGE_SIZE;
    const slice = sorted.slice(start, start + PAGE_SIZE);
    body.innerHTML = slice
      .map((t) => {
        const entry = rs(t.entryPrice) + ' <span class="tr-dim">· ' + esc(t.entryDate || "") + "</span>";
        const exit =
          t.status === "closed"
            ? rs(t.exitPrice) + ' <span class="tr-dim">· ' + esc(t.exitDate || "") + "</span>"
            : "—";
        const net = t.netPnl == null ? "—" : signed(t.netPnl);
        const pctv = t.pnlPct == null ? "—" : pct(t.pnlPct);
        const r = t.rMultiple == null ? "—" : Number(t.rMultiple).toFixed(2) + "R";
        return (
          '<tr class="trade-row" tabindex="0" data-id="' +
          esc(t.id) +
          '" aria-label="View trade ' +
          esc(t.symbol) +
          '">' +
          '<td class="col-symbol"><strong>' + esc(t.symbol) + "</strong></td>" +
          '<td class="col-type">' + (t.tradeType === "swing" ? "Swing" : "Intraday") + "</td>" +
          '<td class="col-side">' + sidePill(t.side) + "</td>" +
          '<td class="col-qty num">' + esc(t.qty) + "</td>" +
          '<td class="col-entry num">' + entry + "</td>" +
          '<td class="col-exit num">' + exit + "</td>" +
          '<td class="col-netpnl num ' + cls(t.netPnl) + '">' + net + "</td>" +
          '<td class="col-pnlpct num ' + cls(t.pnlPct) + '">' + pctv + "</td>" +
          '<td class="col-r num">' + r + "</td>" +
          '<td class="col-status">' + statusPill(t) + "</td>" +
          "</tr>"
        );
      })
      .join("");
    renderFoot(sorted.length, pages);
    drawIcons();
  }

  function renderFoot(total, pages) {
    const count = $("#tr-count");
    const foot = $("#trFootCount");
    const pager = $("#trPager");
    if (count) count.textContent = total + (total === 1 ? " trade" : " trades");
    if (!total) {
      if (foot) foot.textContent = "";
      if (pager) pager.innerHTML = "";
      return;
    }
    const start = (trPage - 1) * PAGE_SIZE + 1;
    const end = Math.min(total, trPage * PAGE_SIZE);
    if (foot) foot.textContent = "Showing " + start + "–" + end + " of " + total;
    if (pager) {
      let html =
        '<button class="pg" data-pg="prev"' + (trPage <= 1 ? " disabled" : "") + ">‹</button>";
      for (let p = 1; p <= pages; p++) {
        if (pages > 7 && p !== 1 && p !== pages && Math.abs(p - trPage) > 1) {
          if (p === 2 || p === pages - 1) html += '<span class="pg-ellipsis">…</span>';
          continue;
        }
        html +=
          '<button class="pg' +
          (p === trPage ? " active" : "") +
          '" data-pg="' +
          p +
          '">' +
          p +
          "</button>";
      }
      html +=
        '<button class="pg" data-pg="next"' + (trPage >= pages ? " disabled" : "") + ">›</button>";
      pager.innerHTML = html;
    }
  }

  // ---------- detail modal ----------
  let viewReturnFocus = null;
  function openTradeView(t) {
    const modal = $("#tradeViewModal");
    if (!modal) return;
    viewReturnFocus = document.activeElement;
    setText("#tv-sym", t.symbol);
    setText(
      "#tv-name",
      (t.tradeType === "swing" ? "Swing" : "Intraday") +
        " · " +
        t.side +
        (t.index ? " · " + t.index : ""),
    );
    const cells = [
      ["Side", t.side],
      ["Qty", t.qty],
      ["Entry", rs(t.entryPrice)],
      ["Entry date", (t.entryDate || "") + (t.entryTime ? " " + t.entryTime : "")],
      ["Exit", t.status === "closed" ? rs(t.exitPrice) : "—"],
      ["Exit date", t.status === "closed" ? (t.exitDate || "") + (t.exitTime ? " " + t.exitTime : "") : "—"],
      ["Stop loss", t.stopLoss != null ? rs(t.stopLoss) : "—"],
      ["Target", t.target != null ? rs(t.target) : "—"],
      ["Charges", rs(t.charges)],
      ["Gross P&L", t.grossPnl == null ? "—" : signed(t.grossPnl)],
      ["Net P&L", t.netPnl == null ? "—" : signed(t.netPnl)],
      ["P&L %", t.pnlPct == null ? "—" : pct(t.pnlPct)],
      ["R multiple", t.rMultiple == null ? "—" : Number(t.rMultiple).toFixed(2) + "R"],
      ["Strategy", t.strategy || "—"],
      ["Tags", (t.tags && t.tags.length ? t.tags.join(", ") : "—")],
      ["Status", t.status === "closed" ? "Closed" : "Open"],
      ["Logged by", t.createdByUsername || "—"],
    ];
    $("#tv-grid").innerHTML = cells
      .map(
        ([k, v]) =>
          '<div class="cell"><span class="k">' +
          esc(k) +
          '</span><span class="v">' +
          esc(v) +
          "</span></div>",
      )
      .join("");
    if (t.notes) {
      $("#tv-grid").innerHTML +=
        '<div class="cell" style="grid-column:1/-1"><span class="k">Notes</span><span class="v">' +
        esc(t.notes) +
        "</span></div>";
    }
    const actions = $("#tv-actions");
    actions.innerHTML = "";
    if (canWriteTrade(t)) {
      if (t.status === "open") {
        actions.appendChild(
          mkBtn("Close trade", "primary", () => {
            closeView();
            openTradeModal("close", t);
          }, "log-out"),
        );
      }
      actions.appendChild(
        mkBtn("Edit", "", () => {
          closeView();
          openTradeModal("edit", t);
        }, "pencil"),
      );
      actions.appendChild(
        mkBtn("Delete", "danger", () => deleteTrade(t), "trash-2"),
      );
    }
    modal.classList.add("show");
    document.body.style.overflow = "hidden";
    drawIcons();
    requestAnimationFrame(() => {
      const card = $("#tradeViewModal .sm-card");
      if (card) card.focus({ preventScroll: true });
    });
  }
  function mkBtn(label, cls, onclick, icon) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    if (cls === "danger" || label !== "Edit") b.setAttribute("data-requires-edit", "");
    else b.setAttribute("data-requires-edit", "");
    b.innerHTML = (icon ? '<i data-lucide="' + icon + '"></i>' : "") + esc(label);
    b.onclick = onclick;
    return b;
  }
  function closeView() {
    const modal = $("#tradeViewModal");
    if (!modal || !modal.classList.contains("show")) return;
    modal.classList.remove("show");
    document.body.style.overflow = "";
    if (viewReturnFocus && viewReturnFocus.isConnected) viewReturnFocus.focus();
    viewReturnFocus = null;
  }

  // ---------- create / edit / close modal ----------
  let editingId = null;
  let modalReturnFocus = null;
  function openTradeModal(mode, trade) {
    const modal = $("#tradeModal");
    if (!modal) return;
    modalReturnFocus = document.activeElement;
    const form = $("#tradeForm");
    form.reset();
    $("#trade-err").textContent = "";
    modal.classList.remove("tm-close-mode");
    editingId = null;
    const title = $("#trFormTitle");
    const submitText = $("#tr-submit-text");
    if (mode === "create") {
      title.textContent = "New trade";
      submitText.textContent = "Save trade";
      $("#tr-type").value = trType;
      $("#tr-charges").value = "0";
    } else {
      editingId = trade.id;
      title.textContent = mode === "close" ? "Close trade" : "Edit trade";
      submitText.textContent = mode === "close" ? "Close trade" : "Save changes";
      fillForm(trade);
      if (mode === "close") modal.classList.add("tm-close-mode");
    }
    syncEntryTimeHint();
    modal.classList.add("show");
    document.body.style.overflow = "hidden";
    drawIcons();
    requestAnimationFrame(() => {
      const focusEl =
        mode === "close" ? $("#tr-exit") : $("#tr-type");
      if (focusEl) focusEl.focus();
    });
  }
  function fillForm(t) {
    $("#tr-id").value = t.id || "";
    $("#tr-type").value = t.tradeType || "intraday";
    $("#tr-f-side").value = t.side || "";
    $("#tr-symbol").value = t.symbol || "";
    $("#tr-exchange").value = t.exchange || "NSE";
    $("#tr-qty").value = t.qty != null ? t.qty : "";
    $("#tr-index").value = t.index || "";
    $("#tr-entry").value = t.entryPrice != null ? t.entryPrice : "";
    $("#tr-entry-date").value = t.entryDate || "";
    $("#tr-entry-time").value = t.entryTime || "";
    $("#tr-exit").value = t.exitPrice != null ? t.exitPrice : "";
    $("#tr-exit-date").value = t.exitDate || "";
    $("#tr-exit-time").value = t.exitTime || "";
    $("#tr-charges").value = t.charges != null ? t.charges : "0";
    $("#tr-stop").value = t.stopLoss != null ? t.stopLoss : "";
    $("#tr-target").value = t.target != null ? t.target : "";
    $("#tr-strategy").value = t.strategy || "";
    $("#tr-notes").value = t.notes || "";
    $("#tr-tags").value = t.tags && t.tags.length ? t.tags.join(", ") : "";
  }
  function syncEntryTimeHint() {
    const opt = $("#tr-entry-time-opt");
    if (opt)
      opt.textContent =
        $("#tr-type").value === "intraday" ? "(required for intraday)" : "(optional)";
  }
  function closeModal() {
    const modal = $("#tradeModal");
    if (!modal || !modal.classList.contains("show")) return;
    modal.classList.remove("show");
    document.body.style.overflow = "";
    if (modalReturnFocus && modalReturnFocus.isConnected) modalReturnFocus.focus();
    modalReturnFocus = null;
  }

  function collectForm() {
    const val = (id) => {
      const el = $(id);
      return el ? el.value.trim() : "";
    };
    const numOrNull = (id) => {
      const v = val(id);
      return v === "" ? null : Number(v);
    };
    return {
      tradeType: val("#tr-type"),
      side: val("#tr-f-side"),
      symbol: val("#tr-symbol").toUpperCase(),
      exchange: val("#tr-exchange"),
      qty: numOrNull("#tr-qty"),
      index: val("#tr-index") || null,
      entryPrice: numOrNull("#tr-entry"),
      entryDate: val("#tr-entry-date"),
      entryTime: val("#tr-entry-time") || null,
      exitPrice: val("#tr-exit") === "" ? null : Number(val("#tr-exit")),
      exitDate: val("#tr-exit-date") || null,
      exitTime: val("#tr-exit-time") || null,
      stopLoss: numOrNull("#tr-stop"),
      target: numOrNull("#tr-target"),
      charges: val("#tr-charges") === "" ? 0 : Number(val("#tr-charges")),
      strategy: val("#tr-strategy") || null,
      notes: val("#tr-notes") || null,
      tags: val("#tr-tags")
        ? val("#tr-tags")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : [],
    };
  }
  // client-side pre-check (server re-validates authoritatively)
  function clientValidate(t) {
    const e = [];
    if (t.tradeType !== "intraday" && t.tradeType !== "swing") e.push("Choose a trade type");
    if (t.side !== "BUY" && t.side !== "SELL") e.push("Choose Buy or Sell");
    if (!t.symbol) e.push("Symbol is required");
    if (!(t.qty > 0)) e.push("Quantity must be positive");
    if (!(t.entryPrice > 0)) e.push("Entry price must be positive");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.entryDate)) e.push("Entry date is required");
    if (t.tradeType === "intraday" && !t.entryTime) e.push("Entry time is required for intraday");
    const closing = t.exitPrice != null || !!t.exitDate;
    if (closing) {
      if (!(t.exitPrice > 0)) e.push("Exit price must be positive to close");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.exitDate || "")) e.push("Exit date is required to close");
      if (t.entryDate && t.exitDate) {
        if (t.exitDate < t.entryDate) e.push("Exit cannot be before entry");
        if (t.tradeType === "intraday" && t.exitDate !== t.entryDate)
          e.push("Intraday entry and exit must be the same day");
        if (t.tradeType === "swing" && t.exitDate === t.entryDate)
          e.push("Swing entry and exit are on the same day — use Intraday");
      }
    }
    if (t.stopLoss != null) {
      if (t.side === "BUY" && t.stopLoss >= t.entryPrice) e.push("Stop loss must be below entry for BUY");
      if (t.side === "SELL" && t.stopLoss <= t.entryPrice) e.push("Stop loss must be above entry for SELL");
    }
    if (t.target != null) {
      if (t.side === "BUY" && t.target <= t.entryPrice) e.push("Target must be above entry for BUY");
      if (t.side === "SELL" && t.target >= t.entryPrice) e.push("Target must be below entry for SELL");
    }
    return e;
  }
  async function submitTradeForm(ev) {
    ev.preventDefault();
    const errBox = $("#trade-err");
    const t = collectForm();
    const errs = clientValidate(t);
    if (errs.length) {
      errBox.textContent = errs.join(" · ");
      return;
    }
    errBox.textContent = "";
    const submit = $("#tr-submit");
    submit.disabled = true;
    try {
      if (editingId) await api("/api/trades/" + encodeURIComponent(editingId), "PATCH", t);
      else await api("/api/trades", "POST", t);
      closeModal();
      await reload();
    } catch (e) {
      errBox.textContent = e.message || "Couldn't save trade";
    } finally {
      submit.disabled = false;
    }
  }
  async function deleteTrade(t) {
    if (!window.confirm("Delete this " + t.symbol + " trade? This cannot be undone.")) return;
    try {
      await api("/api/trades/" + encodeURIComponent(t.id), "DELETE");
      closeView();
      await reload();
    } catch (e) {
      window.alert(e.message || "Couldn't delete trade");
    }
  }

  async function reload() {
    await Promise.all([loadKpis(), loadTrades()]);
  }

  // ---------- listeners (bound once) ----------
  function bindOnce() {
    if (bound) return;
    bound = true;
    const newBtn = $("#tr-new");
    if (newBtn) newBtn.onclick = () => openTradeModal("create");

    $("#trTypeSeg").addEventListener("click", (e) => {
      const seg = e.target.closest(".seg");
      if (!seg) return;
      trType = seg.dataset.type;
      segActive("#trTypeSeg", seg);
      reload();
    });
    $("#trStatusSeg").addEventListener("click", (e) => {
      const seg = e.target.closest(".seg");
      if (!seg) return;
      trStatus = seg.dataset.status;
      segActive("#trStatusSeg", seg);
      loadTrades();
    });
    $("#tr-search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadTrades, 250);
    });
    $("#tr-side").addEventListener("change", loadTrades);
    $("#tr-from").addEventListener("change", loadTrades);
    $("#tr-to").addEventListener("change", loadTrades);
    $("#tr-type").addEventListener("change", syncEntryTimeHint);

    $("#tr-modal-close").onclick = closeModal;
    $("#tr-cancel").onclick = closeModal;
    $("#tradeModal").addEventListener("click", (e) => {
      if (e.target.id === "tradeModal") closeModal();
    });
    $("#tradeForm").addEventListener("submit", submitTradeForm);

    $("#tv-close").onclick = closeView;
    $("#tradeViewModal").addEventListener("click", (e) => {
      if (e.target.id === "tradeViewModal") closeView();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("#tradeModal").classList.contains("show")) closeModal();
      else if ($("#tradeViewModal").classList.contains("show")) closeView();
    });

    // row-tap detail
    $("#trBody").addEventListener("click", (e) => {
      const row = e.target.closest(".trade-row");
      if (!row) return;
      const t = trRows.find((x) => x.id === row.dataset.id);
      if (t) openTradeView(t);
    });
    $("#trBody").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const row = e.target.closest(".trade-row");
      if (!row) return;
      const t = trRows.find((x) => x.id === row.dataset.id);
      if (t) openTradeView(t);
    });

    // pager
    $("#trPager").addEventListener("click", (e) => {
      const pg = e.target.closest(".pg");
      if (!pg || pg.disabled) return;
      const v = pg.dataset.pg;
      if (v === "prev") trPage = Math.max(1, trPage - 1);
      else if (v === "next") trPage = trPage + 1;
      else trPage = Number(v);
      renderTable();
    });
  }
  function segActive(container, active) {
    $(container)
      .querySelectorAll(".seg")
      .forEach((s) => {
        const on = s === active;
        s.classList.toggle("active", on);
        s.setAttribute("aria-selected", String(on));
      });
  }

  // ---------- public bridges ----------
  window.__initTrades = function () {
    bindOnce();
    document.body.classList.toggle("role-viewer", !canWrite());
    reload();
  };
  window.__reloadTrades = reload;
  window.openCreateTrade = function (prefill) {
    const tab = document.getElementById("view-tab-trades");
    if (tab) tab.click(); // switch to Trades via the existing viewnav wiring (runs __initTrades)
    bindOnce();
    prefill = prefill || {};
    if (prefill.tradeType) trType = prefill.tradeType;
    openTradeModal("create");
    const set = (id, v) => {
      const el = $(id);
      if (el && v != null && v !== "") el.value = v;
    };
    if (prefill.symbol) set("#tr-symbol", String(prefill.symbol).toUpperCase());
    if (prefill.side) set("#tr-f-side", prefill.side);
    set("#tr-index", prefill.index);
    set("#tr-entry", prefill.entryPrice);
    set("#tr-stop", prefill.stopLoss);
    set("#tr-target", prefill.target);
    set("#tr-entry-date", prefill.entryDate);
  };
})();
