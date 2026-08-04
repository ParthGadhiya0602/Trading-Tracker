# Trading Tracker - NIFTY 50 / NIFTY NEXT 50 Dashboard

A tiny, zero-dependency dashboard that tracks every **NIFTY 50** and **NIFTY NEXT 50**
stock's intraday movement **relative to its open price**, plus each index's own live
points level.

![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen) ![deps](https://img.shields.io/badge/dependencies-0-blue)

## What it does

- **Four indices** - NIFTY 50, NIFTY NEXT 50, NIFTY MIDCAP 50, NIFTY MIDCAP 100 (tabs,
  all constituents including MIDCAP 100's full 100).
- **Index headline cards** - live points for each index with ± points, % change,
  Open / High / Low / Prev Close, plus **52-week High/Low and 1-year %** (all shown).
- **Per-stock table** for the selected index with LTP, Open, High, Low, Prev Close,
  **Change** (₹ and %), and **Volume**. Hover a symbol for Open→High/Low %; **click any
  row for a detail panel** - company name, O/H/L, Open→High/Low %, **52-week High/Low +
  % from 52W high**, **Turnover**, Volume, and **30-day & 1-year % change**. The panel's
  **Add alert** button opens the create-alert modal prefilled with that index + stock.
- **Row colouring** - red when Open = High (never traded above its open today),
  green when Open = Low (never traded below), neutral otherwise. Filter tabs:
  All / Open = High / Open = Low / Neutral.
- **Every column sortable** ascending/descending with a direction indicator.
- **Search box** filters the selected index's table by symbol or company name (works
  alongside the filter tabs).
- **Market-hours aware** - auto-polls only during IST trading (Mon–Fri
  09:15–15:30); pauses and shows _Market CLOSED_ otherwise. Manual **Refresh now**
  always works.
- **Configurable** auto-poll interval (1–10 s) and clock format (12h / 24h IST).
- **In-memory cache** - a transient fetch failure keeps the last good data on screen
  with a "stale" indicator instead of blanking the table.
- **Responsive** - fills the screen on laptops/desktops (only the table scrolls);
  normal page scroll on phones. Light/dark follows your system theme.

## Why there's a server

The data source's API can't be called directly from a browser: CORS forbids the required
headers, and its anti-bot layer blocks any request without a _warm session_ (cookies +
browser-like headers). So a tiny local Node server warms a session and re-serves the data
to the page from the **same origin** - no CORS, no public proxy, live data.

`server.js` has **zero npm dependencies** (built-in `fetch` + a hand-rolled cookie jar).
The data-source endpoints live in `config.json`'s `feed` block (copy `config.example.json`
→ `config.json` and fill them in) — they're not shipped in the code.

## Requirements

- **Node.js 18+** (needs the built-in `fetch`). Check with `node --version`.
- A `config.json` with the `feed` endpoints filled in (see `config.example.json`).
- A network the data source will answer - home/office broadband is fine. VPNs and
  datacentre IPs are often blocked (you'll see HTTP 401/403).

## How to use

```bash
node backend/server.js
```

Then open **http://localhost:8787/** in your browser.

On startup the server runs a self-test and prints whether it reached the data source, e.g.:

```
[NIFTY 50] level 24334.3 (+261.55, +1.09%)
OK [NIFTY 50] - got 50 constituents (stamp: ...)
```

To use a different port:

```bash
PORT=9000 node backend/server.js     # then open http://localhost:9000/
```

Stop the server with **Ctrl-C**.

> Live data flows only during market hours (Mon–Fri 09:15–15:30 IST). Outside those
> hours the index cards still show the last close, but the constituents table will be
> empty until the market opens - this is expected.

## Data source

The upstream endpoints aren't shipped in the repo — the base host, index endpoint,
referer, and warmup paths live in `config.json`'s **`feed`** block (copy
`config.example.json` → `config.json` and fill them in). One call per index returns the
index **level** + **all** constituents (full 100 for MIDCAP 100) with
Open/High/Low/LTP/Prev/Change/Volume/Turnover/52-week, advance-decline, and market status.
The server serves the merged-by-index result at `/api/indices`.

## Alerts

Switch to the **Alerts** view (header toggle) to set price alerts per index. They are
evaluated **on the server** during market hours, so they fire **even with no browser
tab open**.

