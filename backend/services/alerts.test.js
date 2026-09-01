"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const alerts = require("./alerts");

function definition(overrides = {}) {
  return {
    index: "NIFTY 50",
    symbol: "TCS",
    side: "BUY",
    alertPrice: 110,
    stopLoss: 100,
    timeframe: "5m",
    zoneCreator: "creator",
    note: "updated definition",
    candleDate: "2026-08-12",
    candleTime: "09:15",
    ...overrides,
  };
}

test("editing an entered alert preserves lifecycle and metadata", () => {
  const lastEvent = { id: "event-1", type: "PARTIAL", at: "2026-08-12T10:00:00.000Z" };
  const alert = {
    id: "alert-1",
    entered: true,
    status: "active",
    peak: 108,
    firedCount: 4,
    ringing: true,
    snoozed: true,
    reanchorChecked: true,
    reviewState: "approved",
    reviewer: "reviewer",
    reviewerUserId: "reviewer-1",
    reviewerRole: "editor",
    reviewReason: "valid",
    reviewedAt: "2026-08-12T09:10:00.000Z",
    zoneOutcome: "partial",
    lastEvent,
    lastFiredAt: "2026-08-12T10:00:00.000Z",
    createdAt: "2026-08-12T09:00:00.000Z",
    createdByUserId: "creator-1",
    createdByUsername: "creator",
    createdByRole: "editor",
  };
  const preserved = {
    entered: alert.entered,
    status: alert.status,
    peak: alert.peak,
    firedCount: alert.firedCount,
    ringing: alert.ringing,
    snoozed: alert.snoozed,
    reanchorChecked: alert.reanchorChecked,
    reviewState: alert.reviewState,
    reviewer: alert.reviewer,
    reviewerUserId: alert.reviewerUserId,
    reviewerRole: alert.reviewerRole,
    reviewReason: alert.reviewReason,
    reviewedAt: alert.reviewedAt,
    zoneOutcome: alert.zoneOutcome,
    lastEvent: alert.lastEvent,
    lastFiredAt: alert.lastFiredAt,
    createdAt: alert.createdAt,
    createdByUserId: alert.createdByUserId,
    createdByUsername: alert.createdByUsername,
    createdByRole: alert.createdByRole,
  };

  assert.equal(alerts._test.applyDefinitionUpdate(alert, definition()), true);
  assert.deepEqual(
    {
      entered: alert.entered,
      status: alert.status,
      peak: alert.peak,
      firedCount: alert.firedCount,
      ringing: alert.ringing,
      snoozed: alert.snoozed,
      reanchorChecked: alert.reanchorChecked,
      reviewState: alert.reviewState,
      reviewer: alert.reviewer,
      reviewerUserId: alert.reviewerUserId,
      reviewerRole: alert.reviewerRole,
      reviewReason: alert.reviewReason,
      reviewedAt: alert.reviewedAt,
      zoneOutcome: alert.zoneOutcome,
      lastEvent: alert.lastEvent,
      lastFiredAt: alert.lastFiredAt,
      createdAt: alert.createdAt,
      createdByUserId: alert.createdByUserId,
      createdByUsername: alert.createdByUsername,
      createdByRole: alert.createdByRole,
    },
    preserved,
  );
  assert.equal(alert.alertPrice, 110);
  assert.equal(alert.stopLoss, 100);
  assert.equal(alert.riskR, 10);
  assert.equal(alert.target3, 140);
  assert.equal(alert.target5, 160);
  assert.equal(alert.profit3, 30);
  assert.equal(alert.profit5, 50);
  assert.equal(alert.triggerPrice, 111.65);
});

test("cross-user edit notice is creator-only and does not enter the outbox", () => {
  alerts._test.resetTransientNotifications();
  const before = alerts.syncStatus().pending;
  const alert = {
    id: "alert-2",
    symbol: "INFY",
    index: "NIFTY 50",
    side: "BUY",
    version: 4,
    createdByUserId: "creator-1",
  };
  const actor = { id: "admin-1", username: "admin", role: "admin" };

  const receipt = alerts._test.createTransientEditNotification(alert, actor);

  assert.equal(receipt.transient, true);
  assert.equal(alerts.listNotifications("creator-1").length, 1);
  assert.equal(alerts.listNotifications("someone-else").length, 0);
  assert.equal(alerts.syncStatus().pending, before);
  assert.equal(
    alerts._test.createTransientEditNotification(alert, { ...actor, id: "creator-1" }),
    null,
  );
  alerts._test.resetTransientNotifications();
});

test("accepts a stock-futures alert only with an exact ISO expiry", () => {
  const valid = alerts._test.validate(
    definition({
      market: "stock-future",
      index: "STOCK FUTURES",
      symbol: "RELIANCE",
      contractExpiry: "2026-09-24",
    }),
  );
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.clean.market, "stock-future");
  assert.equal(valid.clean.contractExpiry, "2026-09-24");

  const invalid = alerts._test.validate(
    definition({
      market: "stock-future",
      index: "STOCK FUTURES",
      contractExpiry: "24-Sep-2026",
    }),
  );
  assert.match(invalid.errors.join("; "), /contract expiry/);
});

test("accepts an index-futures alert only for the index-futures group", () => {
  const valid = alerts._test.validate(
    definition({
      market: "index-future",
      index: "INDEX FUTURES",
      symbol: "NIFTY",
      contractExpiry: "2026-09-24",
    }),
  );
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.clean.market, "index-future");

  const invalid = alerts._test.validate(
    definition({
      market: "index-future",
      index: "STOCK FUTURES",
      symbol: "NIFTY",
      contractExpiry: "2026-09-24",
    }),
  );
  assert.match(invalid.errors.join("; "), /INDEX FUTURES/);
});

test("accepts an exact option contract and rejects a missing option side", () => {
  const valid = alerts._test.validate(
    definition({
      market: "index-option",
      index: "INDEX OPTIONS",
      symbol: "NIFTY",
      contractExpiry: "2026-09-24",
      strike: 25000,
      optionType: "CE",
    }),
  );
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.clean.strike, 25000);
  assert.equal(valid.clean.optionType, "CE");

  const invalid = alerts._test.validate(
    definition({
      market: "stock-option",
      index: "STOCK OPTIONS",
      contractExpiry: "2026-09-24",
      strike: 1450,
      optionType: "",
    }),
  );
  assert.match(invalid.errors.join("; "), /option type/);
});
