// Inspect one symbol's alert(s) + their event timeline, to explain why entry/target
// notifications did or didn't fire.
//   node --env-file=.env scripts/inspect-alert.mjs HINDUNILVR
// Reads MONGO_URI from env (never printed). Read-only.
import { MongoClient } from "mongodb";

const symbol = (process.argv[2] || "").trim().toUpperCase();
if (!symbol) { console.error("usage: node --env-file=.env scripts/inspect-alert.mjs <SYMBOL>"); process.exit(1); }
const uri = process.env.MONGO_URI;
if (!uri) { console.error("MONGO_URI not set (run with --env-file=.env)"); process.exit(1); }

const dbName = (uri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] || "trading_tracker";
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const db = client.db(dbName);
  const active = await db.collection("alerts").find({ symbol }).toArray();
  const archived = await db.collection("archived_alerts").find({ symbol }).toArray();
  const alerts = [...active.map((a) => ({ ...a, _bucket: "active" })), ...archived.map((a) => ({ ...a, _bucket: "archived" }))];
  if (!alerts.length) { console.log(`No alert found for ${symbol}.`); process.exit(0); }

  for (const a of alerts) {
    console.log(`\n=== ${symbol} [${a._bucket}] id=${a._id || a.id} ===`);
    console.log({
      side: a.side, status: a.status, reviewState: a.reviewState, reviewer: a.reviewer,
      entered: a.entered, zoneOutcome: a.zoneOutcome,
      alertPrice: a.alertPrice, stopLoss: a.stopLoss, target3: a.target3, target5: a.target5,
      createdAt: a.createdAt, updatedAt: a.updatedAt, lastFiredAt: a.lastFiredAt, firedCount: a.firedCount,
    });
    const id = a._id || a.id;
    const events = await db.collection("alert_events").find({ alertId: id }).sort({ at: 1 }).toArray();
    console.log(`events (${events.length}):`);
    for (const e of events) console.log(`  ${e.at}  ${e.type}  @${e.price}`);
    // verdict hints
    if (a.reviewState !== "approved") console.log(`  >> reviewState is "${a.reviewState}" — evaluate() SKIPS non-approved alerts, so no entry/target ever fired.`);
    else if (!events.some((e) => e.type === "ENTRY")) console.log(`  >> approved but no ENTRY event — likely created already-past-entry (silent), or the server wasn't evaluating during market hours on those days.`);
    else console.log(`  >> approved with events — ENTRY/PARTIAL/SUCCESS are SILENT (notification center + Telegram, no ring). Check the bell.`);
  }
} catch (e) {
  console.error("Mongo error:", e.message);
  process.exit(2);
} finally {
  await client.close();
}
