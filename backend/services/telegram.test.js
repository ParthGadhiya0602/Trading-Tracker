"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLinkCommand } = require("./telegram");

test("parses direct and bot-addressed Telegram link commands", () => {
  assert.equal(parseLinkCommand("/link ABC123"), "ABC123");
  assert.equal(parseLinkCommand(" /link@tracker_bot CODE-9 "), "CODE-9");
  assert.equal(parseLinkCommand("/start ABC123"), "ABC123");
  assert.equal(parseLinkCommand("/start@tracker_bot CODE_9"), "CODE_9");
  assert.equal(parseLinkCommand("/link"), null);
  assert.equal(parseLinkCommand("/start"), null);
  assert.equal(parseLinkCommand("/link invalid.code"), null);
});
