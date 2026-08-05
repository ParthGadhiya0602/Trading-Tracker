      (function () {
        "use strict";
        const $ = (s) => document.querySelector(s);
        const APP_AUTH = (window.APP_AUTH = { user: null });
        let appStarted = false;
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
          host.innerHTML = "";
          users.forEach((u) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "up-item";
            b.innerHTML =
              `<span class="up-avatar">${(u.username[0] || "?").toUpperCase()}</span>` +
              `<span>${u.username}</span><span class="up-role">${u.role}</span>`;
            b.onclick = () => pickUser(u);
            host.appendChild(b);
          });
          showOverlay();
        }
        function pickUser(u) {
          picked = u;
          $("#userPicker").hidden = true;
          $("#pwForm").hidden = false;
          $("#pickedUser").textContent = "Signing in as " + u.username;
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
        }
        function onAuthed(user) {
          picked = null;
          $("#userPicker").replaceChildren();
          APP_AUTH.user = user;
          hideOverlay();
          chrome(user);
          document.body.classList.toggle(
            "role-viewer",
            user.role !== "editor",
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
          } else {
            window.__reloadAlerts && window.__reloadAlerts();
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
          location.reload(); // simplest clean reset of all app state
        };
        // any protected call returning 401 (session expired) -> back to login
        window.__onAuthExpired = () => {
          if (APP_AUTH.user) {
            APP_AUTH.user = null;
            location.reload();
          }
        };

        // ----- admin: user access workspace -----
        const ROLE_INFO = {
          admin: {
            icon: "shield-check",
            title: "Admin",
            copy: "Can view market data and alerts, and manage user accounts.",
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
        const activeUser = () => umUsers.find((user) => user.id === umEditId) || null;
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
          $("#um-cancel").hidden = true;
          $("#um-user").value = "";
          $("#um-pw").value = "";
          $("#um-pw").required = true;
          $("#um-pw-label").textContent = "Password";
          $("#um-pw-help").textContent = "Use at least 6 characters.";
          $("#um-role").value = "viewer";
          $("#um-access").hidden = true;
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
          if (focus) {
            $("#um-user").focus();
            if (matchMedia("(max-width: 880px)").matches)
              $(".um-editor").scrollIntoView({ behavior: "smooth", block: "start" });
          }
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
            rows +=
                `<tr${selected ? ' class="selected"' : ""}>` +
                `<td><div class="um-user-cell"><span class="um-avatar" aria-hidden="true">${initials(user.username)}</span>` +
                `<span class="um-identity"><span class="um-name">${esc(user.username)}</span><span class="um-role-mobile">${esc(user.role)}</span></span></div></td>` +
                `<td><span class="um-role ${esc(user.role)}">${esc(user.role)}</span></td>` +
                `<td><span class="um-state${user.disabled ? " disabled" : ""}">${user.disabled ? "Disabled" : "Enabled"}</span></td>` +
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
            host.innerHTML = '<tr class="um-loading"><td colspan="6">Loading accounts…</td></tr>';
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
            host.innerHTML = `<tr class="um-loading"><td colspan="6">Could not load users. ${esc(error.message)}</td></tr>`;
            $("#um-err").textContent = `${error.message}. Retry by reopening the Users tab.`;
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
          clearUserMessages();
          $("#um-success").textContent = success;
          roleGuide(user.role);
          setDeleteArmed(false);
          renderUsers();
          draw();
          if (focus) {
            $("#um-user").focus();
            if (matchMedia("(max-width: 880px)").matches)
              $(".um-editor").scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
        function setUserBusy(busy) {
          ["#um-user", "#um-pw", "#um-role", "#um-save", "#um-cancel", "#um-toggle", "#um-delete"].forEach(
            (selector) => {
              const element = $(selector);
              if (element) element.disabled = busy;
            },
          );
          $("#um-form").setAttribute("aria-busy", String(busy));
          if (busy) $("#um-save-label").textContent = umEditId ? "Saving…" : "Adding…";
        }
        $("#um-new").onclick = () => umResetForm({ focus: true });
        $("#um-cancel").onclick = () => umResetForm({ focus: true });
        $("#um-list").addEventListener("click", (event) => {
          const button = event.target.closest(".um-edit");
          if (!button) return;
          const user = umUsers.find((item) => item.id === button.dataset.userId);
          if (user) umEdit(user, true);
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
            umResetForm({ success: `${user.username} was deleted.` });
            await loadUsers({ selectedId: null });
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
            if (editingId) {
              await loadUsers({ selectedId: result.user.id, announce: "Changes saved." });
            } else {
              umResetForm({ success: `${result.user.username} was added.` });
              await loadUsers({ selectedId: null });
            }
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
