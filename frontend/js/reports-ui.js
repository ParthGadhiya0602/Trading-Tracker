// Reports view — performance analytics computed client-side from /api/trades
// (closed trades only). Charts are hand-rolled inline SVG (zero-dep). Colour via
// tokens only. Self-contained IIFE, bridged via window.*.
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);

  async function api(path) {
    const res = await fetch(path, { headers: { "X-Requested-With": "XMLHttpRequest" } });
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
    String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  function rs(v) {
    if (v == null || isNaN(v)) return "-";
    return "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function signed(v) {
    if (v == null || isNaN(v)) return "-";
    const n = Number(v);
    const a = "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  // compact axis label (e.g. 12.3k, -1.2L)
  function kfmt(v) {
    const n = Number(v) || 0;
    const a = Math.abs(n);
    const sgn = n < 0 ? "-" : "";
    if (a >= 1e7) return sgn + (a / 1e7).toFixed(1) + "Cr";
    if (a >= 1e5) return sgn + (a / 1e5).toFixed(1) + "L";
    if (a >= 1e3) return sgn + (a / 1e3).toFixed(1) + "k";
    return sgn + a.toFixed(0);
  }

  // ---------- state ----------
  let rpType = "";
  let rpPeriod = "month";
  let closed = []; // last computed closed-trade set
  let bound = false;

  function exitEpoch(t) {
    return Date.parse((t.exitDate || "1970-01-01") + "T" + (t.exitTime && /^\d{1,2}:\d{2}$/.test(t.exitTime) ? t.exitTime : "00:00") + ":00+05:30");
  }

  // ---------- load ----------
  async function loadReports() {
    const params = new URLSearchParams();
    params.set("status", "closed");
    if (rpType) params.set("tradeType", rpType);
    const from = $("#rp-from") && $("#rp-from").value;
    const to = $("#rp-to") && $("#rp-to").value;
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    try {
      const j = await api("/api/trades?" + params.toString());
      closed = (j.trades || []).filter((t) => t.status === "closed" && t.netPnl != null);
      closed.sort((a, b) => exitEpoch(a) - exitEpoch(b));
      render();
    } catch (e) {
      showEmpty('<div class="state-block err"><i data-lucide="alert-triangle"></i><span>Couldn\'t load reports. ' + esc(e.message) + "</span></div>");
    }
  }
  function showEmpty(html) {
    const empty = $("#rpEmpty");
    const content = $("#rpContent");
    if (empty) {
      empty.hidden = false;
      empty.innerHTML = html;
    }
    if (content) content.hidden = true;
    drawIcons();
  }
  function showContent() {
    const empty = $("#rpEmpty");
    const content = $("#rpContent");
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;
  }

  // ---------- analytics ----------
  function analytics(rows) {
    let net = 0, grossProfit = 0, grossLoss = 0, wins = 0, losses = 0, rSum = 0, rCount = 0;
    for (const t of rows) {
      const n = Number(t.netPnl) || 0;
      net += n;
      if (n > 0) { grossProfit += n; wins++; }
      else if (n < 0) { grossLoss += -n; losses++; }
      if (t.rMultiple != null && !isNaN(t.rMultiple)) { rSum += Number(t.rMultiple); rCount++; }
    }
    const resolved = wins + losses;
    const winRate = resolved ? (wins / resolved) * 100 : 0;
    const avgWin = wins ? grossProfit / wins : 0;
    const avgLoss = losses ? grossLoss / losses : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const expectancy = rows.length ? net / rows.length : 0;
    // max drawdown on the cumulative equity curve
    let cum = 0, peak = 0, maxDD = 0;
    for (const t of rows) {
      cum += Number(t.netPnl) || 0;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }
    const avgR = rCount ? rSum / rCount : null;
    return { net, grossProfit, grossLoss, wins, losses, winRate, avgWin, avgLoss, profitFactor, expectancy, maxDD, avgR, count: rows.length };
  }

  function render() {
    if (!closed.length) {
      showEmpty('<div class="state-block"><i data-lucide="bar-chart-3"></i><span>No closed trades' + (rpType ? " for " + rpType : "") + " yet — log and close trades to see analytics.</span></div>");
      const asOf = $("#rpAsOf");
      if (asOf) asOf.textContent = "";
      return;
    }
    showContent();
    const a = analytics(closed);
    renderKpis(a);
    renderEquity();
    renderBars();
    renderMini("#rpBest", closed.slice().sort((x, y) => y.netPnl - x.netPnl).slice(0, 5));
    renderMini("#rpWorst", closed.slice().sort((x, y) => x.netPnl - y.netPnl).slice(0, 5));
    renderStrategy();
    renderHistory();
    const asOf = $("#rpAsOf");
    if (asOf) asOf.textContent = a.count + " closed trade" + (a.count === 1 ? "" : "s");
    drawIcons();
  }

  function kpi(label, value, valClass, sub, icon) {
    return (
      '<div class="kpi-card' + (label === "Net P&L" ? " hero" : "") + '">' +
      '<div class="kpi-head"><span class="kpi-chip"><i data-lucide="' + icon + '"></i></span>' +
      '<span class="label">' + esc(label) + "</span></div>" +
      '<span class="value ' + (valClass || "") + '">' + value + "</span>" +
      (sub ? '<span class="sub">' + esc(sub) + "</span>" : "") +
      "</div>"
    );
  }
  function renderKpis(a) {
    const pf = a.profitFactor === Infinity ? "∞" : a.profitFactor.toFixed(2);
    $("#rpKpis").innerHTML =
      kpi("Net P&L", signed(a.net), cls(a.net), a.wins + "W · " + a.losses + "L", "trending-up") +
      kpi("Win rate", a.winRate.toFixed(1) + "%", "", a.wins + "/" + (a.wins + a.losses), "percent") +
      kpi("Profit factor", pf, cls(a.profitFactor >= 1 ? 1 : -1), "gross " + kfmt(a.grossProfit) + " / " + kfmt(a.grossLoss), "scale") +
      kpi("Expectancy", signed(a.expectancy), cls(a.expectancy), "per trade", "target") +
      kpi("Avg win / loss", signed(a.avgWin) + " / " + signed(-a.avgLoss), "", "", "git-compare") +
      kpi("Max drawdown", a.maxDD > 0 ? "-" + rs(a.maxDD) : rs(0), a.maxDD > 0 ? "down" : "flat", "peak-to-trough", "trending-down") +
      kpi("Avg R", a.avgR == null ? "—" : a.avgR.toFixed(2) + "R", cls(a.avgR), "trades with a stop", "activity") +
      kpi("Closed", String(a.count), "", "trades", "check-circle-2");
  }

  // ---------- equity curve (SVG) ----------
  function renderEquity() {
    const host = $("#rpEquity");
    const W = 760, H = 220, padL = 46, padR = 12, padT = 12, padB = 22;
    const iw = W - padL - padR, ih = H - padT - padB;
    // cumulative series with a leading 0 baseline
    const series = [0];
    let cum = 0;
    for (const t of closed) { cum += Number(t.netPnl) || 0; series.push(cum); }
    const n = series.length;
    let min = Math.min(...series), max = Math.max(...series);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08 || 1;
    min -= pad; max += pad;
    const x = (i) => padL + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const y = (v) => padT + ih - ((v - min) / (max - min)) * ih;
    const pts = series.map((v, i) => x(i) + "," + y(v).toFixed(1)).join(" ");
    const zeroY = min <= 0 && max >= 0 ? y(0).toFixed(1) : null;
    const area =
      "M " + x(0) + "," + y(series[0]).toFixed(1) + " L " +
      series.map((v, i) => x(i) + "," + y(v).toFixed(1)).join(" L ") +
      " L " + x(n - 1) + "," + (padT + ih) + " L " + x(0) + "," + (padT + ih) + " Z";
    const meta = $("#rpEquityMeta");
    if (meta) meta.textContent = "cumulative " + signed(cum);
    host.innerHTML =
      '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Equity curve">' +
      '<text class="lbl" x="4" y="' + (y(max) + 4).toFixed(1) + '">' + kfmt(max) + "</text>" +
      '<text class="lbl" x="4" y="' + (y(min) + 4).toFixed(1) + '">' + kfmt(min) + "</text>" +
      (zeroY ? '<line class="zero" x1="' + padL + '" y1="' + zeroY + '" x2="' + (W - padR) + '" y2="' + zeroY + '"/>' : "") +
      '<path class="equity-area" d="' + area + '"/>' +
      '<polyline class="equity-line" points="' + pts + '"/>' +
      '<line class="axis" x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (W - padR) + '" y2="' + (padT + ih) + '"/>' +
      "</svg>";
  }

  // ---------- P&L by period (SVG bars) ----------
  function isoWeekKey(dstr) {
    const d = new Date(dstr + "T00:00:00Z");
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
  }
  function periodKey(t) {
    const d = t.exitDate || "";
    if (rpPeriod === "day") return d;
    if (rpPeriod === "week") return d ? isoWeekKey(d) : "?";
    return d.slice(0, 7); // month
  }
  function renderBars() {
    const host = $("#rpBars");
    const map = new Map();
    for (const t of closed) {
      const k = periodKey(t);
      map.set(k, (map.get(k) || 0) + (Number(t.netPnl) || 0));
    }
    const keys = [...map.keys()].sort();
    if (!keys.length) { host.innerHTML = '<div class="chart-empty">No data.</div>'; return; }
    const vals = keys.map((k) => map.get(k));
    const W = 760, H = 180, padL = 46, padR = 12, padT = 12, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
    if (min === max) max += 1;
    const y = (v) => padT + ih - ((v - min) / (max - min)) * ih;
    const zeroY = y(0);
    const n = keys.length;
    const slot = iw / n;
    const bw = Math.max(2, Math.min(38, slot * 0.7));
    const everyLbl = Math.ceil(n / 12);
    let bars = "";
    keys.forEach((k, i) => {
      const v = map.get(k);
      const cx = padL + slot * i + slot / 2;
      const top = v >= 0 ? y(v) : zeroY;
      const h = Math.abs(y(v) - zeroY);
      bars +=
        '<rect class="' + (v >= 0 ? "bar-up" : "bar-down") + '" x="' + (cx - bw / 2).toFixed(1) +
        '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, h).toFixed(1) +
        '" rx="1"><title>' + esc(k) + ": " + signed(v) + "</title></rect>";
      if (i % everyLbl === 0)
        bars += '<text class="lbl" x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(rpPeriod === "day" ? k.slice(5) : rpPeriod === "week" ? k.slice(5) : k) + "</text>";
    });
    host.innerHTML =
      '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="P&L by period">' +
      '<text class="lbl" x="4" y="' + (y(max) + 4).toFixed(1) + '">' + kfmt(max) + "</text>" +
      '<text class="lbl" x="4" y="' + (y(min) + 4).toFixed(1) + '">' + kfmt(min) + "</text>" +
      '<line class="zero" x1="' + padL + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + zeroY.toFixed(1) + '"/>' +
      bars +
      "</svg>";
  }

  // ---------- mini lists ----------
  function renderMini(sel, rows) {
    const host = $(sel);
    if (!rows.length) { host.innerHTML = '<div class="chart-empty">No trades.</div>'; return; }
    host.innerHTML = rows
      .map(
        (t) =>
          '<div class="mini-row"><div class="mr-main"><strong>' + esc(t.symbol) +
          '</strong><span class="mr-sub">' + esc(t.exitDate || "") + " · " + (t.tradeType === "swing" ? "Swing" : "Intraday") + " · " + esc(t.side) +
          '</span></div><span class="mr-val ' + cls(t.netPnl) + '">' + signed(t.netPnl) + "</span></div>",
      )
      .join("");
  }

  // ---------- strategy breakdown ----------
  function renderStrategy() {
    const host = $("#rpStrategy");
    const map = new Map();
    for (const t of closed) {
      const k = t.strategy || "Unlabelled";
      const g = map.get(k) || { net: 0, wins: 0, losses: 0, count: 0 };
      const n = Number(t.netPnl) || 0;
      g.net += n; g.count++;
      if (n > 0) g.wins++; else if (n < 0) g.losses++;
      map.set(k, g);
    }
    const rows = [...map.entries()].sort((a, b) => b[1].net - a[1].net);
    if (!rows.length) { host.innerHTML = '<div class="chart-empty">No trades.</div>'; return; }
    host.innerHTML = rows
      .map(([name, g]) => {
        const res = g.wins + g.losses;
        const wr = res ? (g.wins / res) * 100 : 0;
        return (
          '<div class="mini-row"><div class="mr-main"><strong>' + esc(name) +
          '</strong><span class="mr-sub">' + g.count + " trades · " + wr.toFixed(0) + "% win</span></div>" +
          '<div style="display:flex;align-items:center;gap:10px">' +
          '<span class="wr-bar"><span class="wr-fill" style="width:' + wr.toFixed(0) + '%"></span></span>' +
          '<span class="mr-val ' + cls(g.net) + '">' + signed(g.net) + "</span></div></div>"
        );
      })
      .join("");
  }

  // ---------- closed trade history ----------
  function renderHistory() {
    const body = $("#rpHistBody");
    const rows = closed.slice().sort((a, b) => exitEpoch(b) - exitEpoch(a));
    $("#rpHistCount").textContent = rows.length + (rows.length === 1 ? " trade" : " trades");
    body.innerHTML = rows
      .map(
        (t) =>
          '<tr>' +
          '<td class="col-symbol"><strong>' + esc(t.symbol) + "</strong></td>" +
          '<td class="col-type">' + (t.tradeType === "swing" ? "Swing" : "Intraday") + "</td>" +
          '<td class="col-side"><span class="pill ' + (t.side === "BUY" ? "up" : "down") + '"><span class="dotmark ' + (t.side === "BUY" ? "up" : "down") + '"></span>' + esc(t.side) + "</span></td>" +
          '<td class="col-exit num">' + esc(t.exitDate || "") + "</td>" +
          '<td class="col-netpnl num ' + cls(t.netPnl) + '">' + signed(t.netPnl) + "</td>" +
          '<td class="col-pnlpct num ' + cls(t.pnlPct) + '">' + pct(t.pnlPct) + "</td>" +
          '<td class="col-r num">' + (t.rMultiple == null ? "—" : Number(t.rMultiple).toFixed(2) + "R") + "</td>" +
          "</tr>",
      )
      .join("");
  }

  // ---------- listeners ----------
  function segActive(container, active) {
    $(container).querySelectorAll(".seg").forEach((s) => {
      const on = s === active;
      s.classList.toggle("active", on);
      s.setAttribute("aria-selected", String(on));
    });
  }
  function bindOnce() {
    if (bound) return;
    bound = true;
    $("#rpTypeSeg").addEventListener("click", (e) => {
      const seg = e.target.closest(".seg");
      if (!seg) return;
      rpType = seg.dataset.type;
      segActive("#rpTypeSeg", seg);
      loadReports();
    });
    $("#rpPeriodSeg").addEventListener("click", (e) => {
      const seg = e.target.closest(".seg");
      if (!seg) return;
      rpPeriod = seg.dataset.period;
      segActive("#rpPeriodSeg", seg);
      if (closed.length) renderBars();
    });
    $("#rp-from").addEventListener("change", loadReports);
    $("#rp-to").addEventListener("change", loadReports);
    window.addEventListener("resize", () => {
      /* SVG is viewBox-scaled; nothing to recompute on resize */
    });
  }

  window.__initReports = function () {
    bindOnce();
    loadReports();
  };
  window.__reloadReports = loadReports;
})();
