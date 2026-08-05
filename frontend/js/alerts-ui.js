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
        const niceLabel = (n) =>
          n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
        let editId = null;
        let SYMS = {};
        let OFFSETS = {}; // { timeframe: pct } from the server
        let DEFAULT_OFFSET = 10;
        let curPrice = 0; // live price of the selected symbol (for the trigger preview)
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
              ["raw", "Raw"],
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
        ];
        const sel = {
          index: new Set(),
          status: new Set(),
          side: new Set(),
          tf: new Set(),
          review: new Set(),
          outcome: new Set(),
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
          const advancedKeys = new Set(["tf", "review", "outcome"]);
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
          const advancedCount = ["tf", "review", "outcome"].reduce(
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
        const REVIEW_LABEL = { approved: "Approved", rejected: "Rejected" };
        const reviewLabel = (r) => REVIEW_LABEL[r] || "Raw";
        const reviewBadgeHtml = (a) =>
          `<span class="ai-review ${a.reviewState || "raw"}">${reviewLabel(a.reviewState).toUpperCase()}</span>`;
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
          if (!res.ok || j.error)
            throw new Error(j.error || "HTTP " + res.status);
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
          $("#symList").innerHTML = list
            .map((s) => `<option value="${s}"></option>`)
            .join("");
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
            if (Array.isArray(c.indices) && c.indices.length) {
              ALERT_INDICES = c.indices;
              buildIndexUI();
            }
          } catch (_) {}
        }
        // build the create-form index dropdown from the server's index list; also
        // rebuild the filters so the Index filter reflects the loaded indices
        function buildIndexUI() {
          if (!ALERT_INDICES.includes(alertIndex))
            alertIndex = ALERT_INDICES[0];
          $("#al-index").innerHTML = ALERT_INDICES.map(
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
            const r = await api(
              "/api/price?index=" +
                encodeURIComponent($("#al-index").value) +
                "&symbol=" +
                encodeURIComponent(sym),
            );
            curPrice = r.price || 0;
          } catch (_) {
            curPrice = 0;
          }
          updatePreview();
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
            `<span class="ai-index">${a.index}</span>` +
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
            ? `${a.lastEvent.type} @ ${fmtRs(a.lastEvent.price)}`
            : "-";
          const reward =
            a.profit3 != null
              ? `${fmtRs(a.profit3)} · ${fmtRs(a.profit5)}`
              : "-";
          $("#av-grid").innerHTML = [
            cell("Entry price", fmtRs(a.alertPrice)),
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
          if (!canEdit()) {
            acts.innerHTML =
              `<span class="av-readonly">Read-only access. An editor can approve or reject this alert.</span>`;
          } else if (isArch) {
            // archived alert: re-open (re-arm) or delete
            acts.appendChild(
              btn("Re-open", "btn-sm", () => rearmAlert(a), "rotate-ccw"),
            );
            acts.appendChild(
              btn(
                "Delete",
                "btn-sm danger",
                () => {
                  if (confirm(`Delete archived alert for ${a.symbol}?`)) {
                    del(a.id);
                    closeAlertView();
                  }
                },
                "trash-2",
              ),
            );
          } else {
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
            // (so raw shows both, approved shows only Reject, rejected only Approve).
            if (a.reviewState !== "approved")
              acts.appendChild(
                btn(
                  "Approve",
                  "btn-sm",
                  () => openReviewModal(a, "approve"),
                  "shield-check",
                ),
              );
            if (a.reviewState !== "rejected")
              acts.appendChild(
                btn(
                  "Reject",
                  "btn-sm",
                  () => openReviewModal(a, "reject"),
                  "shield-off",
                ),
              );
            acts.appendChild(
              btn(
                "Close alert",
                "btn-sm",
                async () => {
                  await act(a.id, "close");
                  closeAlertView();
                },
                "circle-x",
              ),
            );
            acts.appendChild(
              btn(
                "Delete",
                "btn-sm danger",
                () => {
                  if (confirm(`Delete alert for ${a.symbol}?`)) {
                    del(a.id);
                    closeAlertView();
                  }
                },
                "trash-2",
              ),
            );
          }
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
              { reason },
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
        function resetForm() {
          editId = null;
          $("#formTitle").textContent = "Create alert";
          $("#al-submit-text").textContent = "Create alert";
          $("#alertForm").reset();
          $("#al-index").value = alertIndex;
          // side, time frame, candle date/time start empty (no premature trigger)
          $("#al-side").value = "";
          $("#al-tf").value = "";
          $("#al-date").value = "";
          $("#al-hour").value = "";
          $("#al-min").value = "";
          // zone creator = the signed-in user (read-only; server sets it authoritatively)
          $("#al-creator").value =
            (window.APP_AUTH && window.APP_AUTH.user && window.APP_AUTH.user.username) ||
            "";
          $("#al-err").textContent = "";
          fillDatalist();
          updatePreview();
          updateTargets();
        }
        function editAlert(a) {
          editId = a.id;
          $("#formTitle").textContent = "Edit alert";
          $("#al-submit-text").textContent = "Save changes";
          $("#al-index").value = a.index;
          fillDatalist();
          $("#al-symbol").value = a.symbol;
          $("#al-side").value = a.side;
          $("#al-price").value = a.alertPrice;
          $("#al-stop").value = a.stopLoss != null ? a.stopLoss : "";
          $("#al-creator").value = a.zoneCreator || "";
          $("#al-note").value = a.note || "";
          $("#al-tf").value = a.timeframe || "";
          $("#al-date").value = a.candleDate || "";
          const [hh, mm] = (a.candleTime || ":").split(":");
          $("#al-hour").value = hh || "";
          $("#al-min").value = mm || "";
          $("#al-err").textContent = "";
          loadPrice();
          updateTargets();
          openAlertModal();
        }
        async function submitForm(e) {
          e.preventDefault();
          const hh = $("#al-hour").value,
            mm = $("#al-min").value;
          const body = {
            index: $("#al-index").value,
            symbol: $("#al-symbol").value.trim().toUpperCase(),
            side: $("#al-side").value,
            alertPrice: parseFloat($("#al-price").value),
            stopLoss: parseFloat($("#al-stop").value),
            // zoneCreator is set server-side from the session (create) / preserved (edit)
            note: $("#al-note").value.trim(),
            timeframe: $("#al-tf").value,
            candleDate: $("#al-date").value || "",
            candleTime: hh && mm ? `${hh}:${mm}` : "",
          };
          // Anchor the Alert (trigger) price to the price the form already had once
          // side + entry + time frame were set (what the preview used) - NOT a fresh
          // save-time tick. Server re-anchors against this instead of its latest price.
          if (curPrice > 0) body.formPrice = curPrice;
          $("#al-err").textContent = "";
          // If the live price is already at/past the entry, warn: the alert will be
          // created already "entered" (targets/stop-loss track immediately).
          if (body.side && body.alertPrice > 0 && body.symbol) {
            try {
              const { price } = await api(
                "/api/price?symbol=" + encodeURIComponent(body.symbol),
              );
              const past =
                price > 0 &&
                (body.side === "BUY"
                  ? price <= body.alertPrice
                  : price >= body.alertPrice);
              if (past) {
                const ok = confirm(
                  `Current price ${fmtRs(price)} is already ${body.side === "BUY" ? "at/below" : "at/above"} your entry ${fmtRs(body.alertPrice)}.\n\n` +
                    `The alert will be created already ENTERED — its 3×/5×/stop-loss can fire immediately.\n\nCreate it anyway?`,
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
                  (!sel.review.size || sel.review.has(a.reviewState || "raw")) &&
                  (!sel.outcome.size || sel.outcome.has(a.zoneOutcome || "pending")),
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
                : canEdit()
                  ? `<div class="empty">No active alerts. Click "New alert" to create one.</div>`
                  : `<div class="empty">No active alerts to view.</div>`;
            return;
          }
          host.innerHTML = "";
          for (const a of alerts) {
            listedAlerts.set(String(a.id), a);
            const isArch = a._archived || a.status === "closed";
            const editable = canEdit();
            const div = document.createElement("div");
            div.dataset.alertId = a.id;
            div.className =
              "alert-item " +
              (a.side === "BUY" ? "side-buy" : "side-sell") +
              (a.ringing ? " ringing" : "") +
              (isArch ? " archived" : "");
            div.innerHTML =
              `<div class="ai-body">` +
              `<div class="ai-line1">` +
              `<span class="ai-sym">${a.symbol}</span>` +
              `<span class="ai-status ${a.status}">${a.status}</span>` +
              `<span class="ai-side ${a.side === "BUY" ? "buy" : "sell"}">${a.side}</span>` +
              `<span class="ai-index">${a.index}</span>` +
              (isArch ? `<span class="ai-archived">Archived</span>` : "") +
              `</div>` +
              `<span class="ai-state-meta">${reviewLabel(a.reviewState)} review · ${zoneText(a.zoneOutcome)} outcome</span>` +
              `<span class="ai-nums">Entry ${fmtRs(a.alertPrice)} · Alert ${fmtRs(a.triggerPrice)} · SL ${fmtRs(a.stopLoss)} · ${a.timeframe || "-"}</span>` +
              `<span class="ai-sub">Targets: 3× ${fmtRs(a.target3)} · 5× ${fmtRs(a.target5)} · Risk ${fmtRs(a.riskR)}</span>` +
              `</div>` +
              (editable ? `<div class="ai-actions"></div>` : "");
            if (!editable) {
              div.setAttribute("role", "button");
              div.tabIndex = 0;
              div.setAttribute("aria-label", `View ${a.symbol} alert details`);
            }
            const acts = div.querySelector(".ai-actions");
            if (editable && isArch) {
              // Keep the resting row focused. Destructive actions live in details.
              acts.innerHTML = listActionHtml(
                "Re-open alert",
                "rearm",
                "rotate-ccw",
              );
            } else if (editable) {
              // Only the next consequential action remains visible; edit/close/delete
              // stay in the detail view where their context is explicit.
              if (a.reviewState === "raw") {
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
            if (editable)
              acts.innerHTML += listActionHtml("View details", "view", "eye");
            host.appendChild(div);
          }
          drawIcons();
        }
        $("#alertList").addEventListener("click", (event) => {
          const row = event.target.closest(".alert-item");
          const alert = row && listedAlerts.get(row.dataset.alertId);
          if (!alert) return;
          const action = event.target.closest("[data-alert-action]")?.dataset
            .alertAction;
          if (action === "rearm") rearmAlert(alert);
          else if (action === "approve" || action === "reject")
            openReviewModal(alert, action);
          else if (action === "snooze") act(alert.id, "snooze");
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
        async function act(id, action) {
          try {
            await api("/api/alerts/" + id + "/" + action, "POST");
          } catch (_) {}
          // snooze/close from ANY surface should also clear this alert's live
          // notification(s), matching what the notification panel's own buttons do.
          if (action === "snooze" || action === "close") {
            for (const it of notifItems)
              if (it.a.id === id) {
                markRead(it.sig);
                dismissNotif(it.sig);
              }
          }
          await refreshAll(true);
        }
        async function del(id) {
          try {
            await api("/api/alerts/" + id, "DELETE");
          } catch (_) {}
          refreshAll(true);
        }
        // Re-arm a (usually closed) alert with the same data + creation-time logic. Warns
        // if the live price is already past the entry (it'll re-arm already-entered).
        async function rearmAlert(a) {
          try {
            const { price } = await api(
              "/api/price?symbol=" + encodeURIComponent(a.symbol),
            );
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
            await api("/api/alerts/" + a.id + "/rearm", "POST");
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
            (canEdit()
              ? `<div class="rt-actions">` +
                `<button type="button" class="primary" data-toast-action="snooze"><i data-lucide="clock"></i>Snooze</button>` +
                `<button type="button" data-toast-action="close"><i data-lucide="circle-x"></i>Close</button>` +
                `</div>`
              : "");
          el.querySelector(".rt-msg").textContent = a.lastEvent
            ? a.lastEvent.text
            : "";
          if (!canEdit()) {
            el.classList.add("read-only");
            el.setAttribute("role", "button");
            el.tabIndex = 0;
            el.setAttribute("aria-label", `View ${a.symbol} alert details`);
          }
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
          if (action) act(record.alert.id, action);
          else if (!canEdit()) openToastAlert(record.alert);
        });
        $("#ringHost").addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const toast = event.target.closest(".ring-toast.read-only");
          const record = toast && toasts.get(toast.dataset.alertId);
          if (!record) return;
          event.preventDefault();
          openToastAlert(record.alert);
        });

        // ---------- notification center ----------
        // One notification per fired alert (its latest event). Persists until the user
        // snoozes/closes it; read/unread state is kept in localStorage across reloads.
        const NOTIF_READ_KEY = "tt_notif_read";
        const NOTIF_DISMISS_KEY = "tt_notif_dismissed";
        const loadSet = (key) => {
          try {
            return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
          } catch (_) {
            return new Set();
          }
        };
        const saveSet = (key, set) => {
          try {
            localStorage.setItem(key, JSON.stringify([...set]));
          } catch (_) {}
        };
        const notifRead = loadSet(NOTIF_READ_KEY);
        const notifDismissed = loadSet(NOTIF_DISMISS_KEY);
        let notifItems = []; // [{ a, sig }] newest first
        // a signature changes whenever the alert fires again -> re-surfaces as unread
        const sigOf = (a) => a.id + ":" + (a.lastEvent ? a.lastEvent.at : "");
        const EVENT_ICON = {
          ENTRY: "🎯",
          TRIGGER: "🔔",
          REALERT: "🔁",
          PARTIAL: "🟡",
          SUCCESS: "✅",
          FAIL: "❌",
          SL_AFTER_PARTIAL: "🟡",
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
          for (const item of notifItems) if (!notifRead.has(item.sig)) count++;
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
        function updateNotifications(data) {
          // Include archived so Entry/Success/Fail of auto-closed alerts still show here.
          const all = (data.alerts || []).concat(data.archived || []);
          const live = new Set();
          const items = [];
          for (const a of all) {
            if (!a.lastEvent || !a.firedCount) continue;
            const sig = sigOf(a);
            live.add(sig);
            if (notifDismissed.has(sig)) continue;
            items.push({ a, sig });
          }
          // prune stale read/dismissed signatures no longer present
          let pruned = false;
          for (const s of notifDismissed)
            if (!live.has(s)) (notifDismissed.delete(s), (pruned = true));
          for (const s of notifRead)
            if (!live.has(s)) (notifRead.delete(s), (pruned = true));
          if (pruned) {
            saveSet(NOTIF_DISMISS_KEY, notifDismissed);
            saveSet(NOTIF_READ_KEY, notifRead);
          }
          items.sort((x, y) =>
            (y.a.lastEvent.at || "").localeCompare(x.a.lastEvent.at || ""),
          );
          notifItems = items;
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
                data = await api("/api/alerts/all");
              } catch (err) {
                if (!$("#alertsView").hidden)
                  $("#alertList").innerHTML =
                    `<div class="empty">Failed to load: ${esc(err.message)}</div>`;
                return;
              }
              updateRinging(data.alerts || []);
              updateNotifications(data);
              if (!$("#alertsView").hidden) updateList(data);
            } while (alertsRefreshQueued);
          })().finally(() => {
            alertsRefreshPromise = null;
          });
          return alertsRefreshPromise;
        }
        function markRead(sig) {
          if (!notifRead.has(sig)) {
            notifRead.add(sig);
            saveSet(NOTIF_READ_KEY, notifRead);
            updateNotifBadge();
          }
        }
        function dismissNotif(sig) {
          notifDismissed.add(sig);
          saveSet(NOTIF_DISMISS_KEY, notifDismissed);
          notifItems = notifItems.filter((it) => it.sig !== sig);
        }
        function markAllNotifsRead() {
          for (const it of notifItems) notifRead.add(it.sig);
          saveSet(NOTIF_READ_KEY, notifRead);
          updateNotifBadge();
          renderNotifs();
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
          for (const { a, sig } of notifItems) {
            const ev = a.lastEvent;
            const item = document.createElement("div");
            item.className = "notif-item" + (notifRead.has(sig) ? "" : " unread");
            item.dataset.notifSig = sig;
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
              (canEdit()
                ? `<div class="ni-actions"></div>`
                : "") +
              `</div>`;
            item.querySelector(".ni-msg").textContent =
              ev.text || `${ev.type} @ ${fmtRs(ev.price)}`;
            const acts = item.querySelector(".ni-actions");
            const closed = a.status === "closed";
            if (acts && !closed) {
              acts.innerHTML =
                `<button type="button" class="btn-sm" data-notif-action="snooze"><i data-lucide="clock"></i>Snooze</button>` +
                `<button type="button" class="btn-sm" data-notif-action="close"><i data-lucide="circle-x"></i>Close alert</button>`;
            } else if (acts) {
              acts.innerHTML = `<button type="button" class="btn-sm" data-notif-action="dismiss"><i data-lucide="check"></i>Dismiss</button>`;
            }
            if (acts)
              acts.innerHTML += `<button type="button" class="btn-sm" data-notif-action="view"><i data-lucide="eye"></i>View</button>`;
            if (!acts) {
              item.setAttribute("role", "button");
              item.tabIndex = 0;
              item.setAttribute("aria-label", `View ${a.symbol} alert details`);
            }
            host.appendChild(item);
          }
          drawIcons();
        }
        function notificationFromEvent(event) {
          const item = event.target.closest(".notif-item");
          if (!item) return null;
          const record = notifItems.find((entry) => entry.sig === item.dataset.notifSig);
          return record || null;
        }
        function viewNotification(record) {
          markRead(record.sig);
          closeNotifPanel();
          activateView("alerts");
          openAlertView(record.a);
        }
        $("#np-list").addEventListener("click", (event) => {
          const record = notificationFromEvent(event);
          if (!record) return;
          const action = event.target.closest("[data-notif-action]")?.dataset
            .notifAction;
          if (action === "snooze" || action === "close") {
            markRead(record.sig);
            dismissNotif(record.sig);
            act(record.a.id, action);
          } else if (action === "dismiss") {
            markRead(record.sig);
            dismissNotif(record.sig);
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
          $$(".viewnav .tab").forEach((x) => {
            const on = x.dataset.view === view;
            x.classList.toggle("active", on);
            x.setAttribute("aria-selected", String(on));
            x.tabIndex = on ? 0 : -1;
          });
          $("#dashView").hidden = alertsOn || usersOn;
          $("#alertsView").hidden = !alertsOn;
          $("#usersView").hidden = !usersOn;
          if (alertsOn) {
            loadSymbols();
            refreshAll(true);
          }
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
        $("#al-symbol").addEventListener("change", loadPrice);
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

        // Only editors can create or modify alerts (server also enforces this).
        const canEdit = () => {
          const r = window.APP_AUTH && window.APP_AUTH.user && window.APP_AUTH.user.role;
          return r === "editor";
        };
        window.__alertsCanEdit = canEdit;
        window.__reloadAlerts = () => refreshAll(true); // refresh after login
        // open a specific alert's detail view from another surface (e.g. the dashboard
        // stock modal) — switch to the Alerts view first so the modal is visible.
        window.__viewAlert = function (a) {
          if (!a) return;
          activateView("alerts");
          openAlertView(a);
        };

        let alertsPollStarted = false;
        // started by the auth controller once the user is signed in
        window.__initAlerts = async function () {
          document.body.classList.toggle("role-viewer", !canEdit());
          try {
            await loadConfig(); // builds the index dropdown, loads offsets
          } catch (_) {}
          resetForm();
          loadSymbols();
          updatePreview();
          drawIcons();
          refreshAll(true);
          if (!alertsPollStarted) {
            alertsPollStarted = true;
            setInterval(() => {
              if (!window.APP_AUTH || !window.APP_AUTH.user) return; // paused until signed in
              refreshAll();
            }, 3000);
          }
        };
      })();
