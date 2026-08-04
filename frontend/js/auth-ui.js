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
          $("#usersBtn").hidden = user.role !== "admin";
        }
        function onAuthed(user) {
          APP_AUTH.user = user;
          hideOverlay();
          chrome(user);
          document.body.classList.toggle(
            "role-viewer",
            !(user.role === "admin" || user.role === "editor"),
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

        // ----- admin: users management modal -----
        const um = $("#usersModal");
        let umEditId = null;
        const openUsers = () => {
          um.classList.add("show");
          umResetForm();
          loadUsers();
          draw();
        };
        const closeUsers = () => um.classList.remove("show");
        $("#usersBtn").onclick = openUsers;
        $("#um-close").onclick = closeUsers;
        $("#um-backdrop").onclick = closeUsers;
        $("#um-cancel").onclick = () => umResetForm();
        function umResetForm() {
          umEditId = null;
          $("#um-form-title").textContent = "Add user";
          $("#um-save").textContent = "Add user";
          $("#um-cancel").hidden = true;
          $("#um-user").value = "";
          $("#um-pw").value = "";
          $("#um-pw").placeholder = "Password (min 6)";
          $("#um-role").value = "viewer";
          $("#um-err").textContent = "";
        }
        async function loadUsers() {
          const host = $("#um-list");
          let data;
          try {
            data = await aapi("/api/users");
          } catch (e) {
            host.innerHTML = `<div class="auth-err" style="padding:12px">${e.message}</div>`;
            return;
          }
          host.innerHTML = "";
          data.users.forEach((u) => {
            const row = document.createElement("div");
            row.className = "um-row";
            row.innerHTML =
              `<span class="um-name">${u.username}</span>` +
              `<span class="um-role ${u.role}">${u.role}</span>` +
              (u.disabled ? `<span class="um-disabled">disabled</span>` : "") +
              `<span class="um-spacer"></span>`;
            const mk = (label, cls, fn) => {
              const b = document.createElement("button");
              b.type = "button";
              b.className = cls;
              b.textContent = label;
              b.onclick = fn;
              return b;
            };
            row.appendChild(mk("Edit", "btn-sm", () => umEdit(u)));
            row.appendChild(
              mk(u.disabled ? "Enable" : "Disable", "btn-sm", async () => {
                try {
                  await aapi("/api/users/" + u.id, "PATCH", { disabled: !u.disabled });
                  loadUsers();
                } catch (e) {
                  $("#um-err").textContent = e.message;
                }
              }),
            );
            row.appendChild(
              mk("Delete", "btn-sm danger", async () => {
                if (!confirm("Delete user " + u.username + "?")) return;
                try {
                  await aapi("/api/users/" + u.id, "DELETE");
                  loadUsers();
                } catch (e) {
                  $("#um-err").textContent = e.message;
                }
              }),
            );
            host.appendChild(row);
          });
          draw();
        }
        function umEdit(u) {
          umEditId = u.id;
          $("#um-form-title").textContent = "Edit " + u.username;
          $("#um-save").textContent = "Save changes";
          $("#um-cancel").hidden = false;
          $("#um-user").value = u.username;
          $("#um-pw").value = "";
          $("#um-pw").placeholder = "New password (blank = keep)";
          $("#um-role").value = u.role;
          $("#um-err").textContent = "";
        }
        $("#um-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          $("#um-err").textContent = "";
          const username = $("#um-user").value.trim(),
            pw = $("#um-pw").value,
            role = $("#um-role").value;
          try {
            if (umEditId) {
              const patch = { username, role };
              if (pw) patch.password = pw;
              await aapi("/api/users/" + umEditId, "PATCH", patch);
            } else {
              await aapi("/api/users", "POST", { username, password: pw, role });
            }
            umResetForm();
            loadUsers();
          } catch (err) {
            $("#um-err").textContent = err.message;
          }
        });

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
