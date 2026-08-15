"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const authSingleton = require("./auth");
const { AuthService } = authSingleton;

const PEPPER = "x".repeat(40); // >= 32 chars
function svc() {
  const a = new AuthService();
  a.passwordPepper = PEPPER; // avoid #loadConfig()/env; no disk writes below
  return a;
}

test("singleton export is an AuthService, drop-in API + ROLES/PW_MIN attached", () => {
  assert.ok(authSingleton instanceof AuthService);
  assert.deepStrictEqual(authSingleton.ROLES, ["admin", "editor", "viewer"]);
  assert.strictEqual(authSingleton.PW_MIN, 6);
  for (const m of ["load","login","logout","sessionUser","createUser","updateUser","deleteUser",
                   "listUsers","pickerUsers","needsSetup","setupAdmin","telegramRecipients",
                   "consumeTelegramLinkCode","markTelegramUnreachable","hashPassword","verifyPassword"])
    assert.strictEqual(typeof authSingleton[m], "function", `missing ${m}`);
});

test("hashPassword + verifyPassword round-trip", () => {
  const a = svc();
  const { salt, hash } = a.hashPassword("hunter2");
  assert.ok(salt && hash);
  assert.strictEqual(a.verifyPassword("hunter2", salt, hash), true);
  assert.strictEqual(a.verifyPassword("wrong", salt, hash), false);
});

test("hashPassword throws without a pepper", () => {
  const a = new AuthService(); // no pepper
  assert.throws(() => a.hashPassword("x"), /passwordPepper is required/);
});

test("verifyPassword false on missing inputs / bad pepper", () => {
  const a = svc();
  const { salt, hash } = a.hashPassword("pw");
  assert.strictEqual(a.verifyPassword("pw", salt, hash, "other-pepper"), false);
  assert.strictEqual(a.verifyPassword("pw", null, hash), false);
});

test("needsSetup true when empty, false when seeded", () => {
  const a = svc();
  assert.strictEqual(a.needsSetup(), true);
  a.store.users = [{ id: "1", username: "admin", role: "admin" }];
  assert.strictEqual(a.needsSetup(), false);
});

test("createUser validation early-returns (no save/disk touch)", () => {
  const a = svc();
  assert.ok(a.createUser({ username: "a", password: "hunter2", role: "admin" }, null).error); // too short username
  assert.ok(a.createUser({ username: "alice", password: "123", role: "admin" }, null).error); // short pw
  assert.ok(a.createUser({ username: "alice", password: "hunter2", role: "boss" }, null).error); // bad role
  // duplicate name (seed store, still hits validation return before save)
  a.store.users = [{ id: "1", username: "alice", role: "admin" }];
  assert.ok(a.createUser({ username: "ALICE", password: "hunter2", role: "editor" }, null).error);
});

test("listUsers / pickerUsers never leak salt+hash", () => {
  const a = svc();
  a.store.users = [
    { id: "1", username: "admin", role: "admin", salt: "s", hash: "h", disabled: false },
    { id: "2", username: "bob", role: "viewer", salt: "s", hash: "h", disabled: true },
  ];
  const pubs = a.listUsers();
  assert.strictEqual(pubs.length, 2);
  assert.strictEqual(pubs[0].salt, undefined);
  assert.strictEqual(pubs[0].hash, undefined);
  assert.deepStrictEqual(a.pickerUsers(), [{ username: "admin" }]); // disabled bob excluded
});

test("telegramRecipients only enabled+verified+reachable", () => {
  const a = svc();
  a.store.users = [
    { id: "1", username: "on", telegram: { chatId: "111", verifiedAt: "t", enabled: true, reachable: true } },
    { id: "2", username: "off", telegram: { chatId: "222", verifiedAt: "t", enabled: false, reachable: true } },
    { id: "3", username: "unreach", telegram: { chatId: "333", verifiedAt: "t", enabled: true, reachable: false } },
    { id: "4", username: "nolink" },
  ];
  const r = a.telegramRecipients();
  assert.deepStrictEqual(r.map((x) => x.username), ["on"]);
  assert.strictEqual(r[0].chatId, "111");
});

test("login rate-limit locks after repeated fails (no save on failure)", () => {
  const a = svc();
  a.store.users = []; // unknown user -> always fails
  for (let i = 0; i < 5; i++) assert.ok(a.login("ghost", "x").error);
  const res = a.login("ghost", "x");
  assert.match(res.error, /too many attempts/);
});

test("sessionUser null for missing/unknown token; logout ok", () => {
  const a = svc();
  assert.strictEqual(a.sessionUser(null), null);
  assert.strictEqual(a.sessionUser("nope"), null);
  assert.deepStrictEqual(a.logout("nope"), { ok: true });
});
