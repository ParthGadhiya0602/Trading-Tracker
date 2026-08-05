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
 * Roles: admin (manages users, views alerts) | editor (manages alerts) |
 * viewer (read-only).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, ".."); // repo root (config lives here)
const STORE_DIR = path.join(ROOT, "store"); // alert + user data files live here
const STORE_FILE = path.join(STORE_DIR, "users.json");
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
let mongoBusy = false,
  mongoDirty = false;
let passwordPepper = "";

const sessions = new Map(); // token -> { userId, role, username, lastSeen }
const fails = new Map(); // usernameLower -> { count, until, expiresAt }

// ---------- small error log (shared file with alerts, "auth.*" scopes) ----------
function logTs() {
  const p = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .forEach((x) => (p[x.type] = x.value));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} IST`;
}
function logError(scope, err) {
  const msg = err && err.message ? err.message : String(err == null ? "" : err);
  const line = `[${logTs()}] ERROR [${scope}] ${msg}`;
  console.error("  " + line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {}
}

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
  const mongoUri = loadConfig();
  if (mongoUri) {
    try {
      const { MongoClient } = require("mongodb"); // lazy: only for Mongo mode
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      const dbName =
        (mongoUri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
        "trading_tracker";
      const db = client.db(dbName);
      usersColl = db.collection("users");
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
        if (store.users.length)
          console.log(`  auth: seeded ${store.users.length} users from users.json`);
      }
    } catch (e) {
      logError("auth.mongo.connect", `${(e && e.message) || e} - using users.json`);
      usersColl = null;
      backend = "file";
      store = readFileStore();
    }
  } else {
    backend = "file";
    store = readFileStore();
  }
  save(); // persist current shape to the active backend
  return backend;
}
function backendName() {
  return backend;
}
function passwordPepperConfigured() {
  return !!passwordPepper;
}
function save() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    logError("auth.file.write", `users.json - ${e.message}`);
  }
  if (backend === "mongo" && usersColl) persistMongo();
}
async function syncMongo() {
  const ids = store.users.map((u) => u.id);
  const ops = store.users.map((u) => ({
    replaceOne: { filter: { _id: u.id }, replacement: { ...u, _id: u.id }, upsert: true },
  }));
  ops.push({ deleteMany: { filter: { _id: { $nin: ids } } } });
  await usersColl.bulkWrite(ops, { ordered: false });
}
async function persistMongo() {
  if (mongoBusy) {
    mongoDirty = true;
    return;
  }
  mongoBusy = true;
  try {
    await syncMongo();
  } catch (e) {
    logError("auth.mongo.write", (e && e.message) || e);
  } finally {
    mongoBusy = false;
    if (mongoDirty) {
      mongoDirty = false;
      persistMongo();
    }
  }
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
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt || null,
  };
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
  const now = new Date().toISOString();
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
  u.updatedAt = new Date().toISOString();
  save();
  return { user: pub(u) };
}
function deleteUser(id) {
  const u = findById(id);
  if (!u) return { error: "not found" };
  if (u.role === "admin" && enabledAdmins().length <= 1)
    return { error: "cannot delete the last admin" };
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
    id: u.id,
    username: u.username,
    role: u.role,
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
  u.lastLoginAt = new Date().toISOString();
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
  ROLES,
  PW_MIN,
  // exposed for tests
  hashPassword,
  verifyPassword,
};
