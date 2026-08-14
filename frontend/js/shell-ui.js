// Mobile hamburger nav toggle (<820px). Reveals the .viewnav dropdown via a
// body.nav-open class; closes on nav choice, outside click, Esc, or resize to
// desktop. Desktop (>=820) shows the nav as the sidebar rail and hides the
// toggle via CSS, so this is inert there. Self-contained IIFE.
(function () {
  "use strict";
  const toggle = document.getElementById("navToggle");
  if (!toggle) return;
  const body = document.body;

  function close() {
    body.classList.remove("nav-open");
    toggle.setAttribute("aria-expanded", "false");
  }
  function open() {
    body.classList.add("nav-open");
    toggle.setAttribute("aria-expanded", "true");
  }

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    body.classList.contains("nav-open") ? close() : open();
  });

  // choosing a view closes the menu
  document.querySelectorAll(".viewnav .tab").forEach((t) => t.addEventListener("click", close));

  // click outside the menu/toggle closes it
  document.addEventListener("click", (e) => {
    if (!body.classList.contains("nav-open")) return;
    if (e.target.closest(".viewnav") || e.target.closest("#navToggle")) return;
    close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // resizing up to the desktop rail hides the dropdown state
  window.addEventListener("resize", () => {
    if (window.innerWidth >= 820) close();
  });
})();
