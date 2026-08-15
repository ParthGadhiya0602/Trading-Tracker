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
