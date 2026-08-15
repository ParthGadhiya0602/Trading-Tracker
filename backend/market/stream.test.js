"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const streamSingleton = require("./stream");
const { StreamClient } = streamSingleton;

test("singleton export is a StreamClient with start/stop (drop-in)", () => {
  assert.ok(streamSingleton instanceof StreamClient);
  assert.strictEqual(typeof streamSingleton.start, "function");
  assert.strictEqual(typeof streamSingleton.stop, "function");
});

test("start() with no feed.stream connects nothing but marks running", () => {
  const s = new StreamClient();
  s.start({ feed: {}, onTick() {}, isOpen: () => true, log() {}, userAgent: "x" });
  assert.strictEqual(s.running, true);
  assert.deepStrictEqual(s.sockets, []);
  s.stop();
});

test("start() defaults isOpen to false when not a function", () => {
  const s = new StreamClient();
  s.start({ feed: {} });
  assert.strictEqual(typeof s.opts.isOpen, "function");
  assert.strictEqual(s.opts.isOpen(), false);
  s.stop();
});

test("stop() resets running + opts", () => {
  const s = new StreamClient();
  s.start({ feed: {}, isOpen: () => true });
  s.stop();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.opts, null);
  assert.deepStrictEqual(s.sockets, []);
});

test("start() twice restarts cleanly (no throw, no socket leak with empty feed)", () => {
  const s = new StreamClient();
  s.start({ feed: {}, isOpen: () => true });
  s.start({ feed: {}, isOpen: () => true });
  assert.strictEqual(s.running, true);
  assert.deepStrictEqual(s.sockets, []);
  s.stop();
});
