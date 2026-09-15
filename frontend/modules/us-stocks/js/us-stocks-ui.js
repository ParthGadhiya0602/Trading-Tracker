// US Stocks view — a static, sector-grouped directory of large-cap US stocks. Each stock
// opens its chart on TradingView in a new tab. No live data, no backend call: the list is a
// curated constant below, so this view works offline and adds no feed/proxy surface.
//
// Safety notes:
//  - The list is hard-coded trusted data (no user/network input), and every rendered value is
//    still HTML-escaped, so nothing here can inject markup.
//  - Outbound links use target="_blank" + rel="noopener noreferrer" so the opened TradingView
//    tab gets no reference back to this window (no window.opener reverse-tabnabbing).
//  - The TradingView URL is built with encodeURIComponent on the EXCHANGE:SYMBOL pair only.
// Self-contained IIFE, bridged via window.__initUsStocks.
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  function drawIcons() {
    try {
      if (window.lucide) window.lucide.createIcons();
    } catch (_) {}
  }

  // Curated large-cap US names grouped by GICS-style sector. { s: symbol, n: name, x: exchange }.
  // Exchange drives the TradingView symbol (EXCHANGE:SYMBOL); TradingView still resolves the
  // ticker if an exchange is slightly off. Keep symbols uppercase and exchanges NYSE/NASDAQ.
  const SECTORS = [
    {
      sector: "Technology",
      stocks: [
        { s: "AAPL", n: "Apple", x: "NASDAQ" },
        { s: "MSFT", n: "Microsoft", x: "NASDAQ" },
        { s: "NVDA", n: "NVIDIA", x: "NASDAQ" },
        { s: "AVGO", n: "Broadcom", x: "NASDAQ" },
        { s: "ORCL", n: "Oracle", x: "NYSE" },
        { s: "CRM", n: "Salesforce", x: "NYSE" },
        { s: "ADBE", n: "Adobe", x: "NASDAQ" },
        { s: "AMD", n: "Advanced Micro Devices", x: "NASDAQ" },
        { s: "CSCO", n: "Cisco Systems", x: "NASDAQ" },
        { s: "ACN", n: "Accenture", x: "NYSE" },
        { s: "INTC", n: "Intel", x: "NASDAQ" },
        { s: "QCOM", n: "Qualcomm", x: "NASDAQ" },
        { s: "TXN", n: "Texas Instruments", x: "NASDAQ" },
        { s: "IBM", n: "IBM", x: "NYSE" },
        { s: "NOW", n: "ServiceNow", x: "NYSE" },
        { s: "INTU", n: "Intuit", x: "NASDAQ" },
      ],
    },
    {
      sector: "Communication Services",
      stocks: [
        { s: "GOOGL", n: "Alphabet (Class A)", x: "NASDAQ" },
        { s: "META", n: "Meta Platforms", x: "NASDAQ" },
        { s: "NFLX", n: "Netflix", x: "NASDAQ" },
        { s: "DIS", n: "Walt Disney", x: "NYSE" },
        { s: "CMCSA", n: "Comcast", x: "NASDAQ" },
        { s: "TMUS", n: "T-Mobile US", x: "NASDAQ" },
        { s: "T", n: "AT&T", x: "NYSE" },
        { s: "VZ", n: "Verizon", x: "NYSE" },
      ],
    },
    {
      sector: "Consumer Discretionary",
      stocks: [
        { s: "AMZN", n: "Amazon", x: "NASDAQ" },
        { s: "TSLA", n: "Tesla", x: "NASDAQ" },
        { s: "HD", n: "Home Depot", x: "NYSE" },
        { s: "MCD", n: "McDonald's", x: "NYSE" },
        { s: "NKE", n: "Nike", x: "NYSE" },
        { s: "SBUX", n: "Starbucks", x: "NASDAQ" },
        { s: "LOW", n: "Lowe's", x: "NYSE" },
        { s: "BKNG", n: "Booking Holdings", x: "NASDAQ" },
      ],
    },
    {
      sector: "Consumer Staples",
      stocks: [
        { s: "WMT", n: "Walmart", x: "NASDAQ" },
        { s: "PG", n: "Procter & Gamble", x: "NYSE" },
        { s: "KO", n: "Coca-Cola", x: "NYSE" },
        { s: "PEP", n: "PepsiCo", x: "NASDAQ" },
        { s: "COST", n: "Costco", x: "NASDAQ" },
        { s: "PM", n: "Philip Morris", x: "NYSE" },
        { s: "MDLZ", n: "Mondelez", x: "NASDAQ" },
        { s: "CL", n: "Colgate-Palmolive", x: "NYSE" },
      ],
    },
    {
      sector: "Financials",
      stocks: [
        { s: "JPM", n: "JPMorgan Chase", x: "NYSE" },
        { s: "V", n: "Visa", x: "NYSE" },
        { s: "MA", n: "Mastercard", x: "NYSE" },
        { s: "BAC", n: "Bank of America", x: "NYSE" },
        { s: "WFC", n: "Wells Fargo", x: "NYSE" },
        { s: "GS", n: "Goldman Sachs", x: "NYSE" },
        { s: "MS", n: "Morgan Stanley", x: "NYSE" },
        { s: "AXP", n: "American Express", x: "NYSE" },
        { s: "BLK", n: "BlackRock", x: "NYSE" },
        { s: "C", n: "Citigroup", x: "NYSE" },
        { s: "SCHW", n: "Charles Schwab", x: "NYSE" },
      ],
    },
    {
      sector: "Health Care",
      stocks: [
        { s: "LLY", n: "Eli Lilly", x: "NYSE" },
        { s: "UNH", n: "UnitedHealth", x: "NYSE" },
        { s: "JNJ", n: "Johnson & Johnson", x: "NYSE" },
        { s: "MRK", n: "Merck", x: "NYSE" },
        { s: "ABBV", n: "AbbVie", x: "NYSE" },
        { s: "PFE", n: "Pfizer", x: "NYSE" },
        { s: "TMO", n: "Thermo Fisher", x: "NYSE" },
        { s: "ABT", n: "Abbott", x: "NYSE" },
        { s: "DHR", n: "Danaher", x: "NYSE" },
        { s: "AMGN", n: "Amgen", x: "NASDAQ" },
        { s: "GILD", n: "Gilead Sciences", x: "NASDAQ" },
      ],
    },
    {
      sector: "Industrials",
      stocks: [
        { s: "CAT", n: "Caterpillar", x: "NYSE" },
        { s: "GE", n: "GE Aerospace", x: "NYSE" },
        { s: "BA", n: "Boeing", x: "NYSE" },
        { s: "HON", n: "Honeywell", x: "NASDAQ" },
        { s: "UPS", n: "United Parcel Service", x: "NYSE" },
        { s: "RTX", n: "RTX", x: "NYSE" },
        { s: "UNP", n: "Union Pacific", x: "NYSE" },
        { s: "LMT", n: "Lockheed Martin", x: "NYSE" },
        { s: "DE", n: "Deere", x: "NYSE" },
      ],
    },
    {
      sector: "Energy",
      stocks: [
        { s: "XOM", n: "ExxonMobil", x: "NYSE" },
        { s: "CVX", n: "Chevron", x: "NYSE" },
        { s: "COP", n: "ConocoPhillips", x: "NYSE" },
        { s: "SLB", n: "Schlumberger", x: "NYSE" },
        { s: "EOG", n: "EOG Resources", x: "NYSE" },
        { s: "MPC", n: "Marathon Petroleum", x: "NYSE" },
        { s: "PSX", n: "Phillips 66", x: "NYSE" },
      ],
    },
    {
      sector: "Utilities",
      stocks: [
        { s: "NEE", n: "NextEra Energy", x: "NYSE" },
        { s: "DUK", n: "Duke Energy", x: "NYSE" },
        { s: "SO", n: "Southern Company", x: "NYSE" },
        { s: "D", n: "Dominion Energy", x: "NYSE" },
        { s: "AEP", n: "American Electric Power", x: "NASDAQ" },
      ],
    },
    {
      sector: "Materials",
      stocks: [
        { s: "LIN", n: "Linde", x: "NASDAQ" },
        { s: "SHW", n: "Sherwin-Williams", x: "NYSE" },
        { s: "APD", n: "Air Products", x: "NYSE" },
        { s: "FCX", n: "Freeport-McMoRan", x: "NYSE" },
        { s: "NEM", n: "Newmont", x: "NYSE" },
        { s: "ECL", n: "Ecolab", x: "NYSE" },
      ],
    },
    {
      sector: "Real Estate",
      stocks: [
        { s: "PLD", n: "Prologis", x: "NYSE" },
        { s: "AMT", n: "American Tower", x: "NYSE" },
        { s: "EQIX", n: "Equinix", x: "NASDAQ" },
        { s: "PSA", n: "Public Storage", x: "NYSE" },
        { s: "O", n: "Realty Income", x: "NYSE" },
        { s: "SPG", n: "Simon Property", x: "NYSE" },
      ],
    },
  ];

  function tvUrl(stock) {
    return (
      "https://www.tradingview.com/chart/?symbol=" +
      encodeURIComponent(stock.x + ":" + stock.s)
    );
  }

  function render() {
    const host = $("#usSectors");
    if (!host) return;
    const total = SECTORS.reduce((n, g) => n + g.stocks.length, 0);
    host.innerHTML = SECTORS.map((group) => {
      const chips = group.stocks
        .map(
          (st) =>
            `<a class="us-chip" href="${esc(tvUrl(st))}" target="_blank" rel="noopener noreferrer"` +
            ` data-sym="${esc(st.s.toLowerCase())}" data-name="${esc(st.n.toLowerCase())}" data-exch="${esc(st.x)}"` +
            ` title="${esc(st.n)} — open ${esc(st.x)}:${esc(st.s)} on TradingView">` +
            `<span class="us-sym">${esc(st.s)}</span>` +
            `<span class="us-name">${esc(st.n)}</span>` +
            `<span class="us-exch">${esc(st.x)}</span>` +
            `</a>`,
        )
        .join("");
      return (
        `<section class="us-sector" data-sector="${esc(group.sector.toLowerCase())}">` +
        `<h3 class="us-sector-title">${esc(group.sector)}` +
        `<span class="us-count">${group.stocks.length}</span></h3>` +
        `<div class="us-chips">${chips}</div>` +
        `</section>`
      );
    }).join("");
    const asOf = $("#usAsOf");
    if (asOf) asOf.textContent = `${total} stocks · ${SECTORS.length} sectors`;
    drawIcons();
  }

  function applyFilter() {
    const query = String(($("#usSearch") || {}).value || "")
      .trim()
      .toLowerCase();
    const sector = ($("#usSectorFilter") || {}).value || ""; // "" = all, else lowercase sector
    const exch = ($("#usExchFilter") || {}).value || ""; // "" = all, else NASDAQ/NYSE
    let shown = 0;
    $$("#usSectors .us-sector").forEach((sec) => {
      // Sector dropdown hides whole sections; search + exchange filter individual chips.
      const sectorHit = !sector || sec.dataset.sector === sector;
      let visible = 0;
      $$(".us-chip", sec).forEach((chip) => {
        const textHit =
          !query ||
          chip.dataset.sym.includes(query) ||
          chip.dataset.name.includes(query) ||
          sec.dataset.sector.includes(query);
        const exchHit = !exch || chip.dataset.exch === exch;
        const hit = sectorHit && textHit && exchHit;
        chip.hidden = !hit;
        if (hit) visible += 1;
      });
      sec.hidden = visible === 0;
      shown += visible;
    });
    const asOf = $("#usAsOf");
    if (asOf) {
      const total = SECTORS.reduce((n, g) => n + g.stocks.length, 0);
      asOf.textContent =
        shown === total
          ? `${total} stocks · ${SECTORS.length} sectors`
          : `${shown} of ${total} stocks`;
    }
  }

  function fillSectorFilter() {
    const sel = $("#usSectorFilter");
    if (!sel) return;
    sel.innerHTML =
      `<option value="">All sectors</option>` +
      SECTORS.map(
        (g) =>
          `<option value="${esc(g.sector.toLowerCase())}">${esc(g.sector)}</option>`,
      ).join("");
  }

  let built = false;
  function init() {
    if (!built) {
      render();
      fillSectorFilter();
      const search = $("#usSearch");
      if (search) search.addEventListener("input", applyFilter);
      const sectorFilter = $("#usSectorFilter");
      if (sectorFilter) sectorFilter.addEventListener("change", applyFilter);
      const exchFilter = $("#usExchFilter");
      if (exchFilter) exchFilter.addEventListener("change", applyFilter);
      built = true;
    }
    drawIcons();
  }

  window.__initUsStocks = init;
})();
