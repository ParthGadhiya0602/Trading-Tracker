      (function () {
        "use strict";
        const $ = (s) => document.querySelector(s);
        const $$ = (s) => document.querySelectorAll(s);

        let alertIndex = "NIFTY 50";
        let ALERT_INDICES = [
          "NIFTY 50",
          "NIFTY NEXT 50",
          "NIFTY MIDCAP 50",
          "NIFTY MIDCAP 100",
        ];
        let CASH_ALERT_INDICES = [...ALERT_INDICES];
        const niceLabel = (n) =>
          n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
        const alertMarketLabel = (alert) =>
          alert.market === "stock-future"
            ? `Stock future · ${alert.contractExpiry || "Expiry unavailable"}`
            : alert.market === "index-future"
              ? `Index future · ${alert.contractExpiry || "Expiry unavailable"}`
            : alert.market === "index-option" || alert.market === "stock-option"
              ? `${alert.optionType || "Option"} ${alert.strike || ""} · ${alert.contractExpiry || "Expiry unavailable"}`
            : alert.index;
        let editId = null;
        let editVersion = null;
        let SYMS = {};
        let ALERT_CREATORS = [];
        let OFFSETS = {}; // { timeframe: pct } from the server
        let DEFAULT_OFFSET = 10;
        let curPrice = 0; // live price of the selected symbol (for the trigger preview)
        let DERIVATIVE_STOCKS = null;
        let CONTRACT_CHOICES = [];
        let contractRequest = 0;
        let allAlerts = []; // active alerts (pre-filter)
        let allArchived = []; // archived (closed) alerts
        let alertView = "active"; // "active" | "closed" (segmented toggle)

        const TF_GROUPS = [
          ["Seconds", ["1s", "5s", "10s", "15s", "30s", "45s"]],
          ["Minutes", ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "45m"]],
          ["Hours", ["1h", "2h", "3h", "4h"]],
          ["Days", ["1d", "1w", "1mo", "3mo", "6mo", "12mo"]],
        ];

        // ---------- multi-select list filters (with removable chips) ----------
        // `opts` may be an array or a function (evaluated at build time) — the Index
        // filter's options come from the dynamic ALERT_INDICES list.
        const FILTER_DEFS = [
          {
            key: "index",
            label: "Index",
            opts: () => ALERT_INDICES.map((n) => [n, niceLabel(n)]),
          },
          {
            key: "status",
            label: "Status",
            opts: [
              ["armed", "Armed"],
              ["triggered", "Alerted"],
              ["active", "Active (entered)"],
              ["closed", "Closed"],
            ],
          },
          {
            key: "side",
            label: "Side",
            opts: [
              ["BUY", "Buy"],
              ["SELL", "Sell"],
            ],
          },
          {
            key: "tf",
            label: "Time frame",
            opts: TF_GROUPS.flatMap(([, vals]) => vals.map((v) => [v, v])),
          },
          {
            key: "review",
            label: "Review",
            opts: [
              ["pending", "Pending"],
              ["approved", "Approved"],
              ["rejected", "Rejected"],
            ],
          },
          {
            key: "outcome",
            label: "Outcome",
            opts: [
              ["pending", "Pending"],
              ["fail", "Fail"],
              ["partial", "Partial"],
              ["success", "Success"],
            ],
          },
          {
            key: "signal",
            label: "Signal",
            opts: [["FINAL_REALERT", "Entry next"]],
          },
        ];
        const sel = {
          index: new Set(),
          status: new Set(),
          side: new Set(),
          tf: new Set(),
          review: new Set(),
          outcome: new Set(),
          signal: new Set(),
        };
        const optsOf = (def) =>
          typeof def.opts === "function" ? def.opts() : def.opts;
        const optLabel = (key, val) => {
          const d = FILTER_DEFS.find((f) => f.key === key);
          const o = d && optsOf(d).find((o) => o[0] === val);
          return o ? o[1] : val;
        };
        function closeMenus() {
          $$("#alertFilters .ms-menu").forEach((m) => {
            m.hidden = true;
            const btn = m.parentElement.querySelector(".ms-btn");
            if (btn) btn.setAttribute("aria-expanded", "false");
          });
        }
        function buildFilters() {
          const host = $("#alertFilters");
          host.innerHTML = "";
          const advancedKeys = new Set(["tf", "review", "outcome", "signal"]);
          const advanced = document.createElement("div");
          advanced.className = "ms-advanced";
          advanced.id = "advancedFilters";
          advanced.hidden = true;
          for (const def of FILTER_DEFS) {
            const wrap = document.createElement("div");
            wrap.className = "ms";
            wrap.dataset.filterKey = def.key;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "ms-btn";
            btn.id = `filter-${def.key}-button`;
            btn.setAttribute("aria-expanded", "false");
            btn.setAttribute("aria-controls", `filter-${def.key}-menu`);
            btn.innerHTML = `<span>${def.label} <span class="ms-count"></span></span><i data-lucide="chevron-down"></i>`;
            const menu = document.createElement("div");
            menu.className = "ms-menu";
            menu.id = `filter-${def.key}-menu`;
            menu.setAttribute("role", "group");
            menu.setAttribute("aria-labelledby", btn.id);
            menu.hidden = true;
            menu.onclick = (e) => e.stopPropagation(); // keep menu open while ticking
            for (const [val, lab] of optsOf(def)) {
              const item = document.createElement("label");
              item.className = "ms-item";
              const cb = document.createElement("input");
              cb.type = "checkbox";
              cb.value = val;
              cb.checked = sel[def.key].has(val);
              cb.onchange = () => {
                cb.checked ? sel[def.key].add(val) : sel[def.key].delete(val);
                updateFilterUI();
                applyFilters();
              };
              const sp = document.createElement("span");
              sp.textContent = lab;
              item.appendChild(cb);
              item.appendChild(sp);
              menu.appendChild(item);
            }
            btn.onclick = (e) => {
              e.stopPropagation();
              const wasOpen = !menu.hidden;
              closeMenus();
              menu.hidden = wasOpen;
              btn.setAttribute("aria-expanded", String(!wasOpen));
            };
            wrap.appendChild(btn);
            wrap.appendChild(menu);
            (advancedKeys.has(def.key) ? advanced : host).appendChild(wrap);
          }
          const more = document.createElement("button");
          more.type = "button";
          more.className = "ms-more";
          more.id = "moreFiltersBtn";
          more.setAttribute("aria-expanded", "false");
          more.setAttribute("aria-controls", advanced.id);
          more.innerHTML = `<span>More filters <span class="ms-more-count"></span></span><i data-lucide="sliders-horizontal" aria-hidden="true"></i>`;
          more.onclick = (e) => {
            e.stopPropagation();
            const open = advanced.hidden;
            advanced.hidden = !open;
            more.setAttribute("aria-expanded", String(open));
            if (!open) closeMenus();
          };
          host.appendChild(more);
          host.appendChild(advanced);
          updateFilterUI();
          drawIcons();
        }
        function updateFilterUI() {
          $$("#alertFilters .ms").forEach((wrap) => {
            const c = sel[wrap.dataset.filterKey].size;
            wrap.querySelector(".ms-count").textContent = c ? `(${c})` : "";
            wrap.querySelector(".ms-btn").classList.toggle("active", c > 0);
          });
          const advancedCount = ["tf", "review", "outcome", "signal"].reduce(
            (sum, key) => sum + sel[key].size,
            0,
          );
          const more = $("#moreFiltersBtn");
          if (more) {
            more.classList.toggle("active", advancedCount > 0);
            more.querySelector(".ms-more-count").textContent = advancedCount
              ? `(${advancedCount})`
              : "";
          }
          renderChips();
        }
        function renderChips() {
          const host = $("#filterChips");
          const chips = [];
          for (const def of FILTER_DEFS)
            for (const val of sel[def.key])
              chips.push({ key: def.key, val, label: `${def.label}: ${optLabel(def.key, val)}` });
          if (!chips.length) {
            host.hidden = true;
            host.innerHTML = "";
            return;
          }
          host.hidden = false;
          host.innerHTML =
            chips
              .map(
                (c) =>
                  `<span class="fchip">${c.label}<button type="button" class="fchip-x" data-key="${c.key}" data-val="${c.val}" aria-label="Remove">✕</button></span>`,
              )
              .join("") +
            `<button type="button" class="fchip-clear" id="chipsClear">Clear all</button>`;
          host.querySelectorAll(".fchip-x").forEach((b) => {
            b.onclick = () => {
              sel[b.dataset.key].delete(b.dataset.val);
              syncFilterChecks();
              updateFilterUI();
              applyFilters();
            };
          });
          $("#chipsClear").onclick = () => {
            for (const k in sel) sel[k].clear();
            syncFilterChecks();
            updateFilterUI();
            applyFilters();
          };
        }
        function syncFilterChecks() {
          $$("#alertFilters .ms").forEach((wrap) => {
            const key = wrap.dataset.filterKey;
            wrap
              .querySelectorAll(".ms-item input")
              .forEach((cb) => (cb.checked = sel[key].has(cb.value)));
          });
        }
        // click anywhere else closes any open filter menu
        document.addEventListener("click", closeMenus);

        const pad = (n) => String(n).padStart(2, "0");
        function todayISO() {
          const d = new Date();
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }
        // build hour (00-23) + minute (00-59) selects, 24h (blank = not set, optional)
        $("#al-hour").innerHTML =
          `<option value="">--</option>` +
          Array.from(
            { length: 24 },
            (_, h) => `<option value="${pad(h)}">${pad(h)}</option>`,
          ).join("");
        $("#al-min").innerHTML =
          `<option value="">--</option>` +
          Array.from(
            { length: 60 },
            (_, m) => `<option value="${pad(m)}">${pad(m)}</option>`,
          ).join("");

        const esc = (s) =>
          String(s == null ? "" : s).replace(
            /[<>&]/g,
            (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c],
          );
        const zoneLabel = (o) =>
          ({
            fail: "❌ Fail",
            partial: "🟡 Partial",
            success: "✅ Success",
          })[o] || "Pending";
        const zoneText = (o) =>
          ({ fail: "Failed", partial: "Partial", success: "Successful" })[o] ||
          "Pending";
        const REVIEW_LABEL = {
          pending: "Pending",
          approved: "Approved",
          rejected: "Rejected",
        };
        const reviewLabel = (r) => REVIEW_LABEL[r] || "Pending";
        const reviewBadgeHtml = (a) =>
          `<span class="ai-review ${a.reviewState || "pending"}">${reviewLabel(a.reviewState).toUpperCase()}</span>`;
        function fmtRs(v) {
          return v == null || isNaN(v)
            ? "-"
            : "₹" +
                Number(v).toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                });
        }
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
            error.currentVersion = j.currentVersion;
            throw error;
          }
          return j;
        }
        function btn(label, cls, onclick, icon) {
          const b = document.createElement("button");
          b.type = "button";
          if (cls) b.className = cls;
          if (icon)
            b.innerHTML = `<i data-lucide="${icon}"></i>${label.replace(/[<&]/g, "")}`;
          else b.textContent = label;
          b.onclick = onclick;
          return b;
        }
        function drawIcons() {
          try {
            if (window.lucide) lucide.createIcons();
          } catch (_) {}
        }

        // ---------- sound ----------
        let actx = null;
        function beep() {
          try {
            actx =
              actx || new (window.AudioContext || window.webkitAudioContext)();
            if (actx.state === "suspended") actx.resume();
            const o = actx.createOscillator(),
              g = actx.createGain();
            o.type = "sine";
            o.frequency.value = 880;
            g.gain.setValueAtTime(0.0001, actx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.25, actx.currentTime + 0.02);
            g.gain.exponentialRampToValueAtTime(
              0.0001,
              actx.currentTime + 0.35,
            );
            o.connect(g);
            g.connect(actx.destination);
            o.start();
            o.stop(actx.currentTime + 0.36);
          } catch (_) {}
        }
        // browsers block audio until a user gesture - resume on first click
        document.addEventListener("click", () => {
          if (actx && actx.state === "suspended") actx.resume();
        });

        // ---------- form ----------
        function fillDatalist() {
          const list = SYMS[$("#al-index").value] || [];
          setSymbolChoices(list);
        }
        function setSymbolChoices(symbols) {
          $("#symList").innerHTML = (symbols || [])
            .map((s) => `<option value="${s}"></option>`)
            .join("");
        }
        function isFutureMarket(market = $("#al-market").value) {
          return ["index-future", "stock-future"].includes(market);
        }
        function isOptionMarket(market = $("#al-market").value) {
          return ["index-option", "stock-option"].includes(market);
        }
        function isDerivativeMarket(market = $("#al-market").value) {
          return isFutureMarket(market) || isOptionMarket(market);
        }
        function derivativeIndexGroup(market = $("#al-market").value) {
          return market === "index-future" ? "INDEX FUTURES"
            : market === "stock-future" ? "STOCK FUTURES"
              : market === "index-option" ? "INDEX OPTIONS" : "STOCK OPTIONS";
        }
        async function loadDerivativeStocks() {
          if (DERIVATIVE_STOCKS) return DERIVATIVE_STOCKS;
          const result = await api("/api/derivatives/equities");
          DERIVATIVE_STOCKS = Array.isArray(result.symbols) ? result.symbols : Array.isArray(result) ? result : [];
          return DERIVATIVE_STOCKS;
        }
        function resetContractPicker() {
          CONTRACT_CHOICES = [];
          $("#al-future-expiry").innerHTML = '<option value="">Select a symbol first…</option>';
          $("#al-future-expiry").disabled = true;
          $("#al-option-strike").innerHTML = '<option value="">Select an expiry first…</option>';
          $("#al-option-strike").disabled = true;
          $("#al-option-type").innerHTML = '<option value="">Select a strike first…</option>';
          $("#al-option-type").disabled = true;
          $("#al-future-expiry").value = "";
          $("#al-option-strike").value = "";
          $("#al-option-type").value = "";
        }
        async function configureInstrument({ locked = false } = {}) {
          const market = $("#al-market").value;
          const derivative = isDerivativeMarket(market);
          const indexDerivative = market === "index-future" || market === "index-option";
          $("#al-index-wrap").hidden = derivative;
          $("#al-contract-picker").hidden = !derivative;
          $("#al-option-picker").hidden = !isOptionMarket(market);
          $("#al-index").disabled = derivative || locked;
          $("#al-market").disabled = locked;
          $("#al-symbol-label").textContent = derivative ? (indexDerivative ? "F&O index" : "F&O stock") : "Stock";
          $("#al-symbol").readOnly = locked;
          $("#al-symbol").setAttribute("list", "symList");
          if (!derivative) {
            fillDatalist();
            return;
          }
          setDerivativeIndex(derivativeIndexGroup(market));
          try {
            setSymbolChoices(indexDerivative
              ? ["NIFTY", "NIFTYNXT50", "FINNIFTY", "BANKNIFTY", "MIDCPNIFTY", "NIFTYFPI"]
              : await loadDerivativeStocks());
          } catch (error) {
            setSymbolChoices([]);
            $("#al-err").textContent = `Could not load F&O symbols. ${error.message}`;
          }
        }
        function selectCurrentContract(price, label) {
          curPrice = Number(price) || 0;
          if (curPrice > 0) $("#al-price").value = curPrice;
          const contract = $("#al-contract");
          contract.hidden = !label;
          contract.textContent = label || "";
          updatePreview();
          updateTargets();
        }
        async function loadContractChoices() {
          const market = $("#al-market").value;
          const symbol = $("#al-symbol").value.trim().toUpperCase();
          if (!isDerivativeMarket(market) || !symbol) return;
          const request = ++contractRequest;
          resetContractPicker();
          $("#al-contract").hidden = false;
          $("#al-contract").textContent = "Loading available contracts…";
          try {
            const base = new URLSearchParams({ market, symbol });
            const initial = await api("/api/alert-contracts?" + base);
            if (request !== contractRequest) return;
            if (initial.kind === "futures") {
              CONTRACT_CHOICES = initial.contracts || [];
              const expiry = $("#al-future-expiry");
              expiry.innerHTML = '<option value="" disabled>Select expiry…</option>' + CONTRACT_CHOICES.map((entry) => `<option value="${entry.expiry}">${entry.expiry}</option>`).join("");
              expiry.disabled = !CONTRACT_CHOICES.length;
              if (CONTRACT_CHOICES.length) {
                expiry.value = CONTRACT_CHOICES[0].expiry;
                const selected = CONTRACT_CHOICES[0];
                selectCurrentContract(selected.lastPrice, `${market === "index-future" ? "Index" : "Stock"} future · ${symbol} · ${selected.expiry}`);
              } else selectCurrentContract(null, "No active futures contracts are available.");
              return;
            }
            const expiries = initial.expiries || [];
            const expiry = $("#al-future-expiry");
            expiry.innerHTML = '<option value="" disabled>Select expiry…</option>' + expiries.map((entry) => `<option value="${entry.expiry}">${entry.expiry}</option>`).join("");
            expiry.disabled = !expiries.length;
            if (!expiries.length) {
              selectCurrentContract(null, "No option expiries are available.");
              return;
            }
            expiry.value = expiries[0].expiry;
            await loadOptionContracts(request);
          } catch (error) {
            if (request !== contractRequest) return;
            selectCurrentContract(null, `Could not load contracts. ${error.message}`);
          }
        }
        async function loadOptionContracts(request = ++contractRequest) {
          const market = $("#al-market").value;
          const symbol = $("#al-symbol").value.trim().toUpperCase();
          const expiry = $("#al-future-expiry").value;
          if (!isOptionMarket(market) || !symbol || !expiry) return;
          $("#al-option-strike").disabled = true;
          $("#al-option-type").disabled = true;
          try {
            const params = new URLSearchParams({ market, symbol, expiry });
            const result = await api("/api/alert-contracts?" + params);
            if (request !== contractRequest) return;
            CONTRACT_CHOICES = result.contracts || [];
            const strike = $("#al-option-strike");
            const nearest = CONTRACT_CHOICES.reduce((best, entry) => !best || Math.abs(entry.strike - (result.underlyingValue || entry.strike)) < Math.abs(best.strike - (result.underlyingValue || best.strike)) ? entry : best, null);
            strike.innerHTML = '<option value="" disabled>Select strike…</option>' + CONTRACT_CHOICES.map((entry) => `<option value="${entry.strike}">${entry.strike}</option>`).join("");
            strike.disabled = !nearest;
            if (!nearest) {
              selectCurrentContract(null, "No option contracts are available.");
              return;
            }
            strike.value = String(nearest.strike);
            selectOptionLeg();
          } catch (error) {
            if (request !== contractRequest) return;
            selectCurrentContract(null, `Could not load option contracts. ${error.message}`);
          }
        }
        function selectOptionLeg(keepType = false) {
          const selected = CONTRACT_CHOICES.find((entry) => String(entry.strike) === $("#al-option-strike").value);
          const type = $("#al-option-type");
          if (!selected) return;
          const previousType = type.value;
          const choices = [];
          if (Number.isFinite(selected.callPrice)) choices.push(["CE", selected.callPrice]);
          if (Number.isFinite(selected.putPrice)) choices.push(["PE", selected.putPrice]);
          type.innerHTML = choices.map(([value]) => `<option value="${value}">${value}</option>`).join("");
          type.disabled = !choices.length;
          if (!choices.length) return;
          const selectedType = keepType && choices.some(([value]) => value === previousType)
            ? previousType
            : choices[0][0];
          type.value = selectedType;
          const [, price] = choices.find(([value]) => value === selectedType);
          const optionType = selectedType;
          selectCurrentContract(price, `${optionType} ${selected.strike} · ${$("#al-symbol").value.trim().toUpperCase()} · ${$("#al-future-expiry").value}`);
        }
        async function loadSymbols() {
          try {
            SYMS = await api("/api/symbols");
          } catch (_) {
            SYMS = {};
          }
          fillDatalist();
        }
        async function loadConfig() {
          try {
            const c = await api("/api/alert-config");
            OFFSETS = c.offsets || {};
            DEFAULT_OFFSET = c.defaultOffset || 10;
            const instruments = c.instruments || {};
            $("#al-market option[value='index-future']").disabled = !instruments.indexFuture;
            $("#al-market option[value='stock-future']").disabled = !instruments.stockFuture;
            $("#al-market option[value='index-option']").disabled = !instruments.indexOption;
            $("#al-market option[value='stock-option']").disabled = !instruments.stockOption;
            if (Array.isArray(c.indices) && c.indices.length) {
              ALERT_INDICES = c.indices;
              CASH_ALERT_INDICES = Array.isArray(c.cashIndices) && c.cashIndices.length
                ? c.cashIndices
                : c.indices.filter((index) => index !== "STOCK FUTURES");
              buildIndexUI();
            }
          } catch (_) {}
        }
        function renderCreatorOptions(selectedId, fallback) {
          const select = $("#al-creator");
          const users = ALERT_CREATORS.slice();
          if (
            fallback &&
            fallback.id &&
            !users.some((user) => user.id === fallback.id)
          ) {
            users.push({ ...fallback, unavailable: true });
          }
          select.replaceChildren();
          for (const user of users) {
            const option = document.createElement("option");
            option.value = user.id;
            option.textContent = `${user.username} · ${niceLabel(user.role)}`;
            if (user.unavailable) option.textContent += " (unavailable)";
            select.appendChild(option);
          }
          if (selectedId && users.some((user) => user.id === selectedId))
            select.value = selectedId;
        }
        async function loadCreators(selectedId) {
          const user = currentUser();
          try {
            const payload = await api("/api/alert-creators");
            ALERT_CREATORS = Array.isArray(payload.users) ? payload.users : [];
          } catch (_) {
            ALERT_CREATORS = user ? [user] : [];
          }
          renderCreatorOptions(selectedId || (user && user.id));
        }
        // build the create-form index dropdown from the server's index list; also
        // rebuild the filters so the Index filter reflects the loaded indices
        function buildIndexUI() {
          if (!CASH_ALERT_INDICES.includes(alertIndex))
            alertIndex = CASH_ALERT_INDICES[0];
          $("#al-index").innerHTML = CASH_ALERT_INDICES.map(
            (n) => `<option value="${n}">${n}</option>`,
          ).join("");
          if (!editId) $("#al-index").value = alertIndex;
          buildFilters();
        }
        async function loadPrice() {
          const sym = $("#al-symbol").value.trim().toUpperCase();
          if (!sym) {
            curPrice = 0;
            updatePreview();
            return;
          }
          try {
            const params = new URLSearchParams({
              market: $("#al-market").value || "cash",
              symbol: sym,
            });
            if (["stock-future", "index-future"].includes($("#al-market").value))
              params.set("contractExpiry", $("#al-future-expiry").value);
            if (["index-option", "stock-option"].includes($("#al-market").value)) {
              params.set("contractExpiry", $("#al-future-expiry").value);
              params.set("strike", $("#al-option-strike").value);
              params.set("optionType", $("#al-option-type").value);
            }
            const r = await api("/api/price?" + params.toString());
            curPrice = r.price || 0;
            if (curPrice > 0 && !editId && !$("#al-price").value)
              $("#al-price").value = curPrice;
          } catch (_) {
            curPrice = 0;
          }
          updatePreview();
        }
        function setFutureContract(market, symbol, expiry, currentPrice) {
          const isIndexFuture = market === "index-future";
          $("#al-market").value = isIndexFuture ? "index-future" : "stock-future";
          void configureInstrument({ locked: true });
          $("#al-future-expiry").innerHTML = `<option value="${expiry || ""}">${expiry || "Expiry unavailable"}</option>`;
          $("#al-future-expiry").value = expiry || "";
          $("#al-future-expiry").disabled = true;
          setDerivativeIndex(isIndexFuture ? "INDEX FUTURES" : "STOCK FUTURES");
          $("#al-symbol").value = String(symbol || "").toUpperCase();
          selectCurrentContract(currentPrice, `${isIndexFuture ? "Index" : "Stock"} future · ${$("#al-symbol").value} · ${expiry || "Expiry unavailable"}`);
        }
        function setOptionContract(market, symbol, expiry, strike, optionType, currentPrice) {
          $("#al-market").value = market;
          void configureInstrument({ locked: true });
          $("#al-future-expiry").innerHTML = `<option value="${expiry || ""}">${expiry || "Expiry unavailable"}</option>`;
          $("#al-future-expiry").value = expiry || "";
          $("#al-future-expiry").disabled = true;
          $("#al-option-strike").innerHTML = `<option value="${strike || ""}">${strike || "Strike unavailable"}</option>`;
          $("#al-option-strike").value = strike || "";
          $("#al-option-strike").disabled = true;
          $("#al-option-type").innerHTML = `<option value="${optionType || ""}">${optionType || "Option unavailable"}</option>`;
          $("#al-option-type").value = optionType || "";
          $("#al-option-type").disabled = true;
          setDerivativeIndex(market === "index-option" ? "INDEX OPTIONS" : "STOCK OPTIONS");
          $("#al-symbol").value = String(symbol || "").toUpperCase();
          selectCurrentContract(currentPrice, `${optionType} ${strike} · ${$("#al-symbol").value} · ${expiry || "Expiry unavailable"}`);
        }
        function setDerivativeIndex(index) {
          const select = $("#al-index");
          if (!Array.from(select.options).some((option) => option.value === index)) {
            const option = document.createElement("option");
            option.value = index;
            option.textContent = index;
            option.dataset.derivative = "true";
            select.appendChild(option);
          }
          select.value = index;
        }
        function clearFutureContract() {
          $("#al-market").value = "cash";
          $("#al-market").disabled = false;
          resetContractPicker();
          $("#al-index-wrap").hidden = false;
          $("#al-contract-picker").hidden = true;
          $("#al-option-picker").hidden = true;
          $("#al-index").disabled = false;
          Array.from($("#al-index").options)
            .filter((option) => option.dataset.derivative === "true")
            .forEach((option) => option.remove());
          $("#al-symbol").readOnly = false;
          $("#al-symbol").setAttribute("list", "symList");
          $("#al-symbol-label").textContent = "Stock";
          $("#al-contract").hidden = true;
          $("#al-contract").textContent = "";
        }
        function updatePreview() {
          const p = parseFloat($("#al-price").value);
          const side = $("#al-side").value;
          const tf = $("#al-tf").value;
          const el = $("#al-trigger");
          // don't compute the trigger until side + alert price + time frame are all set
          if (!side || !tf || !(p > 0)) {
            el.innerHTML =
              "Alert: - <span class='opt'>(pick side, entry price & time frame)</span>";
            return;
          }
          const pct = OFFSETS[tf] != null ? OFFSETS[tf] : DEFAULT_OFFSET;
          // BUY fires on a rise (trigger above); SELL on a fall (trigger below)
          const sign = side === "BUY" ? "+" : "−";
          let t = side === "BUY" ? p * (1 + pct / 100) : p * (1 - pct / 100);
          // re-anchor: if the live price is between the alert price and the trigger,
          // start from the current price (trigger = current)
          let note = "";
          if (curPrice > 0) {
            if (side === "BUY" && curPrice > p && curPrice < t) {
              t = curPrice;
              note = ` - re-anchored to current ${fmtRs(curPrice)}`;
            } else if (side === "SELL" && curPrice < p && curPrice > t) {
              t = curPrice;
              note = ` - re-anchored to current ${fmtRs(curPrice)}`;
            }
          }
          const when = side === "BUY" ? "rises to" : "falls to";
          el.innerHTML = `Alert (${tf} · ${side} ${sign}${pct}%): <b>${fmtRs(t)}</b> - fires when price ${when} it, then steps to entry ${fmtRs(p)}${note}`;
        }
        // live 3x/5x profit targets from alert price + stop loss
        function updateTargets() {
          const p = parseFloat($("#al-price").value);
          const slv = parseFloat($("#al-stop").value);
          const side = $("#al-side").value;
          const el = $("#al-targets");
          if (!side || !(p > 0) || !(slv > 0)) {
            el.innerHTML =
              "Targets: — <span class='opt'>(needs side, entry price & stop loss)</span>";
            return;
          }
          if (
            (side === "BUY" && slv >= p) ||
            (side === "SELL" && slv <= p)
          ) {
            el.innerHTML =
              `<span class='opt' style='color:var(--danger,#e53e3e)'>Stop loss must be ${side === "BUY" ? "below" : "above"} entry price for ${side}</span>`;
            return;
          }
          const R = Math.abs(p - slv);
          const dir = side === "BUY" ? 1 : -1;
          el.innerHTML = `R ${fmtRs(R)} · 3× <b>${fmtRs(p + dir * 3 * R)}</b> (+${fmtRs(3 * R)}) · 5× <b>${fmtRs(p + dir * 5 * R)}</b> (+${fmtRs(5 * R)})`;
        }
        // ---------- create/edit modal ----------
        let alertReturnFocus = null;
        let viewReturnFocus = null;
        let reviewReturnFocus = null;
        const restoreFocus = (el) => {
          if (el && el.isConnected)
            setTimeout(() => {
              if (!document.querySelector('[role="dialog"].show')) el.focus();
            }, 0);
        };
        const trapDialogFocus = (dialog, e) => {
          if (e.key !== "Tab" || !dialog.classList.contains("show")) return;
          const items = Array.from(
            dialog.querySelectorAll(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => !el.hidden && el.offsetParent !== null);
          if (!items.length) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        };
        function openAlertModal() {
          alertReturnFocus = document.activeElement;
          $("#alertModal").classList.add("show");
          drawIcons();
          setTimeout(() => $("#al-symbol").focus(), 50);
        }
        function closeAlertModal() {
          const modal = $("#alertModal");
          if (!modal.classList.contains("show")) return;
          modal.classList.remove("show");
          restoreFocus(alertReturnFocus);
          alertReturnFocus = null;
        }
        // ---------- alert detail (view) modal ----------
        const pctTxt = (v) =>
          v != null && !isNaN(v)
            ? (+v).toFixed(2).replace(/\.?0+$/, "") + "%"
            : "-";
        // absolute IST date-time for metadata (e.g. "04 Aug 2026, 10:30")
        const fmtDateTime = (iso) => {
          if (!iso) return "-";
          const d = new Date(iso);
          if (isNaN(d)) return "-";
          return d.toLocaleString("en-GB", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
        };
        // short IST date for the compact list line (e.g. "04 Aug")
        const fmtDateShort = (iso) => {
          if (!iso) return "";
          const d = new Date(iso);
          if (isNaN(d)) return "";
          return d.toLocaleString("en-GB", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "short",
          });
        };
        function openAlertView(a) {
          viewReturnFocus = document.activeElement;
          $("#av-sym").textContent = a.symbol;
          $("#av-badges").innerHTML =
            `<span class="ai-index">${esc(alertMarketLabel(a))}</span>` +
            `<span class="ai-side ${a.side === "BUY" ? "buy" : "sell"}">${a.side}</span>` +
            `<span class="ai-status ${a.status}">${a.status}</span>` +
            reviewBadgeHtml(a) +
            `<span class="ai-zone ${a.zoneOutcome || "pending"}">${zoneLabel(a.zoneOutcome)}</span>`;
          const cell = (k, v, cls, wide) =>
            `<div class="cell${wide ? " wide" : ""}"><span class="k">${k}</span><span class="v ${cls || ""}">${v}</span></div>`;
          const cand = a.candleDate
            ? a.candleDate + (a.candleTime ? " " + a.candleTime : "")
            : "-";
          const lastEv = a.lastEvent
            ? `${a.lastEvent.type === "FINAL_REALERT" ? "Final re-alert · entry next" : a.lastEvent.type} @ ${fmtRs(a.lastEvent.price)}`
            : "-";
          const reward =
            a.profit3 != null
              ? `${fmtRs(a.profit3)} · ${fmtRs(a.profit5)}`
              : "-";
          $("#av-grid").innerHTML = [
            cell("Entry price", fmtRs(a.alertPrice)),
            ...(["stock-future", "index-future"].includes(a.market)
              ? [cell("Contract expiry", esc(a.contractExpiry) || "-")]
              : ["index-option", "stock-option"].includes(a.market)
                ? [
                    cell("Contract expiry", esc(a.contractExpiry) || "-"),
                    cell("Option contract", `${esc(a.optionType) || "-"} ${esc(a.strike) || "-"}`),
                  ]
              : []),
            cell("Alert price", fmtRs(a.triggerPrice)),
            cell("Stop loss", fmtRs(a.stopLoss)),
            cell("Time frame", a.timeframe || "-"),
            cell("3× target", fmtRs(a.target3)),
            cell("5× target", fmtRs(a.target5)),
            cell("Risk (R)", fmtRs(a.riskR)),
            cell("Reward (3× · 5×)", reward),
            cell("Alert offset", pctTxt(a.offsetPct)),
            cell("Re-alert step", pctTxt(a.stepPct)),
            cell("Zone outcome", zoneLabel(a.zoneOutcome)),
            cell("Review state", reviewLabel(a.reviewState)),
            cell("Reviewer", esc(a.reviewer) || "-"),
            cell("Review reason", a.reviewReason ? esc(a.reviewReason) : "-", "note", true),
            cell("Reviewed at", fmtDateTime(a.reviewedAt)),
            cell("Creator", esc(a.zoneCreator) || "-", "", true),
            cell("Note", a.note ? esc(a.note) : "-", "note", true),
            cell("Candle", cand),
            cell("Entered", a.entered ? "Yes" : "No"),
            cell("Last event", lastEv),
            cell("Created", fmtDateTime(a.createdAt)),
            cell("Last updated", fmtDateTime(a.updatedAt)),
            cell("Last fired", fmtDateTime(a.lastFiredAt)),
          ].join("");
          const acts = $("#av-actions");
          acts.innerHTML = "";
          const isArch = a._archived || a.status === "closed";
          if (isArch) {
            // Archived definitions remain creator-controlled.
            if (canRearmAlert(a))
              acts.appendChild(
                btn("Re-open", "btn-sm", () => rearmAlert(a), "rotate-ccw"),
              );
            if (canDeleteAlert(a))
              acts.appendChild(
              btn(
                "Delete",
                "btn-sm danger",
                () => {
                  if (confirm(`Delete archived alert for ${a.symbol}?`)) {
                    del(a);
                    closeAlertView();
                  }
                },
                "trash-2",
              ),
            );
          } else {
            if (canEditAlert(a))
              acts.appendChild(
                btn(
                  "Edit",
                  "btn-sm",
                  () => {
                    closeAlertView();
                    editAlert(a);
                  },
                  "pencil",
                ),
              );
            // Approve unless already approved; Reject unless already rejected
            // Pending shows both; reviewed alerts expose the opposite decision.
            if (canReviewAlert(a) && a.reviewState !== "approved")
              acts.appendChild(
                btn(
                  "Approve",
                  "btn-sm",
                  () => openReviewModal(a, "approve"),
                  "shield-check",
                ),
              );
            if (canReviewAlert(a) && a.reviewState !== "rejected")
              acts.appendChild(
                btn(
                  "Reject",
                  "btn-sm",
                  () => openReviewModal(a, "reject"),
                  "shield-off",
                ),
              );
            if (canCloseAlert(a))
              acts.appendChild(
                btn(
                  "Close alert",
                  "btn-sm",
                  async () => {
                    await act(a, "close");
                    closeAlertView();
                  },
                  "circle-x",
                ),
              );
            if (canDeleteAlert(a))
              acts.appendChild(
              btn(
                "Delete",
                "btn-sm danger",
                () => {
                  if (confirm(`Delete alert for ${a.symbol}?`)) {
                    del(a);
                    closeAlertView();
                  }
                },
                "trash-2",
              ),
            );
          }
          // shortcut: log a trade from this alert (prefilled symbol/side/entry/stop)
          if (canCreate() && window.openCreateTrade)
            acts.appendChild(
              btn(
                "Create trade",
                "btn-sm primary",
                () => {
                  closeAlertView();
                  const today = new Date().toLocaleDateString("en-CA", {
                    timeZone: "Asia/Kolkata",
                  });
                  window.openCreateTrade({
                    symbol: a.symbol,
                    index: a.index,
                    side: a.side,
                    entryPrice: a.alertPrice,
                    stopLoss: a.stopLoss,
                    entryDate: today,
                  });
                },
                "notebook-pen",
              ),
            );
          if (!acts.children.length)
            acts.innerHTML =
              `<span class="av-readonly">View access only for this alert.</span>`;
          $("#alertViewModal").classList.add("show");
          drawIcons();
          setTimeout(() => $("#av-close").focus(), 50);
        }
        function closeAlertView() {
          const modal = $("#alertViewModal");
          if (!modal.classList.contains("show")) return;
          modal.classList.remove("show");
          restoreFocus(viewReturnFocus);
          viewReturnFocus = null;
          $("#av-actions").replaceChildren();
        }
        // ---------- review (approve/reject) modal ----------
        // Minimal reuse of the #alertModal chrome (am-card/am-head/alert-form/form-err/
        // form-actions) via a separate #reviewModal element - a full create/edit form
        // doesn't fit this flow, so a small dedicated modal is used instead.
        let reviewTarget = null; // { alert, action: "approve" | "reject" }
        function openReviewModal(a, action) {
          reviewReturnFocus = document.activeElement;
          reviewTarget = { alert: a, action };
          $("#rv-title").textContent =
            (action === "approve" ? "Approve" : "Reject") + " alert - " + a.symbol;
          $("#rv-note").textContent =
            String(a.note || "").trim() || "No note added.";
          $("#rv-reviewer").value =
            (window.APP_AUTH && window.APP_AUTH.user && window.APP_AUTH.user.username) ||
            "";
          $("#rv-reason").value = "";
          $("#rv-err").textContent = "";
          $("#rv-submit-text").textContent =
            action === "approve" ? "Approve" : "Reject";
          $("#reviewModal").classList.add("show");
          setTimeout(() => $("#rv-reason").focus(), 50);
        }
        function closeReviewModal() {
          const modal = $("#reviewModal");
          if (!modal.classList.contains("show")) return;
          modal.classList.remove("show");
          reviewTarget = null;
          restoreFocus(reviewReturnFocus);
          reviewReturnFocus = null;
        }
        async function submitReview(e) {
          e.preventDefault();
          if (!reviewTarget) return;
          const reason = $("#rv-reason").value.trim();
          if (!reason) {
            $("#rv-err").textContent = "A reason is required.";
            return;
          }
          const { alert: a, action } = reviewTarget;
          try {
            await api(
              "/api/alerts/" + a.id + "/" + action,
              "POST",
              { reason, expectedVersion: a.version },
            );
          } catch (err) {
            $("#rv-err").textContent = err.message;
            return;
          }
          closeReviewModal();
          closeAlertView();
          refreshAll(true);
        }
        // called from the dashboard's stock modal: switch to Alerts + open create,
        // prefilled with the given index + symbol
        window.openCreateAlert = function (index, symbol) {
          const btn = document.querySelector('.viewnav .tab[data-view="alerts"]');
          if (btn) btn.click(); // switch to the Alerts view
          if (index && ALERT_INDICES.includes(index)) alertIndex = index;
          resetForm(); // sets al-index = alertIndex, clears the rest
          if (symbol) $("#al-symbol").value = String(symbol).toUpperCase();
          loadPrice();
          openAlertModal();
        };
        window.openCreateStockFutureAlert = function (contract) {
          if (!canCreate() || !contract || !contract.symbol || !contract.expiry)
            return;
          const btn = document.querySelector('.viewnav .tab[data-view="alerts"]');
          if (btn) btn.click();
          alertIndex = "STOCK FUTURES";
          resetForm();
          setFutureContract("stock-future", contract.symbol, contract.expiry, contract.lastPrice);
          updatePreview();
          updateTargets();
          openAlertModal();
        };
        window.openCreateIndexFutureAlert = function (contract) {
          if (!canCreate() || !contract || !contract.symbol || !contract.expiry)
            return;
          const btn = document.querySelector('.viewnav .tab[data-view="alerts"]');
          if (btn) btn.click();
          alertIndex = "INDEX FUTURES";
          resetForm();
          setFutureContract("index-future", contract.symbol, contract.expiry, contract.lastPrice);
          updatePreview();
          updateTargets();
          openAlertModal();
        };
        window.openCreateOptionAlert = function (contract) {
          if (!canCreate() || !contract || !contract.market || !contract.symbol || !contract.expiry || !(Number(contract.strike) > 0) || !contract.optionType)
            return;
          const btn = document.querySelector('.viewnav .tab[data-view="alerts"]');
          if (btn) btn.click();
          alertIndex = contract.market === "index-option" ? "INDEX OPTIONS" : "STOCK OPTIONS";
          resetForm();
          setOptionContract(contract.market, contract.symbol, contract.expiry, contract.strike, contract.optionType, contract.lastPrice);
          updatePreview();
          updateTargets();
          openAlertModal();
        };
        function resetForm() {
          editId = null;
          editVersion = null;
          $("#formTitle").textContent = "Create alert";
          $("#al-submit-text").textContent = "Create alert";
          $("#alertForm").reset();
          clearFutureContract();
          $("#al-index").value = alertIndex;
          // side, time frame, candle date/time start empty (no premature trigger)
          $("#al-side").value = "";
          $("#al-tf").value = "";
          $("#al-date").value = "";
          $("#al-hour").value = "";
          $("#al-min").value = "";
          // Creator defaults to the signed-in user but can be assigned to another
          // enabled editor/admin while creating the alert.
          const user = currentUser();
          $("#al-creator").disabled = false;
          renderCreatorOptions(user && user.id);
          $("#al-err").textContent = "";
          fillDatalist();
          updatePreview();
          updateTargets();
        }
        function editAlert(a) {
          editId = a.id;
          editVersion = a.version;
          $("#formTitle").textContent = "Edit alert";
          $("#al-submit-text").textContent = "Save changes";
          clearFutureContract();
          $("#al-index").value = a.index;
          fillDatalist();
          $("#al-symbol").value = a.symbol;
          if (["stock-future", "index-future"].includes(a.market))
            setFutureContract(a.market, a.symbol, a.contractExpiry, a.currentPrice);
          else if (a.market === "index-option" || a.market === "stock-option")
            setOptionContract(a.market, a.symbol, a.contractExpiry, a.strike, a.optionType, a.currentPrice);
          $("#al-side").value = a.side;
          $("#al-price").value = a.alertPrice;
          $("#al-stop").value = a.stopLoss != null ? a.stopLoss : "";
          renderCreatorOptions(a.createdByUserId, {
            id: a.createdByUserId,
            username: a.createdByUsername || a.zoneCreator || "Unknown creator",
            role: a.createdByRole || "editor",
          });
          $("#al-creator").disabled = true;
          $("#al-note").value = a.note || "";
          $("#al-tf").value = a.timeframe || "";
          $("#al-date").value = a.candleDate || "";
          const [hh, mm] = (a.candleTime || ":").split(":");
          $("#al-hour").value = hh || "";
          $("#al-min").value = mm || "";
          $("#al-err").textContent = "";
          if (["stock-future", "index-future", "index-option", "stock-option"].includes(a.market)) updatePreview();
          else loadPrice();
          updateTargets();
          openAlertModal();
        }
        async function submitForm(e) {
          e.preventDefault();
          const hh = $("#al-hour").value,
            mm = $("#al-min").value;
          const body = {
            market: $("#al-market").value || "cash",
            index: $("#al-index").value,
            symbol: $("#al-symbol").value.trim().toUpperCase(),
            side: $("#al-side").value,
            alertPrice: parseFloat($("#al-price").value),
            stopLoss: parseFloat($("#al-stop").value),
            note: $("#al-note").value.trim(),
            timeframe: $("#al-tf").value,
            candleDate: $("#al-date").value || "",
            candleTime: hh && mm ? `${hh}:${mm}` : "",
          };
          if (["stock-future", "index-future"].includes(body.market))
            body.contractExpiry = $("#al-future-expiry").value;
          if (["index-option", "stock-option"].includes(body.market)) {
            body.contractExpiry = $("#al-future-expiry").value;
            body.strike = Number($("#al-option-strike").value);
            body.optionType = $("#al-option-type").value;
          }
          if (!editId) body.creatorUserId = $("#al-creator").value;
          // Anchor the Alert (trigger) price to the price the form already had once
          // side + entry + time frame were set (what the preview used) - NOT a fresh
          // save-time tick. Server re-anchors against this instead of its latest price.
          if (curPrice > 0) body.formPrice = curPrice;
          if (editId) body.expectedVersion = editVersion;
          $("#al-err").textContent = "";
          // If the live price is already at/past the entry, warn: the alert will be
          // created already "entered" (targets/stop-loss track immediately).
          if (body.side && body.alertPrice > 0 && body.symbol) {
            try {
              const params = new URLSearchParams({
                market: body.market,
                symbol: body.symbol,
              });
              if (["stock-future", "index-future"].includes(body.market))
                params.set("contractExpiry", body.contractExpiry);
              if (["index-option", "stock-option"].includes(body.market)) {
                params.set("contractExpiry", body.contractExpiry);
                params.set("strike", String(body.strike));
                params.set("optionType", body.optionType);
              }
              const { price } = await api("/api/price?" + params.toString());
              const past =
                price > 0 &&
                (body.side === "BUY"
                  ? price <= body.alertPrice
                  : price >= body.alertPrice);
              if (past) {
                const ok = confirm(
                  `Current price ${fmtRs(price)} is already ${body.side === "BUY" ? "at/below" : "at/above"} your entry ${fmtRs(body.alertPrice)}.\n\n` +
                    `The alert will stay pending review. Once approved, it may enter on the next live tick and begin tracking its 3×/5×/stop-loss immediately.\n\nSave it anyway?`,
                );
                if (!ok) return;
              }
            } catch (_) {
              /* price lookup failed - just proceed with create */
            }
          }
          try {
            if (editId) await api("/api/alerts/" + editId, "PATCH", body);
            else await api("/api/alerts", "POST", body);
            alertIndex = body.index; // remember for the next new-alert default
            resetForm();
            closeAlertModal();
            refreshAll(true);
          } catch (err) {
            $("#al-err").textContent = err.message;
          }
        }

        // ---------- list ----------
        // multi-select: an empty set = no filter; otherwise the value must be in the set
        function applyFilters() {
          // update the toggle counts
          if ($("#vtActiveCount")) $("#vtActiveCount").textContent = allAlerts.length;
          if ($("#vtClosedCount")) $("#vtClosedCount").textContent = allArchived.length;
          const source = alertView === "closed" ? allArchived : allAlerts;
          const hasFilters = Object.values(sel).some((values) => values.size);
          const list = hasFilters
            ? source.filter(
                (a) =>
                  (!sel.index.size || sel.index.has(a.index)) &&
                  (!sel.status.size || sel.status.has(a.status)) &&
                  (!sel.side.size || sel.side.has(a.side)) &&
                  (!sel.tf.size || sel.tf.has(a.timeframe)) &&
                  (!sel.review.size || sel.review.has(a.reviewState || "pending")) &&
                  (!sel.outcome.size || sel.outcome.has(a.zoneOutcome || "pending")) &&
                  (!sel.signal.size || sel.signal.has(a.lastEvent && a.lastEvent.type)),
              )
            : source;
          renderList(list);
        }
        const listedAlerts = new Map();
        const listActionHtml = (label, action, icon, cls = "btn-sm") =>
          `<button type="button" class="${cls}" data-alert-action="${action}"><i data-lucide="${icon}"></i>${label}</button>`;
        function renderList(alerts) {
          const host = $("#alertList");
          listedAlerts.clear();
          if (!alerts.length) {
            const base = alertView === "closed" ? allArchived : allAlerts;
            host.innerHTML = base.length
              ? `<div class="empty">No alerts match the current filters.</div>`
              : alertView === "closed"
                ? `<div class="empty">No closed alerts yet.</div>`
                : canCreate()
                  ? `<div class="empty">No active alerts. Click "New alert" to create one.</div>`
                  : `<div class="empty">No active alerts to view.</div>`;
            return;
          }
          host.innerHTML = "";
          for (const a of alerts) {
            listedAlerts.set(String(a.id), a);
            const isArch = a._archived || a.status === "closed";
            const div = document.createElement("div");
            div.dataset.alertId = a.id;
            div.tabIndex = 0;
            div.setAttribute(
              "aria-label",
              `${a.symbol} ${a.side} alert. ${a.status}. Press Enter for details.`,
            );
            div.className =
              "alert-item " +
              (a.side === "BUY" ? "side-buy" : "side-sell") +
              (a.ringing ? " ringing" : "") +
              (isArch ? " archived" : "");
            div.innerHTML =
              `<div class="ai-body">` +
              `<div class="ai-identity">` +
              `<div class="ai-line1"><span class="ai-sym">${esc(a.symbol)}</span>` +
              `<span class="ai-index">${esc(alertMarketLabel(a))}</span></div>` +
              `<div class="ai-state-row">` +
              `<span class="ai-status ${a.status}">${esc(a.status)}</span>` +
              `<span class="ai-side ${a.side === "BUY" ? "buy" : "sell"}">${esc(a.side)}</span>` +
              (a.lastEvent && a.lastEvent.type === "FINAL_REALERT"
                ? `<span class="ai-final-realert">Entry next</span>`
                : "") +
              reviewBadgeHtml(a) +
              `<span class="ai-zone ${a.zoneOutcome || "pending"}">${zoneText(a.zoneOutcome)} outcome</span>` +
              (isArch ? `<span class="ai-archived">Archived</span>` : "") +
              `</div>` +
              `</div>` +
              `<div class="ai-levels">` +
              `<span class="ai-metric"><small>Entry</small><strong>${fmtRs(a.alertPrice)}</strong></span>` +
              `<span class="ai-metric current"><small>Current</small><strong${a.market !== "cash" ? "" : ` data-cur="${esc(a.symbol)}"`}>${fmtRs(a.currentPrice)}</strong></span>` +
              `<span class="ai-metric trigger"><small>Alert</small><strong>${fmtRs(a.triggerPrice)}</strong></span>` +
              `<span class="ai-metric stop"><small>Stop loss</small><strong>${fmtRs(a.stopLoss)}</strong></span>` +
              `</div>` +
              `<div class="ai-plan">` +
              `<span class="ai-metric"><small>Target 3×</small><strong>${fmtRs(a.target3)}</strong></span>` +
              `<span class="ai-metric"><small>Target 5×</small><strong>${fmtRs(a.target5)}</strong></span>` +
              `<span class="ai-metric"><small>Risk</small><strong>${fmtRs(a.riskR)}</strong></span>` +
              `<span class="ai-metric"><small>Timeframe</small><strong>${esc(a.timeframe || "-")}</strong></span>` +
              `</div>` +
              `</div>` +
              `<div class="ai-actions"></div>`;
            const acts = div.querySelector(".ai-actions");
            if (isArch && canRearmAlert(a)) {
              // Keep the resting row focused. Destructive actions live in details.
              acts.innerHTML = listActionHtml(
                "Re-open alert",
                "rearm",
                "rotate-ccw",
              );
            } else if (!isArch) {
              // Only the next consequential action remains visible; edit/close/delete
              // stay in the detail view where their context is explicit.
              if (a.reviewState === "pending" && canReviewAlert(a)) {
                acts.innerHTML += listActionHtml(
                  "Approve",
                  "approve",
                  "shield-check",
                );
                acts.innerHTML += listActionHtml(
                  "Reject",
                  "reject",
                  "shield-off",
                );
              }
              if (a.ringing)
                acts.innerHTML += listActionHtml("Snooze", "snooze", "clock");
            }
            acts.innerHTML += listActionHtml("View details", "view", "eye");
            host.appendChild(div);
          }
          drawIcons();
          updateCurrentCells(); // seed freshly-rendered rows with the live price
        }
        // Live "Current" price: tick the alert-list Current cells off the dashboard's
        // market cache (fed by SSE in stream mode). Falls back to the fetched value.
        function updateCurrentCells() {
          if (!window.__livePrice) return;
          document.querySelectorAll("#alertList strong[data-cur]").forEach((el) => {
            const p = window.__livePrice(el.getAttribute("data-cur"));
            if (p != null) el.textContent = fmtRs(p);
          });
        }
        if (window.__onLive) window.__onLive(updateCurrentCells);
        $("#alertList").addEventListener("click", (event) => {
          const row = event.target.closest(".alert-item");
          const alert = row && listedAlerts.get(row.dataset.alertId);
          if (!alert) return;
          const action = event.target.closest("[data-alert-action]")?.dataset
            .alertAction;
          if (action === "rearm") rearmAlert(alert);
          else if (action === "approve" || action === "reject")
            openReviewModal(alert, action);
          else if (action === "snooze") act(alert, "snooze");
          else openAlertView(alert);
        });
        $("#alertList").addEventListener("keydown", (event) => {
          if (event.target.closest(".ai-actions")) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          const row = event.target.closest(".alert-item");
          const alert = row && listedAlerts.get(row.dataset.alertId);
          if (!alert) return;
          event.preventDefault();
          openAlertView(alert);
        });
        function updateList(data) {
          allAlerts = data.alerts || [];
          allArchived = data.archived || [];
          applyFilters();
        }
        async function act(alert, action) {
          try {
            await api("/api/alerts/" + alert.id + "/" + action, "POST", {
              expectedVersion: alert.version,
            });
          } catch (error) {
            window.alert(
              error.status === 409
                ? "This alert changed in another session. The latest version has been loaded."
                : `${niceLabel(action)} failed: ${error.message}`,
            );
          }
          await refreshAll(true);
        }
        async function del(alert) {
          try {
            await api("/api/alerts/" + alert.id, "DELETE", {
              expectedVersion: alert.version,
            });
          } catch (error) {
            window.alert(
              error.status === 409
                ? "This alert changed in another session. The latest version has been loaded."
                : "Delete failed: " + error.message,
            );
          }
          refreshAll(true);
        }
        // Re-arm a (usually closed) alert with the same data + creation-time logic. Warns
        // if the live price is already past the entry (it'll re-arm already-entered).
        async function rearmAlert(a) {
          try {
            const params = new URLSearchParams({
              market: a.market || "cash",
              symbol: a.symbol,
            });
            if (["stock-future", "index-future"].includes(a.market))
              params.set("contractExpiry", a.contractExpiry || "");
            if (["index-option", "stock-option"].includes(a.market)) {
              params.set("contractExpiry", a.contractExpiry || "");
              params.set("strike", String(a.strike || ""));
              params.set("optionType", a.optionType || "");
            }
            const { price } = await api("/api/price?" + params.toString());
            const past =
              price > 0 &&
              (a.side === "BUY" ? price <= a.alertPrice : price >= a.alertPrice);
            const msg = past
              ? `Re-arm ${a.symbol}? Current ${fmtRs(price)} is already ${a.side === "BUY" ? "at/below" : "at/above"} the entry ${fmtRs(a.alertPrice)}, so it will re-arm ALREADY ENTERED (targets/stop-loss track immediately).`
              : `Re-arm ${a.symbol}? It returns to Armed with a fresh state (same alert/stop-loss/targets).`;
            if (!confirm(msg)) return;
          } catch (_) {
            if (!confirm(`Re-arm ${a.symbol}?`)) return;
          }
          try {
            await api("/api/alerts/" + a.id + "/rearm", "POST", {
              expectedVersion: a.version,
            });
          } catch (err) {
            window.alert("Re-arm failed: " + err.message);
            return;
          }
          alertView = "active"; // jump to Active so the re-armed alert is visible
          syncViewToggle();
          closeAlertView();
          refreshAll(true);
        }
        function syncViewToggle() {
          $$("#alertViewToggle .vt").forEach((b) => {
            const on = b.dataset.view === alertView;
            b.classList.toggle("active", on);
            b.setAttribute("aria-selected", String(on));
            b.tabIndex = on ? 0 : -1;
            if (on) $("#alertList").setAttribute("aria-labelledby", b.id);
          });
        }

        // ---------- ringing toasts (any view) ----------
        const toasts = new Map(); // id -> { el, at }
        function toastEl(a) {
          const t = a.lastEvent ? a.lastEvent.type : "ALERT";
          const icon =
            {
              FINAL: "🎯",
              TRIGGER: "🔔",
              REALERT: "🔁",
              FINAL_REALERT: "⏳",
              PARTIAL: "🟡",
              SUCCESS: "✅",
              FAIL: "❌",
            }[t] || "🔔";
          const el = document.createElement("div");
          el.className = "ring-toast";
          el.dataset.alertId = a.id;
          el.innerHTML =
            `<div class="rt-top">${icon} ${a.symbol} <span class="ai-side ${a.side === "BUY" ? "buy" : "sell"}">${a.side}</span></div>` +
            `<div class="rt-msg"></div>` +
            `<div class="rt-actions">` +
            `<button type="button" class="primary" data-toast-action="snooze"><i data-lucide="clock"></i>Snooze</button>` +
            (canCloseAlert(a)
              ? `<button type="button" data-toast-action="close"><i data-lucide="circle-x"></i>Close alert</button>`
              : "") +
            `</div>`;
          el.querySelector(".rt-msg").textContent = a.lastEvent
            ? a.lastEvent.text
            : "";
          el.setAttribute("role", "group");
          el.tabIndex = 0;
          el.setAttribute("aria-label", `${a.symbol} alert notification`);
          return el;
        }
        function updateRinging(alerts) {
          const liveIds = new Set();
          let ringingCount = 0;
          for (const a of alerts) {
            if (!a.ringing) continue;
            ringingCount++;
            const id = String(a.id);
            liveIds.add(id);
            const at = a.lastEvent ? a.lastEvent.at : "";
            const rec = toasts.get(id);
            if (!rec) {
              const el = toastEl(a);
              $("#ringHost").appendChild(el);
              toasts.set(id, { el, at, alert: a });
              beep();
            } else if (rec.at !== at) {
              const el = toastEl(a);
              rec.el.replaceWith(el);
              toasts.set(id, { el, at, alert: a });
              beep();
            } else {
              rec.alert = a;
            }
          }
          for (const [id, rec] of toasts) {
            if (!liveIds.has(id)) {
              rec.el.remove();
              toasts.delete(id);
            }
          }
          const bell = $("#bell");
          if (ringingCount) {
            bell.hidden = false;
            bell.textContent = ringingCount;
          } else bell.hidden = true;
          drawIcons();
        }
        function openToastAlert(alert) {
          activateView("alerts");
          openAlertView(alert);
        }
        $("#ringHost").addEventListener("click", (event) => {
          const toast = event.target.closest(".ring-toast");
          const record = toast && toasts.get(toast.dataset.alertId);
          if (!record) return;
          const action = event.target.closest("[data-toast-action]")?.dataset
            .toastAction;
          if (action) act(record.alert, action);
          else openToastAlert(record.alert);
        });
        $("#ringHost").addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const toast = event.target.closest(".ring-toast");
          const record = toast && toasts.get(toast.dataset.alertId);
          if (!record) return;
          event.preventDefault();
          openToastAlert(record.alert);
        });

        // ---------- notification center ----------
        // Notification receipts are server-owned per user/event so state follows the
        // signed-in user across browsers. localStorage is intentionally not involved.
        let notifItems = []; // [{ a, event, eventId, readAt, ... }] newest first
        const EVENT_ICON = {
          ENTRY: "🎯",
          TRIGGER: "🔔",
          REALERT: "🔁",
          FINAL_REALERT: "⏳",
          PARTIAL: "🟡",
          SUCCESS: "✅",
          FAIL: "❌",
          SL_AFTER_PARTIAL: "🟡",
          UPDATED: "✏️",
        };
        function agoText(iso) {
          if (!iso) return "";
          const s = Math.max(
            0,
            Math.round((Date.now() - new Date(iso).getTime()) / 1000),
          );
          if (s < 60) return s + "s ago";
          const m = Math.round(s / 60);
          if (m < 60) return m + "m ago";
          const h = Math.round(m / 60);
          if (h < 24) return h + "h ago";
          return Math.round(h / 24) + "d ago";
        }
        const unreadCount = () => {
          let count = 0;
          for (const item of notifItems) if (!item.readAt) count++;
          return count;
        };
        function updateNotifBadge() {
          const n = unreadCount();
          const badge = $("#notifBadge"),
            btn = $("#notifBtn");
          if (n > 0) {
            badge.hidden = false;
            badge.textContent = n > 99 ? "99+" : n;
            btn.classList.add("has-unread");
          } else {
            badge.hidden = true;
            btn.classList.remove("has-unread");
          }
        }
        function updateNotifications(payload, alertData) {
          const alertsById = new Map(
            (alertData.alerts || [])
              .concat(alertData.archived || [])
              .map((alert) => [alert.id, alert]),
          );
          const now = new Date().toISOString();
          notifItems = (payload.notifications || [])
            .filter(
              (item) =>
                item.event &&
                !item.dismissedAt &&
                (!item.snoozedUntil || item.snoozedUntil <= now),
            )
            .map((item) => {
              const metadata = item.event.metadata || {};
              const alert = alertsById.get(item.event.alertId) || {
                id: item.event.alertId,
                symbol: metadata.symbol || "Alert",
                index: metadata.index || "",
                market: metadata.market || "cash",
                contractExpiry: metadata.contractExpiry || "",
                strike: metadata.strike || null,
                optionType: metadata.optionType || "",
                side: metadata.side || "",
                status: "closed",
                version: item.event.stateVersion,
              };
              return { ...item, a: alert, eventId: item.event.id };
            });
          updateNotifBadge();
          if ($("#notifPanel").classList.contains("show")) renderNotifs();
        }
        let alertsRefreshPromise = null;
        let alertsRefreshQueued = false;
        // Fetch once per cycle, then update every alert surface from the same snapshot.
        // A forced refresh requested during an in-flight poll is queued exactly once.
        function refreshAll(force = false) {
          if (alertsRefreshPromise) {
            if (force) alertsRefreshQueued = true;
            return alertsRefreshPromise;
          }
          alertsRefreshPromise = (async () => {
            do {
              alertsRefreshQueued = false;
              let data;
              try {
                const [alertData, notificationData, activeData] = await Promise.all([
                  api("/api/alerts/all"),
                  api("/api/notifications"),
                  api("/api/alerts/active"),
                ]);
                const ringingIds = new Set(
                  (activeData.alerts || []).map((alert) => alert.id),
                );
                data = {
                  ...alertData,
                  alerts: (alertData.alerts || []).map((alert) => ({
                    ...alert,
                    ringing: ringingIds.has(alert.id),
                  })),
                };
                updateRinging(activeData.alerts || []);
                updateNotifications(notificationData, data);
              } catch (err) {
                if (!$("#alertsView").hidden)
                  $("#alertList").innerHTML =
                    `<div class="empty">Failed to load: ${esc(err.message)}</div>`;
                return;
              }
              if (!$("#alertsView").hidden) updateList(data);
            } while (alertsRefreshQueued);
          })().finally(() => {
            alertsRefreshPromise = null;
          });
          return alertsRefreshPromise;
        }
        async function markRead(item) {
          if (item.readAt) return;
          item.readAt = new Date().toISOString();
          updateNotifBadge();
          try {
            await api(`/api/notifications/${item.eventId}/read`, "POST", {});
          } catch (_) {
            item.readAt = null;
            updateNotifBadge();
          }
        }
        async function dismissNotif(item) {
          notifItems = notifItems.filter((entry) => entry.eventId !== item.eventId);
          updateNotifBadge();
          try {
            await api(`/api/notifications/${item.eventId}/dismiss`, "POST", {});
          } catch (_) {
            refreshAll(true);
          }
        }
        async function markAllNotifsRead() {
          const unread = notifItems.filter((item) => !item.readAt);
          for (const item of unread) item.readAt = new Date().toISOString();
          updateNotifBadge();
          renderNotifs();
          await Promise.allSettled(
            unread.map((item) =>
              api(`/api/notifications/${item.eventId}/read`, "POST", {}),
            ),
          );
        }
        function renderNotifs() {
          const host = $("#np-list");
          $("#np-count").textContent = notifItems.length
            ? `${unreadCount()} unread · ${notifItems.length} total`
            : "";
          if (!notifItems.length) {
            host.innerHTML = `<div class="notif-empty">No notifications yet.<br>Fired alerts show up here.</div>`;
            return;
          }
          host.innerHTML = "";
          for (const record of notifItems) {
            const { a, event: ev, eventId, readAt } = record;
            const item = document.createElement("div");
            item.className = "notif-item" + (readAt ? "" : " unread");
            item.dataset.eventId = eventId;
            item.innerHTML =
              `<span class="ni-dot"></span>` +
              `<div class="ni-body">` +
              `<div class="ni-line1">` +
              `<span class="ni-icon">${EVENT_ICON[ev.type] || "🔔"}</span>` +
              `<span class="ni-sym">${a.symbol}</span>` +
              `<span class="ai-side ${a.side === "BUY" ? "buy" : "sell"}">${a.side}</span>` +
              `<span class="ai-index">${a.index}</span>` +
              `<span class="ni-time">${agoText(ev.at)}</span>` +
              `</div>` +
              `<div class="ni-msg"></div>` +
              `<div class="ni-actions"></div>` +
              `</div>`;
            item.querySelector(".ni-msg").textContent =
              ev.text || `${ev.type} @ ${fmtRs(ev.price)}`;
            const acts = item.querySelector(".ni-actions");
            const closed = a.status === "closed";
            const lifecycleNotice = ev.type !== "UPDATED";
            if (!closed && lifecycleNotice)
              acts.innerHTML +=
                `<button type="button" class="btn-sm" data-notif-action="snooze"><i data-lucide="clock"></i>Snooze</button>`;
            if (!closed && lifecycleNotice && canCloseAlert(a))
              acts.innerHTML +=
                `<button type="button" class="btn-sm" data-notif-action="close"><i data-lucide="circle-x"></i>Close alert</button>`;
            acts.innerHTML +=
              `<button type="button" class="btn-sm" data-notif-action="dismiss"><i data-lucide="check"></i>Dismiss</button>` +
              `<button type="button" class="btn-sm" data-notif-action="view"><i data-lucide="eye"></i>View</button>`;
            host.appendChild(item);
          }
          drawIcons();
        }
        function notificationFromEvent(event) {
          const item = event.target.closest(".notif-item");
          if (!item) return null;
          const record = notifItems.find(
            (entry) => entry.eventId === item.dataset.eventId,
          );
          return record || null;
        }
        function viewNotification(record) {
          void markRead(record);
          closeNotifPanel();
          activateView("alerts");
          openAlertView(record.a);
        }
        $("#np-list").addEventListener("click", (event) => {
          const record = notificationFromEvent(event);
          if (!record) return;
          const action = event.target.closest("[data-notif-action]")?.dataset
            .notifAction;
          if (action === "snooze") {
            void markRead(record);
            notifItems = notifItems.filter((item) => item.eventId !== record.eventId);
            updateNotifBadge();
            renderNotifs();
            api(`/api/notifications/${record.eventId}/snooze`, "POST", {
              minutes: 15,
            })
              .then(() => refreshAll(true))
              .catch(() => refreshAll(true));
          } else if (action === "close") {
            void markRead(record);
            void dismissNotif(record);
            act(record.a, action);
          } else if (action === "dismiss") {
            void markRead(record);
            void dismissNotif(record);
            renderNotifs();
          } else {
            viewNotification(record);
          }
        });
        $("#np-list").addEventListener("keydown", (event) => {
          if (event.target.closest(".ni-actions")) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          const record = notificationFromEvent(event);
          if (!record) return;
          event.preventDefault();
          viewNotification(record);
        });
        function openNotifPanel() {
          $("#notifPanel").classList.add("show");
          renderNotifs();
          drawIcons();
        }
        function closeNotifPanel() {
          $("#notifPanel").classList.remove("show");
        }

        // ---------- view switch ----------
        // Activate a top-level view ("dash" | "alerts" | "users"). Exposed so other surfaces (e.g.
        // the global notification center's "View") can switch to Alerts before opening a
        // modal that lives inside #alertsView (hidden while on the dashboard).
        function activateView(view) {
          const alertsOn = view === "alerts";
          const usersOn = view === "users";
          const tradesOn = view === "trades";
          const reportsOn = view === "reports";
          const marketOn = view === "market";
          const derivativesOn = view === "derivatives";
          const usstocksOn = view === "usstocks";
          $$(".viewnav .tab").forEach((x) => {
            const on = x.dataset.view === view;
            x.classList.toggle("active", on);
            x.setAttribute("aria-selected", String(on));
            x.tabIndex = on ? 0 : -1;
          });
          $("#dashView").hidden = alertsOn || usersOn || tradesOn || reportsOn || marketOn || derivativesOn || usstocksOn;
          $("#alertsView").hidden = !alertsOn;
          const tradesView = $("#tradesView");
          if (tradesView) tradesView.hidden = !tradesOn;
          const reportsView = $("#reportsView");
          if (reportsView) reportsView.hidden = !reportsOn;
          const marketView = $("#marketView");
          if (marketView) marketView.hidden = !marketOn;
          const derivativesView = $("#derivativesView");
          if (derivativesView) derivativesView.hidden = !derivativesOn;
          const usstocksView = $("#usstocksView");
          if (usstocksView) usstocksView.hidden = !usstocksOn;
          $("#usersView").hidden = !usersOn;
          const dashOn = view === "dash";
          if (dashOn && window.__initOverview) window.__initOverview();
          if (alertsOn) {
            loadSymbols();
            refreshAll(true);
          }
          if (tradesOn && window.__initTrades) window.__initTrades();
          if (reportsOn && window.__initReports) window.__initReports();
          if (marketOn && window.__initMarket) window.__initMarket();
          if (!marketOn && window.__stopMarket) window.__stopMarket();
          if (derivativesOn && window.__initDerivatives) window.__initDerivatives();
          if (!derivativesOn && window.__stopDerivatives) window.__stopDerivatives();
          if (usstocksOn && window.__initUsStocks) window.__initUsStocks();
          if (usersOn && window.__openUsersView) window.__openUsersView();
        }
        $$(".viewnav .tab").forEach((b) => {
          b.onclick = () => activateView(b.dataset.view);
        });
        $(".viewnav").addEventListener("keydown", (e) => {
          const tabs = Array.from($$(".viewnav .tab")).filter((tab) => !tab.hidden);
          const current = tabs.indexOf(document.activeElement);
          if (current < 0) return;
          let next = current;
          if (e.key === "ArrowRight") next = (current + 1) % tabs.length;
          else if (e.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = tabs.length - 1;
          else return;
          e.preventDefault();
          activateView(tabs[next].dataset.view);
          tabs[next].focus();
        });

        // ---------- wire up ----------
        $("#al-index").addEventListener("change", () => {
          fillDatalist();
          loadPrice();
        });
        $("#al-market").addEventListener("change", async () => {
          contractRequest += 1;
          $("#al-symbol").value = "";
          $("#al-price").value = "";
          curPrice = 0;
          resetContractPicker();
          $("#al-contract").hidden = true;
          $("#al-contract").textContent = "";
          $("#al-err").textContent = "";
          await configureInstrument();
          updatePreview();
          updateTargets();
        });
        $("#al-symbol").addEventListener("change", () => {
          if (isDerivativeMarket()) loadContractChoices();
          else loadPrice();
        });
        $("#al-future-expiry").addEventListener("change", () => {
          if (isFutureMarket()) {
            const selected = CONTRACT_CHOICES.find((entry) => entry.expiry === $("#al-future-expiry").value);
            if (selected) selectCurrentContract(selected.lastPrice, `${$("#al-market").value === "index-future" ? "Index" : "Stock"} future · ${$("#al-symbol").value.trim().toUpperCase()} · ${selected.expiry}`);
          } else if (isOptionMarket()) {
            loadOptionContracts();
          }
        });
        $("#al-option-strike").addEventListener("change", () => selectOptionLeg());
        $("#al-option-type").addEventListener("change", () => selectOptionLeg(true));
        $("#al-price").addEventListener("input", () => {
          updatePreview();
          updateTargets();
        });
        $("#al-side").addEventListener("change", () => {
          updatePreview();
          updateTargets();
        });
        $("#al-tf").addEventListener("change", updatePreview);
        $("#al-stop").addEventListener("input", updateTargets);
        $("#al-cancel").onclick = closeAlertModal;
        $("#al-modal-close").onclick = closeAlertModal;
        $("#al-new").onclick = () => {
          resetForm();
          openAlertModal();
        };
        // close on backdrop click / Esc
        $("#alertModal").addEventListener("click", (e) => {
          if (e.target.id === "alertModal") closeAlertModal();
        });
        $("#av-close").onclick = closeAlertView;
        $("#alertViewModal").addEventListener("click", (e) => {
          if (e.target.id === "alertViewModal") closeAlertView();
        });
        // review (approve/reject) modal wiring
        $("#rv-cancel").onclick = closeReviewModal;
        $("#rv-modal-close").onclick = closeReviewModal;
        $("#reviewModal").addEventListener("click", (e) => {
          if (e.target.id === "reviewModal") closeReviewModal();
        });
        [$("#alertModal"), $("#alertViewModal"), $("#reviewModal")].forEach(
          (dialog) =>
            dialog.addEventListener("keydown", (e) => trapDialogFocus(dialog, e)),
        );
        $("#reviewForm").onsubmit = submitReview;
        // notification center wiring
        $("#notifBtn").onclick = () =>
          $("#notifPanel").classList.contains("show")
            ? closeNotifPanel()
            : openNotifPanel();
        $("#np-close").onclick = closeNotifPanel;
        $("#np-backdrop").onclick = closeNotifPanel;
        $("#np-readall").onclick = markAllNotifsRead;
        document.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            if ($("#reviewModal").classList.contains("show")) closeReviewModal();
            else if ($("#alertModal").classList.contains("show")) closeAlertModal();
            else if ($("#alertViewModal").classList.contains("show"))
              closeAlertView();
            else closeNotifPanel();
          }
        });
        $("#alertForm").onsubmit = submitForm;
        $$("#alertViewToggle .vt").forEach((b) => {
          b.onclick = () => {
            alertView = b.dataset.view;
            syncViewToggle();
            applyFilters();
          };
        });
        $("#alertViewToggle").addEventListener("keydown", (e) => {
          const tabs = Array.from($$("#alertViewToggle .vt"));
          const current = tabs.indexOf(document.activeElement);
          if (current < 0) return;
          let next = current;
          if (e.key === "ArrowRight") next = (current + 1) % tabs.length;
          else if (e.key === "ArrowLeft")
            next = (current - 1 + tabs.length) % tabs.length;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = tabs.length - 1;
          else return;
          e.preventDefault();
          alertView = tabs[next].dataset.view;
          syncViewToggle();
          applyFilters();
          tabs[next].focus();
        });

        buildFilters(); // build the multi-select filter dropdowns + chips

        // Mirror backend visibility rules; the server remains authoritative.
        const currentUser = () =>
          (window.APP_AUTH && window.APP_AUTH.user) || null;
        const canCreate = () => {
          const user = currentUser();
          return !!user && (user.role === "editor" || user.role === "admin");
        };
        const canReviewAlert = () => canCreate();
        const isAlertCreator = (alert) => {
          const user = currentUser();
          return !!user && !!alert && alert.createdByUserId === user.id;
        };
        const canEditAlert = (alert) => {
          const user = currentUser();
          if (!canCreate() || !user || !alert) return false;
          if (isAlertCreator(alert)) return true;
          return user.role === "admin" && alert.createdByRole === "editor";
        };
        const canCloseAlert = (alert) => {
          const user = currentUser();
          if (!user || !alert || !canCreate()) return false;
          if (isAlertCreator(alert)) return true;
          return user.role === "admin" && alert.createdByRole === "editor";
        };
        const canRearmAlert = (alert) => canCreate() && isAlertCreator(alert);
        const canDeleteAlert = (alert) => canCreate() && isAlertCreator(alert);
        window.__alertsCanEdit = canCreate;
        window.__reloadAlerts = () => refreshAll(true); // refresh after login
        window.__reloadAlertCreators = () => loadCreators();
        // open a specific alert's detail view from another surface (e.g. the dashboard
        // stock modal) — switch to the Alerts view first so the modal is visible.
        window.__viewAlert = function (a) {
          if (!a) return;
          activateView("alerts");
          openAlertView(a);
        };
        // Dashboard state cards use the same public filter path as the Alerts view,
        // avoiding a second list or a one-off status interpretation.
        window.__openAlertsByFilter = function (key, value) {
          const definition = FILTER_DEFS.find((item) => item.key === key);
          if (!definition || !optsOf(definition).some(([option]) => option === value)) return;
          alertView = "active";
          for (const values of Object.values(sel)) values.clear();
          sel[key].add(value);
          syncFilterChecks();
          updateFilterUI();
          syncViewToggle();
          activateView("alerts");
          applyFilters();
        };
        window.__openAlertsByStatus = (status) =>
          window.__openAlertsByFilter("status", status);

        let alertsPollStarted = false;
        async function pollAlertChanges() {
          if (window.__stateStreamConnected) return;
          try {
            const since = Number(window.__stateRevision) || 0;
            const result = await api(`/api/changes?since=${since}`);
            window.__stateRevision = Number(result.revision) || since;
            if (result.resetRequired || (result.changes && result.changes.length))
              refreshAll(true);
          } catch (_) {
            // Authentication and transient network failures are handled centrally.
          }
        }
        // started by the auth controller once the user is signed in
        window.__initAlerts = async function () {
          document.body.classList.toggle("role-viewer", !canCreate());
          await Promise.all([loadConfig(), loadCreators()]);
          resetForm();
          loadSymbols();
          updatePreview();
          drawIcons();
          refreshAll(true);
          if (!alertsPollStarted) {
            alertsPollStarted = true;
            setInterval(() => {
              if (!window.APP_AUTH || !window.APP_AUTH.user) return; // paused until signed in
              void pollAlertChanges();
            }, 10_000);
          }
        };
      })();