Click **New alert** (or a row's **Edit**) to open the create/edit **modal**. Create an
alert with (all required): **Index**, **Stock** (searchable), **Side**
(Buy/Sell), **Alert price**, **Stop loss**, **Note**, **Zone creator**, and **Time
frame** (1s…12mo). **Candle date & time are optional** - recorded with the alert (shown
in the notification) but they don't affect firing. The trigger preview only appears once
side + alert price + time frame are chosen.

**The alert price is your entry; the trigger is offset% away, and re-alerts step back
toward it.** BUY trigger = alert price **+ offset%** (above); SELL trigger = alert price
**− offset%** (below). The **offset % depends on the time frame** — anchored at **2h =
10%**, scaling down for shorter frames (1m = 0.5%, 15m = 3%, 1h = 7%) and up for longer
(1d = 20%). The re-alert step is **0.5% for 1m–15m**, else offset ÷ 5.

**Lifecycle: `armed → triggered → active → closed`.** How it fires (Buy, alert ₹1,000,
**15m** → +3% → trigger ₹1,030):

- **Trigger** when price rises to ₹1,030 (a Sell triggers when it falls to its trigger below).
- **Re-alert** every step% as price moves **back toward your alert price**.
- **Entry** (🎯) when the price **touches your alert price** (₹1,000) — the alert becomes
  **active**. This is the gate: **targets and stop-loss are only tracked after entry**, so a
  price that's already near a target when you create the alert can't fire a false Partial.
- **Re-anchor**: if the live price is already **between** your alert price and the trigger
  at creation, the trigger is set to the **current price**.

**Profit targets & zone outcome** (tracked **only after entry**). From R = |alert − stop
loss|, it computes **3× and 5× targets** (profit = 3R / 5R). Live: **Partial** at 3×,
**Success** at 5×, **Fail** if the stop loss is hit first. **Success and Fail auto-close**
the alert (no manual step); if it hits **3× then the stop loss**, it closes but **keeps the
Partial** result. Entry/Partial/Success/Fail are quiet notifications; only Trigger/Re-alert
ring with **Snooze / Close**. If the price is already past your entry when you create an
alert, the form asks you to confirm (it'll start already-entered).

Every fire also lands in the **notification center** (bell icon in the top bar) with
read/unread state; it persists until you snooze/close/dismiss. Closed alerts move to an
**archive** — the alerts list shows active alerts by default, with a **Show archived**
toggle to review past ones. Each alert records **Created / Updated / Last fired** metadata
(in its detail modal, opened by clicking a row).

Every alert carries a **zone-verification flag** (starts _Unverified_). Someone reviews the
zone and clicks **Verify** (or **Unverify** to revert). The list shows **all indices
together** (each row tagged with its index — no index tabs); filter it with **multi-select**
dropdowns — **index**, **status**, **side**, **time frame**, **zone-verified**, **outcome** —
pick any combination; active selections appear as removable **chips** (with Clear all).

The **index list and stock list are dynamic** - alerts cover every dashboard index
automatically, and each index's stock list is refreshed from the data source on every
market tick (so it stays current each trading day). Add an index to `alerts.INDICES` and
it appears in both the dashboard and the alert picker.

### Telegram (optional)

Notifications reach you with no tab open. Create `config.json` at the repo root:

```json
{
  "telegram": {
    "botToken": "123456:ABC...",
    "recipients": [
      { "chatId": "11111111", "label": "Me" },
      { "chatId": "22222222", "label": "Partner" }
    ]
  }
}
```

Fires to every recipient. Without this file, alerts are **in-page only**. Get a token
from **@BotFather**; each recipient messages the bot once, then look up their `chatId`
via `https://api.telegram.org/bot<token>/getUpdates`.

## Alert storage (local file or MongoDB Atlas)

By default alerts persist to **`alerts.json`** (local, no setup). To share alerts **across
devices**, point it at **MongoDB Atlas**: `npm install`, then add a `mongo.uri` to
`config.json`:

```json
{ "mongo": { "uri": "mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/trading_tracker" } }
```

It uses a proper schema — **one document per alert** in an `alerts` collection (`_id` =
the alert id), closed alerts in an **`archived_alerts`** collection (moved on close, so the
active list stays small), plus a small `meta` doc for the symbol cache. It **always also
writes `alerts.json`** as an offline cache and **automatically falls back** to the file if
Atlas is unreachable, so the app never blanks. The startup log shows `store: mongo` or
`store: file`. Any write/connection/Telegram failures are logged (dated, IST) to
**`logs/alerts-errors.log`**.

Set **`ALERTS_NO_TICK=1`** to run the server without evaluating alerts (serves the UI +
APIs only — no fires, no Telegram, no writes); handy for local inspection.

## Files

```
backend/   server.js  · alerts.js · auth.js · config.example.json
frontend/  index.html · css/{base,components,dashboard,alerts,auth}.css
           js/{main,dashboard,alerts-ui,auth-ui}.js
root       package.json · package-lock.json   +  (gitignored) config.json · alerts.json · users.json · logs/
```

- `backend/server.js` - zero-dependency Node proxy: warms the session, serves `frontend/`
  statically, gates `/api/*` behind auth, runs the alert eval loop. Run: `node backend/server.js`.
- `backend/alerts.js` - alert engine, storage (Atlas or `alerts.json`), Telegram sender.
- `backend/auth.js` - user accounts (scrypt), sessions, roles (admin/editor/viewer).
- `frontend/index.html` - markup only; loads `css/*` and `js/main.js` (native ES modules,
  no build step). `js/`: `main` (entry) + `dashboard`, `alerts-ui`, `auth-ui`.
- `package.json` (root) - only the optional `mongodb` driver (needed just for Atlas).
- `config.json` (root, gitignored) - `feed` endpoints, `mongo.uri`, `telegram` recipients.

## Notes / limitations

- Data is **unofficial** (scraped from a public market site) - for personal/informational
  use, not trading decisions.
- Intended to run **locally**. Hosting the live proxy on the free cloud tiers is
  unreliable because the data source tends to block datacentre IPs.
