// Dashboard personal overview — aggregates the signed-in user's data (P&L from
// trades, active alerts, notifications, recent trades) into the Dashboard landing.
// Reads existing endpoints; renders into the #dashView overview mounts. The live
// index KPI cards above are still owned by dashboard.js. Self-contained IIFE.
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
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function signed(v) {
    if (v == null || isNaN(v)) return "-";
    const n = Number(v);
    const a = "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? "-" : "+") + a;
  }
  function rs(v) {
    if (v == null || isNaN(v)) return "-";
    return "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function cls(v) {
    if (v == null || isNaN(v)) return "flat";
    return v > 0 ? "up" : v < 0 ? "down" : "flat";
  }
  function ago(ts) {
    if (!ts) return "";
    const t = Date.parse(ts);
    if (isNaN(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function empty(msg) {
    return '<div class="chart-empty">' + esc(msg) + "</div>";
  }

  let bound = false;

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

  function statusPill(st) {
    const map = { armed: "accent", triggered: "up", active: "accent", closed: "flat" };
    const c = map[st] || "flat";
    const label = st ? st.charAt(0).toUpperCase() + st.slice(1) : "";
    return '<span class="pill ' + c + '">' + esc(label) + "</span>";
  }
  function sidePill(side) {
    const up = side === "BUY";
    return '<span class="pill ' + (up ? "up" : "down") + '"><span class="dotmark ' + (up ? "up" : "down") + '"></span>' + esc(side) + "</span>";
  }

  // ---- expandable panels: show first 3, toggle "See all (N)" / "Show less" ----
  const PREVIEW = 3;
  const listData = { alerts: [], notifs: [], trades: [] };
  const expanded = { alerts: false, notifs: false, trades: false };
  const HOSTID = { alerts: "#dashAlerts", notifs: "#dashNotifs", trades: "#dashTrades" };
  const EMPTYMSG = { alerts: "No active alerts.", notifs: "No notifications yet.", trades: "No trades logged yet." };
  function alertRow(a) {
    return (
      '<div class="mini-row"><div class="mr-main"><strong>' + esc(a.symbol) +
      '</strong><span class="mr-sub">' + esc(a.index || "") + " · " + rs(a.alertPrice) +
      '</span></div><div style="display:flex;gap:6px;align-items:center">' + sidePill(a.side) + statusPill(a.status) + "</div></div>"
    );
  }
  function notifRow(n) {
    const ev = n.event || {};
    const txt = ev.text || (ev.type ? ev.type + (ev.price != null ? " @ " + rs(ev.price) : "") : "Alert event");
    return (
      '<div class="mini-row' + (n.readAt ? "" : " is-unread") + '"><div class="mr-main"><strong>' +
      esc(txt) + '</strong><span class="mr-sub">' + esc(ago(ev.at)) + "</span></div>" +
      (n.readAt ? "" : '<span class="pill accent">New</span>') + "</div>"
    );
  }
  function tradeRow(t) {
    const val = t.status === "closed" ? signed(t.netPnl) : "Open";
    const vcls = t.status === "closed" ? cls(t.netPnl) : "flat";
    return (
      '<div class="mini-row"><div class="mr-main"><strong>' + esc(t.symbol) +
      '</strong><span class="mr-sub">' + (t.tradeType === "swing" ? "Swing" : "Intraday") + " · " + esc(t.side) +
      " · " + esc(t.entryDate || "") + '</span></div><span class="mr-val ' + vcls + '">' + val + "</span></div>"
    );
  }
  const ROWFN = { alerts: alertRow, notifs: notifRow, trades: tradeRow };
  function renderPanel(key) {
    const host = $(HOSTID[key]);
    if (!host) return;
    const items = listData[key] || [];
    if (!items.length) {
      host.innerHTML = empty(EMPTYMSG[key]);
      return;
    }
    const show = expanded[key] ? items : items.slice(0, PREVIEW);
    let html = show.map(ROWFN[key]).join("");
    if (items.length > PREVIEW) {
      html +=
        '<button type="button" class="mini-more" data-more="' + key + '">' +
        (expanded[key] ? "Show less" : "See all (" + items.length + ")") +
        "</button>";
    }
    host.innerHTML = html;
    drawIcons();
  }

  async function load() {
    if (!(window.APP_AUTH && window.APP_AUTH.user)) return;
    const [summary, activeAlerts, notifs, trades] = await Promise.all([
      api("/api/trades/summary").catch(() => null),
      api("/api/alerts/active").catch(() => null),
      api("/api/notifications").catch(() => null),
      api("/api/trades").catch(() => null),
    ]);

    // ---- KPI strip ----
    const sc = (summary && summary.summary) || {};
    const closed = sc.closed || { netPnl: 0, count: 0 };
    const open = sc.open || { count: 0 };
    const alertsArr = (activeAlerts && activeAlerts.alerts) || [];
    const notifArr = (notifs && notifs.notifications) || [];
    const unread = notifArr.filter((n) => !n.readAt).length;
    const kpis = $("#dashUserKpis");
    if (kpis) {
      kpis.innerHTML =
        kpiCard("Net P&L (closed)", closed.count ? signed(closed.netPnl) : "-", cls(closed.netPnl), closed.count + " closed", "trending-up", true) +
        kpiCard("Open trades", String(open.count), "", "logged positions", "circle-dot") +
        kpiCard("Active alerts", String(alertsArr.length), "", "armed / triggered", "bell-ring") +
        kpiCard("Unread", String(unread), unread ? "accent" : "", "notifications", "bell");
    }

    // ---- expandable panels (first 3 + See all / Show less) ----
    listData.alerts = alertsArr;
    listData.notifs = notifArr;
    listData.trades = (trades && trades.trades) || [];
    renderPanel("alerts");
    renderPanel("notifs");
    renderPanel("trades");
    drawIcons();
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    const ov = $("#dashOverview");
    if (ov)
      ov.addEventListener("click", (e) => {
        const more = e.target.closest(".mini-more");
        if (more) {
          const k = more.dataset.more;
          expanded[k] = !expanded[k];
          renderPanel(k);
          return;
        }
        const link = e.target.closest("[data-goto]");
        if (!link) return;
        const goto = link.dataset.goto;
        if (goto === "notifications") {
          const nb = $("#notifBtn");
          if (nb) nb.click();
        } else {
          const tab = $("#view-tab-" + goto);
          if (tab) tab.click();
        }
      });
  }

  window.__initOverview = function () {
    bindOnce();
    load().catch(() => {});
  };
  window.__reloadOverview = function () {
    load().catch(() => {});
  };
})();
