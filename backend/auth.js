"use strict";
/**
 * Auth + user management for the Trading Tracker portal (ZERO dependencies).
 *
 * - Users live in a `users` collection (MongoDB Atlas, if `mongo.uri` is set in
 *   config.json and reachable) or the local `users.json` file (offline cache / fallback).
 *   Mirrors alerts.js: in-memory `store` is the source of truth; save() writes through.
 * - Passwords are hashed with the built-in `crypto.scrypt`, a per-user random salt, and
 *   a required secret pepper from config.json. Hashes are verified with
 *   `timingSafeEqual`; plaintext passwords and the pepper are never stored with users.
 * - Sessions are random 256-bit tokens kept in memory (cleared on restart), 12h idle TTL.
 *
 * Roles: admin (manages users and alerts) | editor (manages alerts) |
 * viewer (read-only).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { connectMongoWithRetry } = require("./mongo-retry");
const { DurableOutbox } = require("./durable-outbox");
const { istNow, istFromMs, istLogTs } = require("./utils");

const ROOT = path.join(__dirname, ".."); // repo root (config lives here)
const STORE_DIR = path.join(ROOT, "store"); // alert + user data files live here
const STORE_FILE = path.join(STORE_DIR, "users.json");
const OUTBOX_FILE = path.join(STORE_DIR, "auth-outbox.json");
const CONFIG_FILE = path.join(ROOT, "config.json");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "alerts-errors.log");

const ROLES = ["admin", "editor", "viewer"];
const PW_MIN = 6;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h idle timeout
const RL_MAX_FAILS = 5; // failed logins before lockout
const RL_LOCK_MS = 60 * 1000; // lockout window
const SCRYPT_KEYLEN = 64;

let store = { users: [] };
let backend = "file"; // "file" | "mongo"
let usersColl = null;
let processedColl = null;
let mongoUri = "";
let reconnectTimer = null;
let passwordPepper = "";

const sessions = new Map(); // token -> { userId, role, username, lastSeen }
const fails = new Map(); // usernameLower -> { count, until, expiresAt }

function logError(scope, err) {
  const msg = err && err.message ? err.message : String(err == null ? "" : err);
  const line = `[${istLogTs()}] ERROR [${scope}] ${msg}`;
  console.error("  " + line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {}
}

const outbox = new DurableOutbox(OUTBOX_FILE, { logError });

// ---------- hashing ----------
function passwordMaterial(password, pepper) {
  return crypto
    .createHmac("sha256", pepper)
    .update(String(password), "utf8")
    .digest();
}
function hashPassword(password, salt, pepper = passwordPepper) {
  if (!pepper) throw new Error("auth.passwordPepper is required");
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(passwordMaterial(password, pepper), s, SCRYPT_KEYLEN)
    .toString("hex");
  return { salt: s, hash };
}
function verifyPassword(password, salt, hash, pepper = passwordPepper) {
  if (!salt || !hash || !pepper) return false;
  let derived;
  try {
    derived = crypto.scryptSync(passwordMaterial(password, pepper), salt, SCRYPT_KEYLEN);
  } catch (_) {
    return false;
  }
  const stored = Buffer.from(hash, "hex");
  return (
    derived.length === stored.length && crypto.timingSafeEqual(derived, stored)
  );
}

// ---------- persistence (mirrors alerts.js) ----------
function loadConfig() {
  passwordPepper = "";
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    throw new Error(`cannot read config.json: ${error.message}`);
  }
  const mongoUri =
    cfg && cfg.mongo && cfg.mongo.uri ? String(cfg.mongo.uri).trim() : "";
  const configuredPepper =
    cfg && cfg.auth && cfg.auth.passwordPepper
      ? String(cfg.auth.passwordPepper).trim()
      : "";
  if (configuredPepper.length < 32)
    throw new Error("auth.passwordPepper must contain at least 32 characters");
  passwordPepper = configuredPepper;
  return mongoUri;
}
function readFileStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { users: Array.isArray(raw.users) ? raw.users : [] };
  } catch (_) {
    return { users: [] };
  }
}
async function load() {
  mongoUri = loadConfig();
  let seedFromLocal = false;
  if (mongoUri) {
    try {
      const client = await connectMongoWithRetry(mongoUri, {
        retries: 1,
        retryDelayMs: 2000,
        serverSelectionTimeoutMS: 6000,
      });
      const dbName =
        (mongoUri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
        "trading_tracker";
      const db = client.db(dbName);
      configureMongo(db);
      await outbox.drain();
      await usersColl.createIndex(
        { "telegram.chatId": 1 },
        {
          unique: true,
          partialFilterExpression: { "telegram.chatId": { $type: "string" } },
        },
      );
      backend = "mongo";
      const docs = await usersColl.find({}).toArray();
      if (docs.length) {
        store = {
          users: docs.map((d) => {
            delete d._id;
            return d;
          }),
        };
      } else {
        // fresh DB: seed from local users.json if present, else empty (first-run setup)
        store = readFileStore();
        seedFromLocal = true;
        if (store.users.length)
          console.log(`  auth: seeded ${store.users.length} users from users.json`);
      }
    } catch (e) {
      logError("auth.mongo.connect", `${(e && e.message) || e} - using users.json`);
      usersColl = null;
      processedColl = null;
      outbox.setProcessor(null);
      backend = "file";
      store = readFileStore();
      seedFromLocal = true;
    }
  } else {
    backend = "file";
    store = readFileStore();
    seedFromLocal = true;
  }
  save({ queue: seedFromLocal });
  startReconnectWorker();
  return backend;
}
function backendName() {
  return backend;
}
function passwordPepperConfigured() {
  return !!passwordPepper;
}
function queueUser(user) {
  outbox.enqueue(
    "USER_PUT",
    { ...user },
    { dedupeKey: `user:${user.id}` },
  );
}
function queueUserDelete(user) {
  outbox.enqueue(
    "USER_DELETE",
    { id: user.id, at: istNow() },
    { dedupeKey: `user:${user.id}` },
  );
}
async function processOutbox(operation) {
  if (await processedColl.findOne({ _id: operation.operationId })) return;
  if (operation.type === "USER_PUT") {
    const user = operation.payload;
    await usersColl.replaceOne(
      { _id: user.id },
      { ...user, _id: user.id },
      { upsert: true },
    );
  } else if (operation.type === "USER_DELETE") {
    await usersColl.deleteOne({ _id: operation.payload.id });
  } else {
    throw new Error(`unknown auth outbox operation: ${operation.type}`);
  }
  await processedColl.updateOne(
    { _id: operation.operationId },
    {
      $setOnInsert: {
        type: operation.type,
        processedAt: istNow(),
      },
    },
    { upsert: true },
  );
}
function configureMongo(db) {
  usersColl = db.collection("users");
  processedColl = db.collection("processed_operations");
  outbox.setProcessor(processOutbox);
}
function save(options = {}) {
  if (options.queue !== false) for (const user of store.users) queueUser(user);
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    logError("auth.file.write", `users.json - ${e.message}`);
  }
  if (backend === "mongo") void outbox.drain();
}
async function reconnectMongo() {
  if (!mongoUri || backend === "mongo") return;
  try {
    const client = await connectMongoWithRetry(mongoUri, {
      retries: 0,
      serverSelectionTimeoutMS: 5000,
    });
    const dbName =
      (mongoUri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
      "trading_tracker";
    configureMongo(client.db(dbName));
    await usersColl.createIndex(
      { "telegram.chatId": 1 },
      {
        unique: true,
        partialFilterExpression: { "telegram.chatId": { $type: "string" } },
      },
    );
    backend = "mongo";
    await outbox.drain();
    console.log("  auth: MongoDB reconnected; durable outbox replayed");
  } catch (error) {
    backend = "file";
    outbox.setProcessor(null);
    logError("auth.mongo.reconnect", error);
  }
}
function startReconnectWorker() {
  if (!mongoUri || reconnectTimer) return;
  reconnectTimer = setInterval(() => void reconnectMongo(), 15_000);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

// ---------- helpers ----------
const norm = (u) => String(u || "").trim();
const lower = (u) => norm(u).toLowerCase();
function findByName(username) {
  const l = lower(username);
  return store.users.find((u) => lower(u.username) === l) || null;
}
function findById(id) {
  return store.users.find((u) => u.id === id) || null;
}
function enabledAdmins() {
  return store.users.filter((u) => u.role === "admin" && !u.disabled);
}
// public shape (never leak salt/hash)
function pub(u) {
  const linked = !!(u.telegram && u.telegram.chatId && u.telegram.verifiedAt);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt || null,
    telegram: {
      linked,
      enabled: linked && u.telegram.enabled !== false,
      reachable: linked && u.telegram.reachable !== false,
    },
  };
}

// ---------- Telegram account link state (private fields never leave this module) ----------
function linkCodeHash(code) {
  return crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
}
function createTelegramLinkCode(userId) {
  const user = findById(userId);
  if (!user) return { error: "not found" };
  const code = crypto.randomBytes(6).toString("base64url").toUpperCase();
  const expiresAt = istFromMs(Date.now() + 10 * 60_000);
  user.telegramLink = { codeHash: linkCodeHash(code), expiresAt };
  user.updatedAt = istNow();
  save();
  return { code, expiresAt };
}
function consumeTelegramLinkCode(code, telegramAccount) {
  const hash = linkCodeHash(String(code || "").trim().toUpperCase());
  const now = istNow();
  const user = store.users.find(
    (candidate) =>
      candidate.telegramLink &&
      candidate.telegramLink.expiresAt > now &&
      candidate.telegramLink.codeHash === hash,
  );
  if (!user) return { error: "invalid or expired link code" };
  const chatId = String(telegramAccount.chatId);
  const conflict = store.users.find(
    (candidate) =>
      candidate.id !== user.id &&
      candidate.telegram &&
      candidate.telegram.chatId === chatId,
  );
  if (conflict) return { error: "this Telegram chat is already linked" };
  const linkedAt = istNow();
  user.telegram = {
    chatId,
    telegramUserId: String(telegramAccount.telegramUserId || ""),
    telegramUsername: String(telegramAccount.telegramUsername || ""),
    linkedAt,
    verifiedAt: linkedAt,
    enabled: true,
    reachable: true,
    lastError: null,
  };
  delete user.telegramLink;
  user.updatedAt = linkedAt;
  save();
  return { user: pub(user), username: user.username };
}
function unlinkTelegram(userId) {
  const user = findById(userId);
  if (!user) return { error: "not found" };
  delete user.telegram;
  delete user.telegramLink;
  user.updatedAt = istNow();
  save();
  return { user: pub(user) };
}
function setTelegramEnabled(userId, enabled) {
  const user = findById(userId);
  if (!user) return { error: "not found" };
  if (!user.telegram || !user.telegram.verifiedAt)
    return { error: "Telegram is not linked" };
  user.telegram.enabled = !!enabled;
  user.updatedAt = istNow();
  save();
  return { user: pub(user) };
}
function telegramRecipients() {
  return store.users
    .filter(
      (user) =>
        !user.disabled &&
        user.telegram &&
        user.telegram.verifiedAt &&
        user.telegram.enabled !== false &&
        user.telegram.reachable !== false,
    )
    .map((user) => ({
      userId: user.id,
      username: user.username,
      chatId: String(user.telegram.chatId),
    }));
}
function markTelegramUnreachable(userId, error) {
  const user = findById(userId);
  if (!user || !user.telegram) return;
  user.telegram.reachable = false;
  user.telegram.enabled = false;
  user.telegram.lastError = String(error || "Telegram delivery failed");
  user.updatedAt = istNow();
  save();
}
function validateUsername(username) {
  const n = norm(username);
  if (!n) return "username is required";
  if (!/^[A-Za-z0-9_.\- ]{2,32}$/.test(n))
    return "username must be 2-32 chars (letters, numbers, . _ - space)";
  return null;
}
function validatePassword(pw) {
  if (String(pw || "").length < PW_MIN) return `password must be at least ${PW_MIN} characters`;
  return null;
}

// ---------- setup / user CRUD ----------
function needsSetup() {
  return store.users.length === 0;
}
function setupAdmin({ username, password }) {
  if (!needsSetup()) return { error: "setup already complete" };
  return createUser({ username, password, role: "admin" }, null);
}
function createUser({ username, password, role }, createdBy) {
  const ue = validateUsername(username);
  if (ue) return { error: ue };
  const pe = validatePassword(password);
  if (pe) return { error: pe };
  if (!ROLES.includes(role)) return { error: "invalid role" };
  if (findByName(username)) return { error: "username already exists" };
  const now = istNow();
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username: norm(username),
    role,
    salt,
    hash,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    createdBy: createdBy || null,
    lastLoginAt: null,
  };
  store.users.push(user);
  save();
  return { user: pub(user) };
}
function updateUser(id, input) {
  const u = findById(id);
  if (!u) return { error: "not found" };
  const patch = input || {};
  // rename
  if (patch.username !== undefined) {
    const ue = validateUsername(patch.username);
    if (ue) return { error: ue };
    const other = findByName(patch.username);
    if (other && other.id !== id) return { error: "username already exists" };
    u.username = norm(patch.username);
  }
  // role change - protect the last enabled admin
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) return { error: "invalid role" };
    if (u.role === "admin" && patch.role !== "admin" && enabledAdmins().length <= 1)
      return { error: "cannot demote the last admin" };
    u.role = patch.role;
  }
  // disable/enable - protect the last enabled admin
  if (patch.disabled !== undefined) {
    const willDisable = !!patch.disabled;
    if (willDisable && u.role === "admin" && enabledAdmins().length <= 1)
      return { error: "cannot disable the last admin" };
    u.disabled = willDisable;
  }
  // password reset
  if (patch.password !== undefined && patch.password !== "") {
    const pe = validatePassword(patch.password);
    if (pe) return { error: pe };
    const { salt, hash } = hashPassword(patch.password);
    u.salt = salt;
    u.hash = hash;
  }
  u.updatedAt = istNow();
  save();
  return { user: pub(u) };
}
function deleteUser(id) {
  const u = findById(id);
  if (!u) return { error: "not found" };
  if (u.role === "admin" && enabledAdmins().length <= 1)
    return { error: "cannot delete the last admin" };
  queueUserDelete(u);
  store.users = store.users.filter((x) => x.id !== id);
  save();
  return { ok: true };
}
function listUsers() {
  return store.users.map(pub);
}
// for the login picker: enabled users only, minimal fields
function pickerUsers() {
  return store.users.filter((u) => !u.disabled).map((u) => ({
    username: u.username,
  }));
}

// ---------- login + sessions ----------
function isLocked(username) {
  const key = lower(username);
  const record = fails.get(key);
  if (!record) return false;
  const now = Date.now();
  if (record.expiresAt <= now) {
    fails.delete(key);
    return false;
  }
  return record.until > now;
}
function noteFail(username) {
  const key = lower(username);
  const now = Date.now();
  for (const [name, record] of fails) {
    if (record.expiresAt <= now) fails.delete(name);
  }
  if (!fails.has(key) && fails.size >= 1024)
    fails.delete(fails.keys().next().value);
  const record = fails.get(key) || { count: 0, until: 0, expiresAt: 0 };
  record.count++;
  record.expiresAt = now + RL_LOCK_MS;
  if (record.count >= RL_MAX_FAILS) {
    record.until = record.expiresAt;
    record.count = 0;
  }
  fails.set(key, record);
}
function clearFails(username) {
  fails.delete(lower(username));
}
// returns { token, user } on success, or { error }
function login(username, password) {
  if (isLocked(username))
    return { error: "too many attempts - try again in a minute" };
  const u = findByName(username);
  // constant-ish behaviour: run a hash even if user missing / disabled
  const ok =
    u &&
    !u.disabled &&
    verifyPassword(password, u.salt, u.hash);
  if (!ok) {
    noteFail(username);
    return { error: "invalid username or password" };
  }
  clearFails(username);
  u.lastLoginAt = istNow();
  save();
  const now = Date.now();
  for (const [sessionToken, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(sessionToken);
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    userId: u.id,
    role: u.role,
    username: u.username,
    lastSeen: now,
  });
  return { token, user: pub(u) };
}
// validate a session token; slides the idle timeout. Returns the live user or null.
function sessionUser(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  const u = findById(s.userId);
  if (!u || u.disabled) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = Date.now();
  s.role = u.role; // reflect role changes immediately
  return pub(u);
}
function logout(token) {
  if (token) sessions.delete(token);
  return { ok: true };
}

module.exports = {
  load,
  backendName,
  passwordPepperConfigured,
  needsSetup,
  setupAdmin,
  createUser,
  updateUser,
  deleteUser,
  listUsers,
  pickerUsers,
  login,
  logout,
  sessionUser,
  createTelegramLinkCode,
  consumeTelegramLinkCode,
  unlinkTelegram,
  setTelegramEnabled,
  telegramRecipients,
  markTelegramUnreachable,
  ROLES,
  PW_MIN,
  // exposed for tests
  hashPassword,
  verifyPassword,
};
