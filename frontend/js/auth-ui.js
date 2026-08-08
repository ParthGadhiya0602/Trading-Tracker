      (function () {
        "use strict";
        const $ = (s) => document.querySelector(s);
        const APP_AUTH = (window.APP_AUTH = { user: null });
        let appStarted = false;
        let stateEvents = null;
        let telegramStatus = null;
        let telegramLink = null;
        const TELEGRAM_BOT_USERNAME = "ZoneTrackerAlertBot";
        const draw = () => {
          try {
            if (window.lucide) window.lucide.createIcons();
          } catch (_) {}
        };
        async function aapi(path, method = "GET", body) {
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
          if (!res.ok || j.error) throw new Error(j.error || "HTTP " + res.status);
          return j;
        }

        const overlay = $("#authOverlay");
        const showOverlay = () => overlay.classList.remove("hidden");
        const hideOverlay = () => overlay.classList.add("hidden");
        function showSetup() {
          $("#setupPanel").hidden = false;
          $("#loginPanel").hidden = true;
          showOverlay();
          setTimeout(() => $("#su-user").focus(), 60);
        }
        let picked = null;
        function showLogin(users) {
          $("#setupPanel").hidden = true;
          $("#loginPanel").hidden = false;
          $("#pwForm").hidden = true;
          $("#userPicker").hidden = false;
          $("#loginEmpty").hidden = users.length > 0;
          const host = $("#userPicker");
          host.replaceChildren();
          users.forEach((u) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "up-item";
            b.setAttribute("aria-label", `Sign in as ${u.username}`);
            const avatar = document.createElement("span");
            avatar.className = "up-avatar";
            avatar.setAttribute("aria-hidden", "true");
            avatar.textContent = (u.username[0] || "?").toUpperCase();
            const name = document.createElement("span");
            name.className = "up-name";
            name.textContent = u.username;
            const action = document.createElement("span");
            action.className = "up-action";
            const actionLabel = document.createElement("span");
            actionLabel.textContent = "Continue to password";
            const arrow = document.createElement("i");
            arrow.className = "up-arrow";
            arrow.dataset.lucide = "arrow-right";
            arrow.setAttribute("aria-hidden", "true");
            action.append(actionLabel, arrow);
            b.append(avatar, name, action);
            b.onclick = () => pickUser(u);
            host.appendChild(b);
          });
          draw();
          showOverlay();
        }
        function pickUser(u) {
          picked = u;
          $("#userPicker").hidden = true;
          $("#pwForm").hidden = false;
          const selected = $("#pickedUser");
          selected.replaceChildren();
          const avatar = document.createElement("span");
          avatar.className = "up-avatar";
          avatar.setAttribute("aria-hidden", "true");
          avatar.textContent = (u.username[0] || "?").toUpperCase();
          const identity = document.createElement("span");
          const name = document.createElement("strong");
          name.textContent = u.username;
          const context = document.createElement("small");
          context.textContent = "Account selected";
          identity.append(name, context);
          selected.append(avatar, identity);
          $("#li-err").textContent = "";
          $("#li-pw").value = "";
          setTimeout(() => $("#li-pw").focus(), 50);
        }
        $("#li-back").onclick = () => {
          picked = null;
          $("#userPicker").hidden = false;
          $("#pwForm").hidden = true;
        };

        function chrome(user) {
          $("#userNav").hidden = false;
          $("#whoami").textContent = user.username + " · " + user.role;
          $("#view-tab-users").hidden = user.role !== "admin";
          updateTelegramDot(user.telegram);
        }
        function updateTelegramDot(status) {
          const dot = $("#telegramDot");
          dot.hidden = !(status && status.linked && status.enabled && status.reachable);
        }
        function startStateEvents() {
          if (stateEvents || !window.EventSource) return;
          stateEvents = new EventSource("/api/events");
          stateEvents.onopen = () => {
            window.__stateStreamConnected = true;
          };
          stateEvents.onerror = () => {
            window.__stateStreamConnected = false;
          };
          stateEvents.addEventListener("state", (event) => {
            let change = {};
            try {
              change = JSON.parse(event.data || "{}");
            } catch (_) {}
            const revision = Number(change.revision) || 0;
            if (change.kind === "ready") {
              window.__stateRevision = revision;
              window.__reloadAlerts && window.__reloadAlerts();
              void loadTelegramStatus();
              return;
            }
            window.__stateRevision = Math.max(
              Number(window.__stateRevision) || 0,
              revision,
            );
            if (change.kind === "telegram") void loadTelegramStatus();
            if (
              change.kind === "users" &&
              APP_AUTH.user &&
              APP_AUTH.user.role === "admin" &&
              !$("#usersView").hidden &&
              window.__reloadUsers
            ) {
              void window.__reloadUsers({ selectedId: umEditId }).then(
                syncManagedTelegramState,
              );
            }
            if (change.kind === "alert" || change.kind === "notification") {
              window.__reloadAlerts && window.__reloadAlerts();
              window.__reloadOverview && window.__reloadOverview();
            }
          });
        }
        function onAuthed(user) {
          picked = null;
          $("#userPicker").replaceChildren();
          APP_AUTH.user = user;
          hideOverlay();
          chrome(user);
          startStateEvents();
          document.body.classList.toggle(
            "role-viewer",
            user.role !== "editor" && user.role !== "admin",
          );
          draw();
          if (!appStarted) {
            appStarted = true;
            try {
              window.__initDash && window.__initDash();
            } catch (_) {}
            try {
              window.__initAlerts && window.__initAlerts();
            } catch (_) {}
            try {
              window.__initOverview && window.__initOverview();
            } catch (_) {}
          } else {
            window.__reloadAlerts && window.__reloadAlerts();
            window.__reloadOverview && window.__reloadOverview();
          }
        }

        $("#setupPanel").addEventListener("submit", async (e) => {
          e.preventDefault();
          const u = $("#su-user").value.trim(),
            p = $("#su-pw").value,
            p2 = $("#su-pw2").value;
          $("#su-err").textContent = "";
          if (p !== p2) {
            $("#su-err").textContent = "passwords do not match";
            return;
          }
          try {
            const r = await aapi("/api/auth/setup", "POST", { username: u, password: p });
            onAuthed(r.user);
          } catch (err) {
            $("#su-err").textContent = err.message;
          }
        });
        $("#pwForm").addEventListener("submit", async (e) => {
          e.preventDefault();
          if (!picked) return;
          $("#li-err").textContent = "";
          try {
            const r = await aapi("/api/auth/login", "POST", {
              username: picked.username,
              password: $("#li-pw").value,
            });
            onAuthed(r.user);
          } catch (err) {
            $("#li-err").textContent = err.message;
          }
        });
        $("#logoutBtn").onclick = async () => {
          try {
            await aapi("/api/auth/logout", "POST");
          } catch (_) {}
          APP_AUTH.user = null;
          if (stateEvents) stateEvents.close();
          window.__stateStreamConnected = false;
          location.reload(); // simplest clean reset of all app state
        };
        // any protected call returning 401 (session expired) -> back to login
        window.__onAuthExpired = () => {
          if (APP_AUTH.user) {
            APP_AUTH.user = null;
            location.reload();
          }
        };

        // ----- personal Telegram delivery settings -----
        function telegramPanelOpen() {
          return $("#telegramPanel").classList.contains("show");
        }
        function closeTelegramPanel() {
          $("#telegramPanel").classList.remove("show");
          $("#telegramBtn").focus();
        }
        function telegramButton(label, action, className = "") {
          return `<button type="button" class="${className}" data-tg-action="${action}">${label}</button>`;
        }
        async function copyText(text) {
          try {
            await navigator.clipboard.writeText(text);
          } catch (_) {
            const input = document.createElement("textarea");
            input.value = text;
            input.setAttribute("readonly", "");
            input.style.position = "fixed";
            input.style.opacity = "0";
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            input.remove();
          }
        }
        function telegramStep(number, title, copy, state, controls = "") {
          return (
            `<li class="tg-step ${state}">` +
            `<span class="tg-step-number" aria-hidden="true">${number}</span>` +
            `<div><strong>${title}</strong><p>${copy}</p>${controls}</div>` +
            `</li>`
          );
        }
        function renderTelegramLink(config) {
          const command = `/link ${telegramLink.code}`;
          const username = config.botUsername || TELEGRAM_BOT_USERNAME;
          const botUrl = username
            ? `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(telegramLink.code)}`
            : "";
          const expires = new Date(telegramLink.expiresAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          $("#tg-body").innerHTML =
            `<div class="tg-progress" aria-label="Connection progress"><span class="done">1</span><i></i><span class="active">2</span><i></i><span>3</span></div>` +
            `<ol class="tg-steps">` +
            telegramStep(1, "Secure link created", `This single-use link expires at ${expires}.`, "complete") +
            telegramStep(
              2,
              "Open the bot",
              username
                ? `Telegram will open <strong>@${esc(username)}</strong> with your secure code attached.`
                : "Open the configured bot in Telegram, then use the manual command below.",
              "active",
              botUrl
                ? `<a class="tg-primary-link" href="${botUrl}" target="_blank" rel="noopener">Open Telegram and connect</a>`
                : "",
            ) +
            telegramStep(
              3,
              "Tap Start in Telegram",
              "The bot will confirm your Trading Tracker username here automatically.",
              "pending",
              `<div class="tg-wait"><span aria-hidden="true"></span>Waiting for confirmation</div>`,
            ) +
            `</ol>` +
            `<details class="tg-manual"><summary>Connect manually instead</summary>` +
            `<p>Send this command to the bot before the link expires.</p>` +
            `<div class="tg-command"><code>${esc(command)}</code>` +
            `<button type="button" data-tg-action="copy" data-command="${esc(command)}">Copy command</button></div>` +
            `</details>` +
            `<div class="tg-actions">${telegramButton("Check connection", "refresh")}${telegramButton("Create a new link", "generate")}</div>`;
        }
        function renderTelegramServerSetup() {
          const isAdmin = APP_AUTH.user && APP_AUTH.user.role === "admin";
          if (!isAdmin) {
            $("#tg-body").innerHTML =
              `<div class="tg-state tg-state-warning"><div><strong>Server setup required</strong>` +
              `<span>Ask an administrator to configure the Telegram bot. In-app alerts continue to work.</span></div></div>`;
            return;
          }
          $("#tg-body").innerHTML =
            `<div class="tg-state tg-state-warning"><div><strong>Set up @${TELEGRAM_BOT_USERNAME}</strong>` +
            `<span>Complete this once for the server. Users can then connect their own chats.</span></div></div>` +
            `<ol class="tg-steps tg-server-steps">` +
            telegramStep(1, "Create a bot", `Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>, send <code>/newbot</code>, and copy the token and username.`, "active") +
            telegramStep(
              2,
              "Add local configuration",
              `Add these values inside <code>config.json</code>.`,
              "pending",
              `<pre class="tg-config-example"><code>&quot;telegram&quot;: {
  &quot;botToken&quot;: &quot;PASTE_BOT_TOKEN&quot;,
  &quot;botUsername&quot;: &quot;${TELEGRAM_BOT_USERNAME}&quot;
}</code></pre>`,
            ) +
            telegramStep(3, "Restart the server", `Run <code>npm start</code>, then return here. The connection button will become available automatically.`, "pending") +
            `</ol>` +
            `<p class="tg-security">Keep the bot token private. Never paste it into the browser or commit it to Git.</p>`;
        }
        function renderTelegramStatus() {
          const host = $("#tg-body");
          if (!telegramStatus) {
            host.innerHTML = `<p class="tg-muted">Loading Telegram status…</p>`;
            return;
          }
          const { config, telegram, deliveries } = telegramStatus;
          if (!config.configured) {
            renderTelegramServerSetup();
            return;
          }
          if (!telegram.linked) {
            if (telegramLink && new Date(telegramLink.expiresAt).getTime() > Date.now()) {
              renderTelegramLink(config);
              return;
            }
            telegramLink = null;
            host.innerHTML =
              `<div class="tg-state"><div><strong>Connect in about 30 seconds</strong>` +
              `<span>Your private chat ID stays on this server and is never shown to other users.</span></div></div>` +
              `<ol class="tg-steps">` +
              telegramStep(1, "Create a secure link", "The link works once and expires after ten minutes.", "active", telegramButton("Create connection link", "generate", "primary")) +
              telegramStep(2, `Open @${TELEGRAM_BOT_USERNAME}`, "Send the connection request to this bot; your secure code will be attached automatically.", "pending") +
              telegramStep(3, "Tap Start", "The bot confirms the account and enables future alert delivery.", "pending") +
              `</ol>`;
            return;
          }
          telegramLink = null;
          const pending = Number(deliveries.counts.pending || 0) + Number(deliveries.counts.failed || 0);
          const stateText = !telegram.reachable
            ? "Delivery unavailable"
            : telegram.enabled
              ? "Delivery enabled"
              : "Delivery paused";
          const stateDetail = !telegram.reachable
            ? "Telegram rejected delivery. Disconnect this link, then connect the account again."
            : pending
              ? `${pending} message${pending === 1 ? "" : "s"} waiting for retry.`
              : telegram.enabled
                ? "Connected. Future eligible alerts will be delivered to your Telegram chat."
                : "Your chat remains connected, but new Telegram deliveries are paused.";
          const stateClass = !telegram.reachable
            ? "tg-state-unreachable"
            : telegram.enabled
              ? "tg-state-connected"
              : "tg-state-paused";
          host.innerHTML =
            `<div class="tg-state ${stateClass}"><span class="tg-status-mark" aria-hidden="true"></span><div><strong>${stateText}</strong><span>${stateDetail}</span></div></div>` +
            `<div class="tg-actions">` +
            (telegram.reachable
              ? telegramButton(telegram.enabled ? "Pause delivery" : "Enable delivery", "toggle")
              : "") +
            telegramButton("Disconnect Telegram", "disconnect", "danger") +
            `</div>`;
        }
        async function loadTelegramStatus() {
          if (!APP_AUTH.user) return;
          try {
            telegramStatus = await aapi("/api/telegram/status");
            APP_AUTH.user.telegram = telegramStatus.telegram;
            updateTelegramDot(telegramStatus.telegram);
            if (telegramPanelOpen()) renderTelegramStatus();
          } catch (error) {
            if (telegramPanelOpen())
              $("#tg-body").innerHTML =
                `<p class="tg-error">Could not load Telegram settings. ${esc(error.message)}</p>`;
          }
        }
        async function generateTelegramCode(button) {
          button.disabled = true;
          button.textContent = "Generating…";
          try {
            const result = await aapi("/api/telegram/link-code", "POST", {});
            telegramLink = result;
            renderTelegramLink(telegramStatus.config);
          } catch (error) {
            $("#tg-body").innerHTML =
              `<p class="tg-error">Could not generate a link code. ${esc(error.message)}</p>` +
              `<div class="tg-actions">${telegramButton("Try again", "generate", "primary")}</div>`;
          }
        }
        $("#telegramBtn").onclick = () => {
          $("#telegramPanel").classList.add("show");
          telegramStatus = null;
          renderTelegramStatus();
          void loadTelegramStatus();
          setTimeout(() => $("#tg-close").focus(), 0);
        };
        $("#tg-close").onclick = closeTelegramPanel;
        $("#tg-backdrop").onclick = closeTelegramPanel;
        $("#tg-body").addEventListener("click", async (event) => {
          const button = event.target.closest("[data-tg-action]");
          if (!button) return;
          const action = button.dataset.tgAction;
          if (action === "generate") return generateTelegramCode(button);
          if (action === "refresh") return loadTelegramStatus();
          if (action === "copy") {
            const command = button.dataset.command || "";
            await copyText(command);
            button.textContent = "Copied";
            setTimeout(() => {
              if (button.isConnected) button.textContent = "Copy command";
            }, 1800);
            return;
          }
          if (action === "toggle") {
            button.disabled = true;
            try {
              await aapi("/api/telegram/enabled", "POST", {
                enabled: !telegramStatus.telegram.enabled,
              });
              await loadTelegramStatus();
            } catch (error) {
              $("#tg-body").innerHTML = `<p class="tg-error">Could not update delivery. ${esc(error.message)}</p>`;
            }
          }
          if (action === "disconnect") {
            if (!confirm("Disconnect Telegram from your account? Future alerts will remain available in the app.")) return;
            button.disabled = true;
            try {
              await aapi("/api/telegram/link", "DELETE", {});
              telegramLink = null;
              await loadTelegramStatus();
            } catch (error) {
              $("#tg-body").innerHTML = `<p class="tg-error">Could not disconnect Telegram. ${esc(error.message)}</p>`;
            }
          }
        });
        $("#telegramPanel").addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeTelegramPanel();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            $("#telegramPanel").querySelectorAll(
              'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => !element.hidden && element.offsetParent !== null);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        });

        // ----- admin: user access workspace -----
        const ROLE_INFO = {
          admin: {
            icon: "shield-check",
            title: "Admin",
            copy: "Can create and review alerts, close editor alerts, and manage users.",
          },
          editor: {
            icon: "pencil-line",
            title: "Editor",
            copy: "Can manage alerts, including approval and rejection.",
          },
          viewer: {
            icon: "eye",
            title: "Viewer",
            copy: "Read-only access to market data and alerts.",
          },
        };
        const esc = (value) =>
          String(value == null ? "" : value).replace(
            /[&<>"']/g,
            (ch) =>
              ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
                ch
              ],
          );
        const fmtUserDate = (iso) => {
          if (!iso) return "Never";
          const date = new Date(iso);
          if (Number.isNaN(date.getTime())) return "—";
          return date.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          });
        };
        const initials = (username) => {
          const parts = String(username || "?")
            .trim()
            .split(/[\s._-]+/)
            .filter(Boolean);
          return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : ""))
            .toUpperCase()
            .slice(0, 2);
        };
        let umUsers = [];
        let umEditId = null;
        let umLoaded = false;
        let umDeleteArmed = false;
        let umLastFocus = null;
        const activeUser = () => umUsers.find((user) => user.id === umEditId) || null;
        function setUserPageStatus(message = "", error = false) {
          const status = $("#um-page-status");
          status.textContent = message;
          status.classList.toggle("error", error);
        }
        function userModalOpen(trigger) {
          umLastFocus = trigger || document.activeElement;
          $("#um-modal").hidden = false;
          setUserPageStatus();
          setTimeout(() => $("#um-user").focus(), 0);
        }
        function userModalClose({ restoreFocus = true } = {}) {
          $("#um-modal").hidden = true;
          umResetForm();
          if (restoreFocus) {
            const target = umLastFocus && umLastFocus.isConnected ? umLastFocus : $("#um-new");
            target && target.focus();
          }
          umLastFocus = null;
        }
        function telegramState(user) {
          const telegram = user.telegram || {};
          if (!telegram.linked)
            return {
              text: "Not linked",
              className: " unlinked",
              detail: "No Telegram account is connected.",
            };
          if (telegram.reachable === false)
            return {
              text: "Unavailable",
              className: " disabled",
              detail: "The bot cannot currently reach this account.",
            };
          if (telegram.enabled === false)
            return {
              text: "Paused",
              className: " paused",
              detail: "Telegram delivery is paused for this account.",
            };
          return {
            text: "Linked",
            className: "",
            detail: "Alert messages are delivered to this account.",
          };
        }
        function renderManagedTelegram(user, detailHtml = "", hideAction = false) {
          const state = telegramState(user);
          const action = user.telegram && user.telegram.linked ? "disconnect" : "generate";
          const actionLabel = action === "disconnect" ? "Disconnect" : "Connect";
          $("#um-telegram-manage").innerHTML =
            `<div class="um-telegram-status-row"><div class="um-telegram-status-copy">` +
            `<span class="um-state${state.className}">${state.text}</span>` +
            `<span>${state.detail}</span></div>` +
            (hideAction
              ? ""
              : `<button type="button"${action === "disconnect" ? ' class="danger"' : ""} data-um-tg-action="${action}">${actionLabel}</button>`) +
            `</div>${detailHtml}`;
          draw();
        }
        function renderManagedTelegramLink(user, result) {
          const username = result.botUsername || TELEGRAM_BOT_USERNAME;
          const botUrl = `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(result.code)}`;
          const command = `/link ${result.code}`;
          const expires = new Date(result.expiresAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          const detail =
            `<p>Open this link on <strong>${esc(user.username)}'s device</strong>. ` +
            `The link expires at ${expires} and can be used only once.</p>` +
            `<div class="tg-actions"><a class="tg-primary-link" href="${botUrl}" target="_blank" rel="noopener">Open @${esc(username)}</a>` +
            `<button type="button" data-um-tg-action="copy-link" data-copy="${esc(botUrl)}">Copy connection link</button></div>` +
            `<details class="tg-manual"><summary>Connect manually instead</summary>` +
            `<p>Send this command to <strong>@${esc(username)}</strong>.</p>` +
            `<div class="tg-command"><code>${esc(command)}</code>` +
            `<button type="button" data-um-tg-action="copy-command" data-copy="${esc(command)}">Copy command</button></div></details>` +
            `<div class="tg-wait"><span aria-hidden="true"></span>Waiting for ${esc(user.username)} to connect</div>`;
          renderManagedTelegram(user, detail, true);
        }
        function syncManagedTelegramState() {
          const user = activeUser();
          if (!user || $("#um-modal").hidden) return;
          renderManagedTelegram(user);
        }
        function clearUserMessages() {
          $("#um-err").textContent = "";
          $("#um-success").textContent = "";
        }
        function roleGuide(role) {
          const info = ROLE_INFO[role] || ROLE_INFO.viewer;
          $("#um-role-help").innerHTML =
            `<i data-lucide="${info.icon}" aria-hidden="true"></i>` +
            `<div><strong>${info.title}</strong><span>${info.copy}</span></div>`;
          draw();
        }
        function setDeleteArmed(armed) {
          umDeleteArmed = armed;
          const user = activeUser();
          $("#um-delete").textContent = armed ? "Confirm delete" : "Delete user";
          $("#um-delete-hint").textContent = armed
            ? `Permanently remove ${user ? user.username : "this user"}?`
            : "This action cannot be undone.";
          $("#um-delete").classList.toggle("confirming", armed);
        }
        function umResetForm({ focus = false, success = "" } = {}) {
          umEditId = null;
          $("#um-form-title").textContent = "Add user";
          $("#um-form-sub").textContent = "Create an account with the minimum access needed.";
          $("#um-save-label").textContent = "Add user";
          $("#um-cancel").hidden = false;
          $("#um-user").value = "";
          $("#um-pw").value = "";
          $("#um-pw").required = true;
          $("#um-pw-label").textContent = "Password";
          $("#um-pw-help").textContent = "Use at least 6 characters.";
          $("#um-role").value = "viewer";
          $("#um-access").hidden = true;
          $("#um-telegram-setting").hidden = true;
          $("#um-telegram-manage").replaceChildren();
          $("#um-meta").hidden = true;
          $("#um-danger").hidden = true;
          $("#um-editor-state").textContent = "New";
          $("#um-editor-state").className = "um-editor-state";
          $(".um-editor-icon").innerHTML = '<i data-lucide="user-plus"></i>';
          clearUserMessages();
          $("#um-success").textContent = success;
          roleGuide("viewer");
          setDeleteArmed(false);
          renderUsers();
          draw();
          if (focus) $("#um-user").focus();
        }
        function renderSummary() {
          $("#um-total").textContent = umUsers.length;
          let enabled = 0;
          let disabled = 0;
          let admins = 0;
          for (const user of umUsers) {
            if (user.disabled) disabled++;
            else enabled++;
            if (user.role === "admin") admins++;
          }
          $("#um-enabled").textContent = enabled;
          $("#um-disabled").textContent = disabled;
          $("#um-admins").textContent = admins;
        }
        function filteredUsers() {
          const query = $("#um-search").value.trim().toLowerCase();
          const role = $("#um-filter-role").value;
          const status = $("#um-filter-status").value;
          return umUsers
            .filter((user) => {
              if (query && !user.username.toLowerCase().includes(query)) return false;
              if (role !== "all" && user.role !== role) return false;
              return (
                status === "all" ||
                (status === "disabled" ? user.disabled : !user.disabled)
              );
            })
            .sort((a, b) => {
              if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
              return a.username.localeCompare(b.username);
            });
        }
        function renderUsers() {
          const host = $("#um-list");
          if (!host || !umLoaded) return;
          const users = filteredUsers();
          $(".um-tablewrap").hidden = users.length === 0;
          $("#um-empty").hidden = users.length !== 0;
          let rows = "";
          for (const user of users) {
            const selected = user.id === umEditId;
            const lastLogin = fmtUserDate(user.lastLoginAt);
            const updated = fmtUserDate(user.updatedAt);
            const telegram = telegramState(user);
            rows +=
                `<tr${selected ? ' class="selected"' : ""}>` +
                `<td><div class="um-user-cell"><span class="um-avatar" aria-hidden="true">${initials(user.username)}</span>` +
                `<span class="um-identity"><span class="um-name">${esc(user.username)}</span><span class="um-role-mobile">${esc(user.role)}</span></span></div></td>` +
                `<td><span class="um-role ${esc(user.role)}">${esc(user.role)}</span></td>` +
                `<td><span class="um-state${user.disabled ? " disabled" : ""}">${user.disabled ? "Disabled" : "Enabled"}</span></td>` +
                `<td><span class="um-state${telegram.className}">${telegram.text}</span></td>` +
                `<td><span class="um-date${user.lastLoginAt ? "" : " um-never"}">${lastLogin}</span></td>` +
                `<td><span class="um-date">${updated}</span></td>` +
                `<td><button type="button" class="btn-sm um-edit" data-user-id="${esc(user.id)}" aria-label="Edit ${esc(user.username)}"><i data-lucide="pencil" aria-hidden="true"></i>Edit</button></td>` +
                `</tr>`;
          }
          host.innerHTML = rows;
          draw();
        }
        async function loadUsers({ selectedId = umEditId, announce = "" } = {}) {
          const host = $("#um-list");
          if (!umLoaded)
            host.innerHTML = '<tr class="um-loading"><td colspan="7">Loading accounts…</td></tr>';
          try {
            const data = await aapi("/api/users");
            umUsers = data.users || [];
            umLoaded = true;
            renderSummary();
            if (selectedId) {
              const selected = umUsers.find((user) => user.id === selectedId);
              if (selected) umEdit(selected, false, announce);
              else umResetForm({ success: announce });
            } else {
              renderUsers();
              if (announce) $("#um-success").textContent = announce;
            }
          } catch (error) {
            umLoaded = true;
            host.innerHTML = `<tr class="um-loading"><td colspan="7">Could not load users. ${esc(error.message)}</td></tr>`;
            $("#um-err").textContent = `${error.message}. Retry by reopening the Users tab.`;
            setUserPageStatus(`Could not load users. ${error.message}`, true);
            return;
          }
        }
        function umEdit(user, focus = false, success = "") {
          umEditId = user.id;
          $("#um-form-title").textContent = "Edit user";
          $("#um-form-sub").textContent = user.username;
          $("#um-save-label").textContent = "Save changes";
          $("#um-cancel").hidden = false;
          $("#um-user").value = user.username;
          $("#um-pw").value = "";
          $("#um-pw").required = false;
          $("#um-pw-label").textContent = "New password";
          $("#um-pw-help").textContent = "Leave blank to keep the current password.";
          $("#um-role").value = user.role;
          $("#um-access").hidden = false;
          $("#um-telegram-setting").hidden = false;
          $("#um-meta").hidden = false;
          $("#um-danger").hidden = false;
          $("#um-meta-login").textContent = fmtUserDate(user.lastLoginAt);
          $("#um-meta-created").textContent = fmtUserDate(user.createdAt);
          $("#um-meta-updated").textContent = fmtUserDate(user.updatedAt);
          $("#um-editor-state").textContent = user.disabled ? "Disabled" : "Enabled";
          $("#um-editor-state").className =
            "um-editor-state" + (user.disabled ? " disabled" : "");
          $(".um-editor-icon").innerHTML = '<i data-lucide="user-cog"></i>';
          $("#um-toggle").setAttribute("aria-checked", String(!user.disabled));
          $("#um-toggle b").textContent = user.disabled ? "Disabled" : "Enabled";
          $("#um-access-copy").textContent = user.disabled
            ? "This account cannot sign in."
            : "This account can sign in.";
          renderManagedTelegram(user);
          clearUserMessages();
          $("#um-success").textContent = success;
          roleGuide(user.role);
          setDeleteArmed(false);
          renderUsers();
          draw();
          if (focus) $("#um-user").focus();
        }
        function setUserBusy(busy) {
          ["#um-user", "#um-pw", "#um-role", "#um-save", "#um-cancel", "#um-toggle", "#um-delete", "#um-close"].forEach(
            (selector) => {
              const element = $(selector);
              if (element) element.disabled = busy;
            },
          );
          $("#um-form").setAttribute("aria-busy", String(busy));
          if (busy) $("#um-save-label").textContent = umEditId ? "Saving…" : "Adding…";
        }
        $("#um-new").onclick = (event) => {
          umResetForm();
          userModalOpen(event.currentTarget);
        };
        $("#um-cancel").onclick = () => userModalClose();
        $("#um-close").onclick = () => userModalClose();
        $("#um-modal-backdrop").onclick = () => userModalClose();
        $("#um-list").addEventListener("click", (event) => {
          const button = event.target.closest(".um-edit");
          if (!button) return;
          const user = umUsers.find((item) => item.id === button.dataset.userId);
          if (user) {
            umEdit(user);
            userModalOpen(button);
          }
        });
        $("#um-telegram-manage").addEventListener("click", async (event) => {
          const button = event.target.closest("[data-um-tg-action]");
          if (!button) return;
          const user = activeUser();
          if (!user) return;
          const action = button.dataset.umTgAction;
          if (action === "copy-link" || action === "copy-command") {
            await copyText(button.dataset.copy || "");
            const previous = button.textContent;
            button.textContent = "Copied";
            setTimeout(() => {
              if (button.isConnected) button.textContent = previous;
            }, 1800);
            return;
          }
          if (action === "disconnect") {
            if (
              !confirm(
                `Disconnect Telegram for ${user.username}? Future alerts will remain available in the app.`,
              )
            )
              return;
            button.disabled = true;
            button.textContent = "Disconnecting…";
            try {
              await aapi(`/api/users/${user.id}/telegram/link`, "DELETE");
              await loadUsers({ selectedId: user.id });
              if (APP_AUTH.user && APP_AUTH.user.id === user.id)
                await loadTelegramStatus();
              $("#um-success").textContent = "Telegram disconnected.";
            } catch (error) {
              renderManagedTelegram(
                user,
                `<p class="tg-error">Could not disconnect Telegram. ${esc(error.message)}</p>`,
              );
            }
            return;
          }
          if (action !== "generate") return;
          button.disabled = true;
          button.textContent = "Creating link…";
          try {
            const result = await aapi(
              `/api/users/${user.id}/telegram/link-code`,
              "POST",
              {},
            );
            renderManagedTelegramLink(user, result);
          } catch (error) {
            renderManagedTelegram(
              user,
              `<p class="tg-error">Could not create a connection link. ${esc(error.message)}</p>`,
            );
          }
        });
        $("#um-modal").addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            if ($("#um-form").getAttribute("aria-busy") === "true") return;
            event.preventDefault();
            userModalClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            $("#um-modal").querySelectorAll(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => !element.hidden && element.offsetParent !== null);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        });
        $("#um-search").addEventListener("input", renderUsers);
        $("#um-filter-role").addEventListener("change", renderUsers);
        $("#um-filter-status").addEventListener("change", renderUsers);
        $("#um-role").addEventListener("change", (event) => roleGuide(event.target.value));
        $("#um-toggle").onclick = async () => {
          const user = activeUser();
          if (!user) return;
          clearUserMessages();
          setUserBusy(true);
          try {
            await aapi("/api/users/" + user.id, "PATCH", { disabled: !user.disabled });
            if (APP_AUTH.user && APP_AUTH.user.id === user.id) {
              location.reload();
              return;
            }
            await loadUsers({
              selectedId: user.id,
              announce: user.disabled ? "Account enabled." : "Account disabled.",
            });
          } catch (error) {
            $("#um-err").textContent = `${error.message}. The account was not changed.`;
          } finally {
            setUserBusy(false);
            if (activeUser()) $("#um-save-label").textContent = "Save changes";
          }
        };
        $("#um-delete").onclick = async () => {
          const user = activeUser();
          if (!user) return;
          if (!umDeleteArmed) {
            setDeleteArmed(true);
            $("#um-delete").focus();
            return;
          }
          clearUserMessages();
          setUserBusy(true);
          try {
            await aapi("/api/users/" + user.id, "DELETE");
            if (APP_AUTH.user && APP_AUTH.user.id === user.id) {
              location.reload();
              return;
            }
            await loadUsers({ selectedId: null });
            setUserBusy(false);
            userModalClose();
            setUserPageStatus(`${user.username} was deleted.`);
          } catch (error) {
            $("#um-err").textContent = `${error.message}. The user was not deleted.`;
            setDeleteArmed(false);
          } finally {
            setUserBusy(false);
            if (activeUser()) $("#um-save-label").textContent = "Save changes";
          }
        };
        $("#um-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          if (!e.currentTarget.checkValidity()) {
            e.currentTarget.reportValidity();
            return;
          }
          clearUserMessages();
          const username = $("#um-user").value.trim(),
            pw = $("#um-pw").value,
            role = $("#um-role").value;
          const editingId = umEditId;
          setUserBusy(true);
          try {
            let result;
            if (editingId) {
              const patch = { username, role };
              if (pw) patch.password = pw;
              result = await aapi("/api/users/" + editingId, "PATCH", patch);
            } else {
              result = await aapi("/api/users", "POST", { username, password: pw, role });
            }
            if (editingId && APP_AUTH.user && APP_AUTH.user.id === editingId) {
              location.reload();
              return;
            }
            await loadUsers({ selectedId: null });
            setUserBusy(false);
            userModalClose();
            setUserPageStatus(
              editingId
                ? `${result.user.username} was updated.`
                : `${result.user.username} was added.`,
            );
          } catch (err) {
            $("#um-err").textContent = `${err.message}. Review the fields and try again.`;
          } finally {
            setUserBusy(false);
            $("#um-save-label").textContent = umEditId ? "Save changes" : "Add user";
          }
        });
        window.__openUsersView = () => {
          if (!umLoaded) umResetForm();
          loadUsers();
        };
        window.__reloadUsers = loadUsers;

        // ----- boot -----
        (async () => {
          try {
            const st = await aapi("/api/auth/status");
            if (st.user) {
              onAuthed(st.user);
              return;
            }
            if (st.needsSetup) {
              showSetup();
              return;
            }
            const up = await aapi("/api/auth/users-public");
            showLogin(up.users || []);
          } catch (e) {
            $("#setupPanel").hidden = true;
            $("#loginPanel").hidden = false;
            $("#loginEmpty").hidden = false;
            $("#loginEmpty").textContent = "Cannot reach server: " + e.message;
            showOverlay();
          }
          draw();
        })();
      })();
