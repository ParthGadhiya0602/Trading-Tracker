      "use strict";
      const API = "/api/indices";
      // default list; replaced at startup by the server's index list (/api/alert-config)
      let INDEX_NAMES = [
        "NIFTY 50",
        "NIFTY NEXT 50",
        "NIFTY MIDCAP 50",
        "NIFTY MIDCAP 100",
      ];
      const niceLabel = (n) =>
        n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      const eq = (a, b) =>
        a != null &&
        b != null &&
        !isNaN(a) &&
        !isNaN(b) &&
        Math.round(a * 100) === Math.round(b * 100); // equal to the paisa

      // type: sym | rs (rupee price) | delta (₹ + %) | vol
      const COLS = [
        {
          key: "symbol",
          label: "Symbol",
          type: "sym",
          tip: "Trading symbol. Hover a row for its Open→High and Open→Low %.",
        },
        {
          key: "lastPrice",
          label: "LTP",
          type: "rs",
          tip: "Last traded price - the current live price.",
        },
        {
          key: "open",
          label: "Open",
          type: "rs",
          tip: "Official day open (pre-open auction price, frozen at 09:15 IST).",
        },
        {
          key: "dayHigh",
          label: "High",
          type: "rs",
          tip: "Highest traded price so far today.",
        },
        {
          key: "dayLow",
          label: "Low",
          type: "rs",
          tip: "Lowest traded price so far today.",
        },
        {
          key: "prevClose",
          label: "Prev Close",
          type: "rs",
          tip: "Previous trading day's closing price.",
        },
        {
          key: "pChange",
          label: "Change",
          type: "delta",
          rs: "change",
          pc: "pChange",
          tip: "₹ and % change vs previous close (not vs today's open).",
        },
        {
          key: "totalTradedVolume",
          label: "Volume",
          type: "vol",
          tip: "Total shares traded today.",
        },
      ];

      let sortKey = "pChange",
        sortDir = -1;
      let activeTab = "all"; // all | high | low | neutral
      let activeIndex = "NIFTY 50"; // NIFTY 50 | NIFTY NEXT 50
      let searchQuery = ""; // filters the current index's table by symbol / company
      let cache = null, // { "NIFTY 50": {...}, "NIFTY NEXT 50": {...} }
        lastGoodAt = 0,
        timer = null;

      // tab filter: high = at day high (green), low = at day low (red), neutral = rest.
      function tabMatch(r) {
        return (
          activeTab === "all" ||
          (activeTab === "high" && r.colorRank === 1) ||
          (activeTab === "low" && r.colorRank === -1) ||
          (activeTab === "neutral" && r.colorRank === 0)
        );
      }
      // free-text search over symbol + company name (empty query matches all)
      function searchMatch(r) {
        if (!searchQuery) return true;
        return (
          r.symbol.toLowerCase().includes(searchQuery) ||
          (r.companyName || "").toLowerCase().includes(searchQuery)
        );
      }

      // ---------- formatting ----------
      function rs(v) {
        return v == null || isNaN(v)
          ? "-"
          : "₹" +
              v.toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
      }
      function pct(v) {
        return v == null || isNaN(v)
          ? "-"
          : (v > 0 ? "+" : "") + v.toFixed(2) + "%";
      }
      function vol(v) {
        if (v == null || isNaN(v)) return "-";
        if (v >= 1e7) return (v / 1e7).toFixed(2) + " Cr";
        if (v >= 1e5) return (v / 1e5).toFixed(2) + " L";
        if (v >= 1e3) return (v / 1e3).toFixed(1) + " K";
        return String(v);
      }
      function cls(v) {
        return v > 0 ? "up" : v < 0 ? "down" : "flat";
      }
      // click a symbol to copy it to the clipboard, with a brief "Copied" flash
      function flashCopied(el, label) {
        const t = document.createElement("div");
        t.className = "copytip";
        t.textContent = label;
        document.body.appendChild(t);
        const r = el.getBoundingClientRect();
        t.style.left = r.left + "px";
        t.style.top = r.top - 26 + "px";
        requestAnimationFrame(() => t.classList.add("show"));
        setTimeout(() => {
          t.classList.remove("show");
          setTimeout(() => t.remove(), 200);
        }, 900);
      }
      async function copySymbol(sym, el) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText)
            await navigator.clipboard.writeText(sym);
          else {
            const ta = document.createElement("textarea");
            ta.value = sym;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
          }
          flashCopied(el, "Copied " + sym);
        } catch (_) {
          flashCopied(el, "Copy failed");
        }
      }
      // index level is points, not rupees - no ₹ prefix
      function pts(v) {
        return v == null || isNaN(v)
          ? "-"
          : v.toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
      }

      // ---------- stock detail modal ----------
      function fmtTurnover(v) {
        if (v == null || isNaN(v)) return "-";
        if (v >= 1e7) return "₹" + (v / 1e7).toFixed(2) + " Cr";
        if (v >= 1e5) return "₹" + (v / 1e5).toFixed(2) + " L";
        return "₹" + Math.round(v).toLocaleString("en-IN");
      }
      const pctC = (v) => `<span class="${cls(v)}">${pct(v)}</span>`;

      // ---------- pre-open order book (10-level depth ladder, stock detail modal) ----------
      function escText(s) {
        return String(s).replace(
          /[&<>"']/g,
          (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
        );
      }
      // absent/0 quantity -> em-dash with a muted class (vol() would otherwise show "0")
      function pobQty(v) {
        return v == null || isNaN(v) || +v === 0
          ? '<span class="v num pob-dash">—</span>'
          : `<span class="v num">${vol(v)}</span>`;
      }
      function pobCellQty(v) {
        return v == null || isNaN(v) || +v === 0
          ? '<span class="pob-qty pob-dash">—</span>'
          : `<span class="pob-qty">${vol(v)}</span>`;
      }
      // renders (or clears) the #sm-preopen section from a computed row's r.preOpen
      function renderPreOpen(section, po) {
        section.hidden = true;
        section.innerHTML = "";
        if (!po || typeof po !== "object") return;
        const ladder = Array.isArray(po.ladder) ? po.ladder.slice() : [];
        ladder.sort((a, b) => (+b.price || 0) - (+a.price || 0)); // high -> low
        const totalBuy = +po.totalBuyQty || 0;
        const totalSell = +po.totalSellQty || 0;
        const sumBS = totalBuy + totalSell;
        const buyPct = sumBS > 0 ? Math.round((totalBuy / sumBS) * 100) : 0;
        const sellPct = sumBS > 0 ? 100 - buyPct : 0;
        const maxQty = Math.max(
          1,
          ...ladder.flatMap((l) => [+l.buyQty || 0, +l.sellQty || 0]),
        );
        const ladderHasQty = ladder.some(
          (l) => (+l.buyQty || 0) + (+l.sellQty || 0) > 0,
        );
        const timeHtml = po.lastUpdateTime
          ? `<span class="pob-time num" id="pob-time">${escText(po.lastUpdateTime)}</span>`
          : "";
        const iepHtml =
          po.iep == null || isNaN(po.iep) || +po.iep === 0
            ? '<span class="v num pob-dash">—</span>'
            : `<span class="v num">${rs(+po.iep)}</span>`;
        const pressureHtml =
          sumBS > 0
            ? `<div class="pob-pressure" role="img" aria-label="Buy pressure ${buyPct} percent (${vol(totalBuy)}), sell pressure ${sellPct} percent (${vol(totalSell)})">
                 <div class="pob-bar"><span class="pob-buy" style="width:${buyPct}%"></span><span class="pob-sell" style="width:${sellPct}%"></span></div>
                 <div class="pob-legend"><span class="up">Buy ${vol(totalBuy)} · ${buyPct}%</span><span class="down">${sellPct}% · ${vol(totalSell)} Sell</span></div>
               </div>`
            : `<div class="pob-pressure" role="img" aria-label="No quantity yet">
                 <div class="pob-bar flat"></div>
                 <div class="pob-legend flat"><span>No quantity yet</span></div>
               </div>`;
        const ladderRows = ladder
          .map((l) => {
            const b = +l.buyQty || 0,
              s = +l.sellQty || 0;
            const bw = b > 0 ? (b / maxQty) * 100 : 0;
            const sw = s > 0 ? (s / maxQty) * 100 : 0;
            return `<tr class="pob-row${l.iep ? " is-iep" : ""}">
              <td class="buy">${b > 0 ? `<span class="depth" style="width:${bw}%"></span>` : ""}${pobCellQty(b)}</td>
              <td class="price">${rs(+l.price)}</td>
              <td class="ask">${s > 0 ? `<span class="depth" style="width:${sw}%"></span>` : ""}${pobCellQty(s)}</td>
            </tr>`;
          })
          .join("");
        const ladderHtml =
          ladder.length && ladderHasQty
            ? `<table class="pob-ladder">
                 <caption class="sr-only">Ten level bid and ask depth ladder</caption>
                 <thead><tr><th scope="col" class="buy">Buy Qty</th><th scope="col" class="mid">Price</th><th scope="col" class="ask">Sell Qty</th></tr></thead>
                 <tbody>${ladderRows}</tbody>
               </table>`
            : `<div class="pob-empty">Depth not yet available for this stock.</div>`;
        section.innerHTML = `
          <div class="pob-head">
            <span class="pob-tag">PRE-OPEN</span>
            <span class="pob-title">Order book · depth</span>
            ${timeHtml}
          </div>
          <div class="pob-summary">
            <div class="pob-stat"><span class="k">IEP</span>${iepHtml}</div>
            <div class="pob-stat"><span class="k">Matched</span>${pobQty(po.finalQty)}</div>
            <div class="pob-stat"><span class="k">ATO Buy</span>${pobQty(po.ato && po.ato.buyQty)}</div>
            <div class="pob-stat"><span class="k">ATO Sell</span>${pobQty(po.ato && po.ato.sellQty)}</div>
          </div>
          ${pressureHtml}
          ${ladderHtml}
        `;
        section.hidden = false;
      }

      let modalSymbol = null; // symbol currently shown in the stock detail modal
      function openStockModal(r) {
        modalSymbol = r.symbol;
        document.getElementById("sm-sym").textContent = r.symbol;
        document.getElementById("sm-name").textContent = r.companyName || "";
        document.getElementById("sm-ltp").textContent = rs(r.lastPrice);
        const d = document.getElementById("sm-delta");
        d.className = "delta " + cls(r.change);
        const absRs = isNaN(r.change) ? r.change : Math.abs(r.change);
        d.innerHTML = rs(absRs) + `<span class="pc">${pct(r.pChange)}</span>`;
        const cells = [
          ["Open", rs(r.open)],
          ["Prev Close", rs(r.prevClose)],
          ["Day High", rs(r.dayHigh)],
          ["Day Low", rs(r.dayLow)],
          ["Open → High", pctC(r.ohPct)],
          ["Open → Low", pctC(r.olPct)],
          ["52-week High", rs(r.yearHigh)],
          ["52-week Low", rs(r.yearLow)],
          ["% from 52W High", pctC(r.nearWKH)],
          ["% from 52W Low", pctC(r.nearWKL)],
          ["30-day change", pctC(r.perChange30d)],
          ["1-year change", pctC(r.perChange365d)],
          ["Volume", vol(r.totalTradedVolume)],
          ["Turnover", fmtTurnover(r.totalTradedValue)],
        ];
        document.getElementById("sm-grid").innerHTML = cells
          .map(
            ([k, v]) =>
              `<div class="cell"><span class="k">${k}</span><span class="v">${v}</span></div>`,
          )
          .join("");
        renderPreOpen(document.getElementById("sm-preopen"), r.preOpen);
        document.getElementById("stockModal").classList.add("show");
      }
      function closeStockModal() {
        document.getElementById("stockModal").classList.remove("show");
      }
      document.getElementById("sm-close").onclick = closeStockModal;
      // "Add alert" → close this modal, open the create-alert modal prefilled
      document.getElementById("sm-addalert").onclick = () => {
        closeStockModal();
        if (window.openCreateAlert) window.openCreateAlert(activeIndex, modalSymbol);
      };
      document.getElementById("stockModal").addEventListener("click", (e) => {
        if (e.target.id === "stockModal") closeStockModal();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeStockModal();
      });

      // ---------- IST market-hours (correct regardless of viewer timezone) ----------
      function istParts(d) {
        const f = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Kolkata",
          hour12: false,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
        const o = {};
        f.formatToParts(d).forEach((p) => (o[p.type] = p.value));
        return o;
      }
      // pre-open 09:00-09:15, open 09:15-15:30, else closed (IST, Mon-Fri)
      function marketState(d) {
        const p = istParts(d);
        if (p.weekday === "Sat" || p.weekday === "Sun") return "closed";
        const mins = (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10);
        if (mins >= 9 * 60 && mins < 9 * 60 + 15) return "pre-open";
        if (mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30) return "open";
        return "closed";
      }
      function fmtClock(d) {
        const h12 = document.getElementById("tf").value === "12";
        return (
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Kolkata",
            hour12: h12,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }).format(d) + " IST"
        );
      }

      // ---------- transform the feed payload -> rows with ₹ + % diffs + row color ----------
      function computeRows(payload) {
        const rows = (payload.data || []).filter(
          (r) => r.symbol && !INDEX_NAMES.includes(r.symbol),
        );
        return rows.map((r) => {
          const open = +r.open,
            high = +r.dayHigh,
            low = +r.dayLow,
            last = +r.lastPrice;
          const ok = open > 0; // guard divide-by-zero (pre-market)
          const ohRs = ok ? high - open : NaN,
            olRs = ok ? low - open : NaN;
          const ohPct = ok ? (ohRs / open) * 100 : NaN,
            olPct = ok ? (olRs / open) * 100 : NaN;
          // Row color (exact match, no tolerance) - based on Open vs High/Low only
          // (no current-price check):
          //   red    when Open = High  (stock never traded above its open today)
          //   green  when Open = Low   (stock never traded below its open today)
          //   default otherwise
          // colorRank stays 1=at-high, -1=at-low for the tab filters.
          let rowClass = "",
            colorRank = 0;
          if (ok) {
            if (eq(open, high) && !eq(high, low)) {
              colorRank = 1;
              rowClass = "down-row";
            } // open == high -> red
            else if (eq(open, low) && !eq(high, low)) {
              colorRank = -1;
              rowClass = "up-row";
            } // open == low -> green
          }
          const nf = (v) => (v != null ? +v : NaN);
          return {
            symbol: r.symbol,
            companyName: r.companyName || "",
            open,
            dayHigh: high,
            dayLow: low,
            lastPrice: last,
            prevClose: nf(r.prevClose),
            change: nf(r.change),
            pChange: nf(r.pChange),
            totalTradedVolume: nf(r.totalTradedVolume),
            totalTradedValue: nf(r.totalTradedValue),
            yearHigh: nf(r.yearHigh),
            yearLow: nf(r.yearLow),
            nearWKH: nf(r.nearWKH),
            nearWKL: nf(r.nearWKL),
            perChange30d: nf(r.perChange30d),
            perChange365d: nf(r.perChange365d),
            ohRs,
            olRs,
            ohPct,
            olPct,
            rowClass,
            colorRank,
            ...(r.preOpen ? { preOpen: r.preOpen } : {}),
          };
        });
      }

      // ---------- render ----------
      function renderHead() {
        const tr = document.getElementById("head");
        tr.innerHTML = "";
        COLS.forEach((c) => {
          const th = document.createElement("th");
          const sorted = c.key === sortKey;
          th.className = sorted ? "sorted" : "";
          th.tabIndex = 0;
          th.setAttribute("role", "columnheader button");
          th.setAttribute(
            "aria-sort",
            sorted ? (sortDir > 0 ? "ascending" : "descending") : "none",
          );
          const labelSpan = c.tip
            ? `<span class="hint" data-tip="${c.tip}">${c.label}</span>`
            : c.label;
          th.innerHTML =
            labelSpan +
            `<span class="arrow">${sorted ? (sortDir > 0 ? "▲" : "▼") : "↕"}</span>`;
          const doSort = () => {
            if (sortKey === c.key) sortDir = -sortDir;
            else {
              sortKey = c.key;
              sortDir = c.type === "sym" ? 1 : -1;
            }
            renderHead();
            renderBody();
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
      function deltaCell(rsVal, pcVal) {
        const c = cls(pcVal);
        const absRs = rsVal == null || isNaN(rsVal) ? rsVal : Math.abs(rsVal);
        return `<span class="delta ${c}">${rs(absRs)}<span class="pc">${pct(pcVal)}</span></span>`;
      }
      function renderTabs(all) {
        const c = {
          all: all.length,
          high: all.filter((r) => r.colorRank === 1).length,
          low: all.filter((r) => r.colorRank === -1).length,
          neutral: all.filter((r) => r.colorRank === 0).length,
        };
        document.querySelectorAll("#tabs .tab").forEach((b) => {
          const active = b.dataset.tab === activeTab;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", String(active));
          const cnt = b.querySelector(".cnt");
          if (cnt) cnt.textContent = c[b.dataset.tab];
        });
      }
      function renderBody() {
        const body = document.getElementById("body");
        const payload = cache && cache[activeIndex];
        if (!payload) return;
        const all = computeRows(payload);
        if (all.length === 0) {
          renderTabs(all);
          body.innerHTML = `<tr class="loading"><td colspan="${COLS.length}">No constituents for ${activeIndex} - this data is live only during market hours (Mon–Fri 09:15–15:30 IST). The table fills automatically when the market opens.</td></tr>`;
          return;
        }
        renderTabs(all);
        const rows = all.filter(tabMatch).filter(searchMatch);
        if (rows.length === 0) {
          const msg = searchQuery
            ? `No stocks match “${searchQuery}” in ${activeIndex}.`
            : `No stocks currently ${activeTab === "high" ? "at their day high" : activeTab === "low" ? "at their day low" : "in this group"}.`;
          body.innerHTML = `<tr class="loading"><td colspan="${COLS.length}">${msg}</td></tr>`;
          return;
        }
        rows.sort((a, b) => {
          let x = a[sortKey],
            y = b[sortKey];
          if (typeof x === "string") return x.localeCompare(y) * sortDir;
          if (isNaN(x)) x = -Infinity;
          if (isNaN(y)) y = -Infinity;
          if (x !== y) return (x - y) * sortDir;
          // tie-break by day change % (desc) so grouped rows (e.g. At High/At Low) read sensibly
          const px = isNaN(a.pChange) ? -Infinity : a.pChange,
            py = isNaN(b.pChange) ? -Infinity : b.pChange;
          return py - px;
        });
        body.innerHTML = "";
        for (const r of rows) {
          const tr = document.createElement("tr");
          tr.className = r.rowClass;
          tr.style.cursor = "pointer";
          tr.onclick = () => openStockModal(r);
          COLS.forEach((c) => {
            const td = document.createElement("td");
            if (c.type === "sym") {
              td.className = "sym";
              const wrap = document.createElement("span");
              wrap.className = "symwrap hint";
              wrap.setAttribute(
                "data-tip",
                `Open→High ${pct(r.ohPct)} · Open→Low ${pct(r.olPct)} · click to copy`,
              );
              wrap.tabIndex = 0;
              wrap.setAttribute("role", "button");
              wrap.setAttribute("aria-label", `Copy ${r.symbol}`);
              wrap.onclick = (e) => {
                e.stopPropagation(); // don't open the detail modal when copying
                copySymbol(r.symbol, wrap);
              };
              wrap.onkeydown = (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  copySymbol(r.symbol, wrap);
                }
              };
              const dot = document.createElement("span");
              dot.className =
                "dotmark " +
                (r.colorRank === 1
                  ? "down"
                  : r.colorRank === -1
                    ? "up"
                    : "flat");
              dot.setAttribute("aria-hidden", "true");
              wrap.appendChild(dot);
              wrap.appendChild(document.createTextNode(r.symbol));
              td.appendChild(wrap);
            } else if (c.type === "rs") {
              td.className = "num";
              td.textContent = rs(r[c.key]);
            } else if (c.type === "vol") {
              td.className = "num";
              td.textContent = vol(r[c.key]);
            } else if (c.type === "delta") {
              td.innerHTML = deltaCell(r[c.rs], r[c.pc]);
            }
            tr.appendChild(td);
          });
          body.appendChild(tr);
        }
      }
      // ---------- index headline cards: BOTH indices' own points values, always
      // shown side by side (independent of which tab is active) ----------
      function renderIndexCards() {
        const host = document.getElementById("idxCards");
        host.innerHTML = INDEX_NAMES.map((name) => {
          const payload = cache && cache[name];
          const lv = payload && payload.level;
          const activeCls = name === activeIndex ? " active" : "";
          if (!lv || lv.last == null) {
            // Pre-open (or no data yet) - keep the card visible & clickable so it
            // still works as the index selector; just show a minimal placeholder.
            const tag =
              payload && payload.marketStatus === "Pre-open"
                ? "PRE-OPEN"
                : "NO DATA";
            return (
              `<div class="idxcard idxcard-mini${activeCls}" data-index="${name}" role="button" tabindex="0" aria-label="Show ${name}">` +
              `<span class="idxcard-name">${name}</span>` +
              `<span class="idxcard-preopen">${tag}</span>` +
              `</div>`
            );
          }
          const c = cls(lv.variation);
          const absPts =
            lv.variation == null || isNaN(lv.variation)
              ? lv.variation
              : Math.abs(lv.variation);
          const sign = lv.variation > 0 ? "+" : lv.variation < 0 ? "−" : "";
          const stats = [
            ["Open", pts(lv.open)],
            ["High", pts(lv.high)],
            ["Low", pts(lv.low)],
            ["Prev", pts(lv.prevClose)],
            ["52W H", pts(lv.yearHigh)],
            ["52W L", pts(lv.yearLow)],
            ["1Y", pct(lv.perChange365d)],
          ]
            .map(([k, v]) => `<span>${k}<b>${v}</b></span>`)
            .join("");
          return (
            `<div class="idxcard${activeCls}" data-index="${name}" role="button" tabindex="0" aria-label="Show ${name}">` +
            `<span class="idxcard-name">${name}</span>` +
            `<span class="idxcard-row">` +
            `<span class="idxcard-pts num">${pts(lv.last)}</span>` +
            `<span class="delta ${c}">${sign + pts(absPts)}<span class="pc">${pct(lv.pChange)}</span></span>` +
            `</span>` +
            `<span class="idxcard-stats">${stats}</span>` +
            `</div>`
          );
        }).join("");
      }

      // ---------- meta / status ----------
      function renderMeta() {
        const upd = document.getElementById("updated"),
          staleEl = document.getElementById("staleMsg"),
          advEl = document.getElementById("adv");
        const payload = cache && cache[activeIndex];
        if (lastGoodAt) {
          const secsAgo = Math.round((Date.now() - lastGoodAt) / 1000);
          upd.textContent =
            `Updated ${fmtClock(new Date(lastGoodAt))}` +
            (payload && payload.timestamp
              ? ` · stamp ${payload.timestamp}`
              : "");
          const pollMs = (+document.getElementById("poll").value || 5) * 1000;
          if (secsAgo * 1000 > 3 * pollMs) {
            staleEl.className = "stale";
            staleEl.textContent = `⚠ stale - ${secsAgo}s old`;
          } else staleEl.textContent = "";
        }
        if (payload && payload.advance) {
          const a = payload.advance;
          advEl.innerHTML = `<span class="badge up" data-tip="Stocks up more than 0.05% vs previous close.">▲ ${a.advances}</span> <span class="badge down" data-tip="Stocks down more than 0.05% vs previous close.">▼ ${a.declines}</span> <span class="badge" data-tip="Stocks within ±0.05% of previous close.">▬ ${a.unchanged}</span>`;
        } else {
          advEl.innerHTML = "";
        }
      }
      function renderMarketStatus() {
        const st = marketState(new Date());
        document.getElementById("dot").className =
          "dot " + (st === "open" ? "open" : st === "pre-open" ? "preopen" : "closed");
        document.getElementById("mktText").textContent =
          st === "open"
            ? "Market OPEN"
            : st === "pre-open"
              ? "PRE-OPEN"
              : "Market CLOSED";
        return st !== "closed"; // poll during pre-open + open
      }

      // ---------- fetch (in-memory cache keeps last good on failure) ----------
      async function refresh() {
        const btn = document.getElementById("refresh");
        const tablewrap = document.querySelector(".tablewrap");
        btn.disabled = true;
        document.getElementById("refreshIcon").classList.add("spin");
        tablewrap.classList.add("loading");
        try {
          const res = await fetch(API + "?t=" + Date.now(), {
            cache: "no-store",
          });
          const text = await res.text();
          let json;
          try {
            json = JSON.parse(text);
          } catch (_) {
            throw new Error(
              location.protocol === "file:"
                ? "opened as a file - start the server (./run.sh) and open http://localhost:8787/"
                : "server didn't return JSON - open via http://localhost:8787/, not the file",
            );
          }
          if (!res.ok || json.error)
            throw new Error(json.error || "HTTP " + res.status);
          cache = json;
          lastGoodAt = Date.now();
          document.getElementById("staleMsg").textContent = "";
          renderIndexCards();
          renderBody();
          renderMeta();
        } catch (e) {
          const staleEl = document.getElementById("staleMsg");
          staleEl.className = "err";
          staleEl.textContent =
            "⚠ fetch failed: " +
            e.message +
            (cache ? " (showing last good data)" : "");
          renderMeta();
        } finally {
          btn.disabled = false;
          document.getElementById("refreshIcon").classList.remove("spin");
          tablewrap.classList.remove("loading");
        }
      }

      // ---------- scheduler: auto-poll only in market hours; manual always allowed ----------
      function schedule() {
        if (timer) clearTimeout(timer);
        const open = renderMarketStatus();
        const secs = Math.max(
          1,
          Math.min(10, +document.getElementById("poll").value || 5),
        );
        if (open) refresh();
        timer = setTimeout(schedule, secs * 1000);
      }

      // ---------- wire up ----------
      document.getElementById("refresh").onclick = refresh;
      document.getElementById("poll").onchange = schedule;
      document.getElementById("tf").onchange = renderMeta;
      document.getElementById("search").oninput = (e) => {
        searchQuery = e.target.value.trim().toLowerCase();
        renderBody();
      };
      document.querySelectorAll("#tabs .tab").forEach((b) => {
        b.onclick = () => {
          activeTab = b.dataset.tab;
          renderBody();
        };
      });
      // KPI index cards double as the index selector (event-delegated)
      document.getElementById("idxCards").addEventListener("click", (e) => {
        const card = e.target.closest(".idxcard");
        if (card && card.dataset.index) selectIndex(card.dataset.index);
      });
      document.getElementById("idxCards").addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          const card = e.target.closest(".idxcard");
          if (card && card.dataset.index) {
            e.preventDefault();
            selectIndex(card.dataset.index);
          }
        }
      });
      function selectIndex(index) {
        if (activeIndex === index) return;
        activeIndex = index;
        document.querySelectorAll("#idxCards .idxcard").forEach((x) => {
          x.classList.toggle("active", x.dataset.index === index);
        });
        document.getElementById("idxName").textContent = activeIndex;
        document.title = activeIndex + " - OHL Tracker";
        activeTab = "all";
        renderBody();
        renderMeta();
      }
      // ---------- tooltips: one JS-driven, position:fixed tooltip for the whole
      // page (a CSS ::after popover has no room to render above elements pinned
      // to the top of an overflow:auto ancestor - e.g. the table's sticky header
      // - and gets silently clipped there, so this needs to escape that everywhere,
      // not just inside the table) ----------
      (function () {
        const tt = document.getElementById("tt");
        const ttText = document.getElementById("ttText");
        let activeEl = null,
          showTimer = null;

        function place(el) {
          const r = el.getBoundingClientRect();
          tt.style.left = "0px";
          tt.style.top = "0px";
          tt.classList.remove("flip");
          const tr = tt.getBoundingClientRect();
          let left = r.left + r.width / 2 - tr.width / 2;
          left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
          let top = r.top - tr.height - 10;
          let flip = false;
          if (top < 6) {
            top = r.bottom + 10; // flip below if no room above
            flip = true;
          }
          tt.classList.toggle("flip", flip);
          // keep the arrow pointed at the trigger even after the box got clamped sideways
          const arrowLeft = Math.max(
            10,
            Math.min(r.left + r.width / 2 - left, tr.width - 10),
          );
          tt.style.setProperty("--arrow-left", arrowLeft + "px");
          tt.style.left = left + "px";
          tt.style.top = top + "px";
        }
        function show(el) {
          const text = el.getAttribute("data-tip");
          if (!text) return;
          ttText.textContent = text;
          tt.classList.add("show");
          place(el);
        }
        function hide() {
          clearTimeout(showTimer);
          activeEl = null;
          tt.classList.remove("show");
        }
        document.addEventListener("mouseover", (e) => {
          const el = e.target.closest("[data-tip]");
          if (!el || el === activeEl) return;
          clearTimeout(showTimer);
          activeEl = el;
          showTimer = setTimeout(() => {
            if (activeEl === el) show(el);
          }, 120); // brief delay so tooltips don't flicker while passing over cells
        });
        document.addEventListener("mouseout", (e) => {
          const el = e.target.closest("[data-tip]");
          if (el && !el.contains(e.relatedTarget)) hide();
        });
        document.addEventListener("focusin", (e) => {
          const el = e.target.closest("[data-tip]");
          if (el) show(el);
        });
        document.addEventListener("focusout", hide);

        const wrap = document.querySelector(".tablewrap");
        wrap.addEventListener("scroll", () => {
          hide();
          wrap.classList.toggle("scrolled", wrap.scrollTop > 0);
        });
      })();

      async function init() {
        try {
          const cfg = await (await fetch("/api/alert-config")).json();
          if (Array.isArray(cfg.indices) && cfg.indices.length)
            INDEX_NAMES = cfg.indices;
        } catch (_) {
          /* keep default INDEX_NAMES */
        }
        activeIndex = INDEX_NAMES[0];
        document.getElementById("idxName").textContent = activeIndex;
        if (window.lucide) lucide.createIcons(); // render the static chrome icons
        renderHead();
        renderMarketStatus();
        refresh();
        schedule();
        setInterval(() => {
          renderMarketStatus();
          renderMeta();
        }, 1000);
      }
      // started by the auth controller once the user is signed in (see #authOverlay script)
      window.__initDash = init;
