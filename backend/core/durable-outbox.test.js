"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DurableOutbox } = require("./durable-outbox");

test("persists operations and coalesces materialized state by key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-outbox-"));
  const file = path.join(dir, "outbox.json");
  const outbox = new DurableOutbox(file);
  outbox.enqueue("UPSERT", { version: 1 }, { dedupeKey: "alert:a" });
  outbox.enqueue("UPSERT", { version: 2 }, { dedupeKey: "alert:a" });
  const reloaded = new DurableOutbox(file);
  assert.equal(reloaded.status().pending, 1);
  assert.equal(reloaded.operations[0].payload.version, 2);
});

test("replays operations in order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-outbox-"));
  const outbox = new DurableOutbox(path.join(dir, "outbox.json"));
  outbox.enqueue("ONE", { value: 1 });
  outbox.enqueue("TWO", { value: 2 });
  const seen = [];
  outbox.processor = async (operation) => seen.push(operation.type);
  await outbox.drain();
  assert.deepEqual(seen, ["ONE", "TWO"]);
  assert.equal(outbox.status().pending, 0);
});
