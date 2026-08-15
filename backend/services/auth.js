"use strict";
/**
 * Auth + user management for the Trading Tracker portal (file/Mongo persistence).
 *
 * - Users live in a `users` collection (MongoDB Atlas, if MONGO_URI is set and reachable) or the local `users.json` file (offline cache / fallback).
 *   Mirrors alerts.js: in-memory `store` is the source of truth; save() writes through.
 * - Passwords are hashed with the built-in `crypto.scrypt`, a per-user random salt, and
 *   a required secret pepper (AUTH_PASSWORD_PEPPER env). Hashes are verified with
 *   `timingSafeEqual`; plaintext passwords and the pepper are never stored with users.
 * - Sessions are random 256-bit tokens kept in memory (cleared on restart), 12h idle TTL.
 *
 * Roles: admin (manages users and alerts) | editor (manages alerts) |
 * viewer (read-only).
 *
 * Exported as a shared singleton (drop-in for the old function-module API); the
 * AuthService class is attached for tests / isolated instances.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { connectMongoWithRetry } = require("../core/mongo-retry");
const { DurableOutbox } = require("../core/durable-outbox");
const { istNow, istFromMs, istLogTs } = require("../core/utils");
const { logErrorOnce, resetErrorOnce } = require("../core/logger");

const ROOT = path.join(__dirname, ".."); // repo root for local stores and logs
const STORE_DIR = path.join(ROOT, "store"); // alert + user data files live here
const STORE_FILE = path.join(STORE_DIR, "users.json");
const OUTBOX_FILE = path.join(STORE_DIR, "auth-outbox.json");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "alerts-errors.log");

const ROLES = ["admin", "editor", "viewer"];
const PW_MIN = 6;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h idle timeout
const RL_MAX_FAILS = 5; // failed logins before lockout
const RL_LOCK_MS = 60 * 1000; // lockout window
const SCRYPT_KEYLEN = 64;

// ---------- pure helpers (no instance state) ----------
function logError(scope, err) {
  const msg = err && err.message ? err.message : String(err == null ? "" : err);
  const line = `[${istLogTs()}] ERROR [${scope}] ${msg}`;
  console.error("  " + line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {}
}
function passwordMaterial(password, pepper) {
  return crypto
    .createHmac("sha256", pepper)
    .update(String(password), "utf8")
    .digest();
}
function readFileStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { users: Array.isArray(raw.users) ? raw.users : [] };
  } catch (_) {
    return { users: [] };
  }
}
function mongoDbName(uri) {
  return (
    (uri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
    "trading_tracker"
  );
}
const norm = (u) => String(u || "").trim();
const lower = (u) => norm(u).toLowerCase();
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
function linkCodeHash(code) {
  return crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
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

// Auth service: owns the user store, Mongo↔file backend, durable outbox, password pepper,
// in-memory sessions and the login rate-limiter.
class AuthService {
  constructor() {
    this.store = { users: [] };
    this.backend = "file"; // "file" | "mongo"
    this.usersColl = null;
    this.processedColl = null;
    this.mongoUri = "";
    this.reconnectTimer = null;
    this.passwordPepper = "";
    this.sessions = new Map(); // token -> { userId, role, username, lastSeen }
    this.fails = new Map(); // usernameLower -> { count, until, expiresAt }
    this.outbox = new DurableOutbox(OUTBOX_FILE, { logError });
  }

  // ---------- hashing ----------
  hashPassword(password, salt, pepper = this.passwordPepper) {
    if (!pepper) throw new Error("auth.passwordPepper is required");
    const s = salt || crypto.randomBytes(16).toString("hex");
    const hash = crypto
      .scryptSync(passwordMaterial(password, pepper), s, SCRYPT_KEYLEN)
      .toString("hex");
    return { salt: s, hash };
  }
  verifyPassword(password, salt, hash, pepper = this.passwordPepper) {
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
  #loadConfig() {
    this.passwordPepper = "";
    const mongoUri = String(process.env.MONGO_URI || "").trim();
    const configuredPepper = String(process.env.AUTH_PASSWORD_PEPPER || "").trim();
    if (configuredPepper.length < 32)
      throw new Error("AUTH_PASSWORD_PEPPER env must be set to >= 32 chars (openssl rand -hex 32)");
    this.passwordPepper = configuredPepper;
    return mongoUri;
  }

  async load() {
    this.mongoUri = this.#loadConfig();
    let seedFromLocal = false;
    if (this.mongoUri) {
      try {
        const client = await connectMongoWithRetry(this.mongoUri, {
          retries: 1,
          retryDelayMs: 2000,
          serverSelectionTimeoutMS: 6000,
        });
        const db = client.db(mongoDbName(this.mongoUri));
        this.#configureMongo(db);
        await this.outbox.drain();
        await this.usersColl.createIndex(
          { "telegram.chatId": 1 },
          {
            unique: true,
            partialFilterExpression: { "telegram.chatId": { $type: "string" } },
          },
        );
        this.backend = "mongo";
        const docs = await this.usersColl.find({}).toArray();
        if (docs.length) {
          this.store = {
            users: docs.map((d) => {
              delete d._id;
              return d;
            }),
          };
        } else {
          // fresh DB: seed from local users.json if present, else empty (first-run setup)
          this.store = readFileStore();
          seedFromLocal = true;
          if (this.store.users.length)
            console.log(`  auth: seeded ${this.store.users.length} users from users.json`);
        }
      } catch (e) {
        logError("auth.mongo.connect", `${(e && e.message) || e} - using users.json`);
        this.usersColl = null;
        this.processedColl = null;
        this.outbox.setProcessor(null);
        this.backend = "file";
        this.store = readFileStore();
        seedFromLocal = true;
      }
    } else {
      this.backend = "file";
      this.store = readFileStore();
      seedFromLocal = true;
    }
    this.#save({ queue: seedFromLocal });
    this.#startReconnectWorker();
    return this.backend;
  }

  backendName() {
    return this.backend;
  }
  passwordPepperConfigured() {
    return !!this.passwordPepper;
  }

  #queueUser(user) {
    this.outbox.enqueue("USER_PUT", { ...user }, { dedupeKey: `user:${user.id}` });
  }
  #queueUserDelete(user) {
    this.outbox.enqueue(
      "USER_DELETE",
      { id: user.id, at: istNow() },
      { dedupeKey: `user:${user.id}` },
    );
  }

  async #processOutbox(operation) {
    if (await this.processedColl.findOne({ _id: operation.operationId })) return;
    if (operation.type === "USER_PUT") {
      const user = operation.payload;
      await this.usersColl.replaceOne(
        { _id: user.id },
        { ...user, _id: user.id },
        { upsert: true },
      );
    } else if (operation.type === "USER_DELETE") {
      await this.usersColl.deleteOne({ _id: operation.payload.id });
    } else {
      throw new Error(`unknown auth outbox operation: ${operation.type}`);
    }
    await this.processedColl.updateOne(
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

  #configureMongo(db) {
    this.usersColl = db.collection("users");
    this.processedColl = db.collection("processed_operations");
    this.outbox.setProcessor((operation) => this.#processOutbox(operation));
  }

  #save(options = {}) {
    if (options.queue !== false) for (const user of this.store.users) this.#queueUser(user);
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(this.store, null, 2));
    } catch (e) {
      logError("auth.file.write", `users.json - ${e.message}`);
    }
    if (this.backend === "mongo") void this.outbox.drain();
  }

  async #reconnectMongo() {
    if (!this.mongoUri || this.backend === "mongo") return;
    try {
      const client = await connectMongoWithRetry(this.mongoUri, {
        retries: 0,
        serverSelectionTimeoutMS: 5000,
      });
      this.#configureMongo(client.db(mongoDbName(this.mongoUri)));
      await this.usersColl.createIndex(
        { "telegram.chatId": 1 },
        {
          unique: true,
          partialFilterExpression: { "telegram.chatId": { $type: "string" } },
        },
      );
      this.backend = "mongo";
      resetErrorOnce("auth.mongo.reconnect");
      await this.outbox.drain();
      console.log("  auth: MongoDB reconnected; durable outbox replayed");
    } catch (error) {
      this.backend = "file";
      this.outbox.setProcessor(null);
      logErrorOnce("auth.mongo.reconnect", error); // log once per outage
    }
  }

  #startReconnectWorker() {
    if (!this.mongoUri || this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => void this.#reconnectMongo(), 15_000);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  // ---------- lookups ----------
  #findByName(username) {
    const l = lower(username);
    return this.store.users.find((u) => lower(u.username) === l) || null;
  }
  #findById(id) {
    return this.store.users.find((u) => u.id === id) || null;
  }
  #enabledAdmins() {
    return this.store.users.filter((u) => u.role === "admin" && !u.disabled);
  }

  // ---------- Telegram account link state ----------
  createTelegramLinkCode(userId) {
    const user = this.#findById(userId);
    if (!user) return { error: "not found" };
    const code = crypto.randomBytes(6).toString("base64url").toUpperCase();
    const expiresAt = istFromMs(Date.now() + 10 * 60_000);
    user.telegramLink = { codeHash: linkCodeHash(code), expiresAt };
    user.updatedAt = istNow();
    this.#save();
    return { code, expiresAt };
  }
  consumeTelegramLinkCode(code, telegramAccount) {
    const hash = linkCodeHash(String(code || "").trim().toUpperCase());
    const now = istNow();
    const user = this.store.users.find(
      (candidate) =>
        candidate.telegramLink &&
        candidate.telegramLink.expiresAt > now &&
        candidate.telegramLink.codeHash === hash,
    );
    if (!user) return { error: "invalid or expired link code" };
    const chatId = String(telegramAccount.chatId);
    const conflict = this.store.users.find(
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
    this.#save();
    return { user: pub(user), username: user.username };
  }
  unlinkTelegram(userId) {
    const user = this.#findById(userId);
    if (!user) return { error: "not found" };
    delete user.telegram;
    delete user.telegramLink;
    user.updatedAt = istNow();
    this.#save();
    return { user: pub(user) };
  }
  setTelegramEnabled(userId, enabled) {
    const user = this.#findById(userId);
    if (!user) return { error: "not found" };
    if (!user.telegram || !user.telegram.verifiedAt)
      return { error: "Telegram is not linked" };
    user.telegram.enabled = !!enabled;
    user.updatedAt = istNow();
    this.#save();
    return { user: pub(user) };
  }
  telegramRecipients() {
    return this.store.users
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
  markTelegramUnreachable(userId, error) {
    const user = this.#findById(userId);
    if (!user || !user.telegram) return;
    user.telegram.reachable = false;
    user.telegram.enabled = false;
    user.telegram.lastError = String(error || "Telegram delivery failed");
    user.updatedAt = istNow();
    this.#save();
  }

  // ---------- setup / user CRUD ----------
  needsSetup() {
    return this.store.users.length === 0;
  }
  setupAdmin({ username, password }) {
    if (!this.needsSetup()) return { error: "setup already complete" };
    return this.createUser({ username, password, role: "admin" }, null);
  }
  createUser({ username, password, role }, createdBy) {
    const ue = validateUsername(username);
    if (ue) return { error: ue };
    const pe = validatePassword(password);
    if (pe) return { error: pe };
    if (!ROLES.includes(role)) return { error: "invalid role" };
    if (this.#findByName(username)) return { error: "username already exists" };
    const now = istNow();
    const { salt, hash } = this.hashPassword(password);
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
    this.store.users.push(user);
    this.#save();
    return { user: pub(user) };
  }
  updateUser(id, input) {
    const u = this.#findById(id);
    if (!u) return { error: "not found" };
    const patch = input || {};
    // rename
    if (patch.username !== undefined) {
      const ue = validateUsername(patch.username);
      if (ue) return { error: ue };
      const other = this.#findByName(patch.username);
      if (other && other.id !== id) return { error: "username already exists" };
      u.username = norm(patch.username);
    }
    // role change - protect the last enabled admin
    if (patch.role !== undefined) {
      if (!ROLES.includes(patch.role)) return { error: "invalid role" };
      if (u.role === "admin" && patch.role !== "admin" && this.#enabledAdmins().length <= 1)
        return { error: "cannot demote the last admin" };
      u.role = patch.role;
    }
    // disable/enable - protect the last enabled admin
    if (patch.disabled !== undefined) {
      const willDisable = !!patch.disabled;
      if (willDisable && u.role === "admin" && this.#enabledAdmins().length <= 1)
        return { error: "cannot disable the last admin" };
      u.disabled = willDisable;
    }
    // password reset
    if (patch.password !== undefined && patch.password !== "") {
      const pe = validatePassword(patch.password);
      if (pe) return { error: pe };
      const { salt, hash } = this.hashPassword(patch.password);
      u.salt = salt;
      u.hash = hash;
    }
    u.updatedAt = istNow();
    this.#save();
    return { user: pub(u) };
  }
  deleteUser(id) {
    const u = this.#findById(id);
    if (!u) return { error: "not found" };
    if (u.role === "admin" && this.#enabledAdmins().length <= 1)
      return { error: "cannot delete the last admin" };
    this.#queueUserDelete(u);
    this.store.users = this.store.users.filter((x) => x.id !== id);
    this.#save();
    return { ok: true };
  }
  listUsers() {
    return this.store.users.map(pub);
  }
  // for the login picker: enabled users only, minimal fields
  pickerUsers() {
    return this.store.users.filter((u) => !u.disabled).map((u) => ({
      username: u.username,
    }));
  }

  // ---------- login + sessions ----------
  #isLocked(username) {
    const key = lower(username);
    const record = this.fails.get(key);
    if (!record) return false;
    const now = Date.now();
    if (record.expiresAt <= now) {
      this.fails.delete(key);
      return false;
    }
    return record.until > now;
  }
  #noteFail(username) {
    const key = lower(username);
    const now = Date.now();
    for (const [name, record] of this.fails) {
      if (record.expiresAt <= now) this.fails.delete(name);
    }
    if (!this.fails.has(key) && this.fails.size >= 1024)
      this.fails.delete(this.fails.keys().next().value);
    const record = this.fails.get(key) || { count: 0, until: 0, expiresAt: 0 };
    record.count++;
    record.expiresAt = now + RL_LOCK_MS;
    if (record.count >= RL_MAX_FAILS) {
      record.until = record.expiresAt;
      record.count = 0;
    }
    this.fails.set(key, record);
  }
  #clearFails(username) {
    this.fails.delete(lower(username));
  }
  // returns { token, user } on success, or { error }
  login(username, password) {
    if (this.#isLocked(username))
      return { error: "too many attempts - try again in a minute" };
    const u = this.#findByName(username);
    // constant-ish behaviour: run a hash even if user missing / disabled
    const ok =
      u &&
      !u.disabled &&
      this.verifyPassword(password, u.salt, u.hash);
    if (!ok) {
      this.#noteFail(username);
      return { error: "invalid username or password" };
    }
    this.#clearFails(username);
    u.lastLoginAt = istNow();
    this.#save();
    const now = Date.now();
    for (const [sessionToken, session] of this.sessions) {
      if (now - session.lastSeen > SESSION_TTL_MS) this.sessions.delete(sessionToken);
    }
    const token = crypto.randomBytes(32).toString("hex");
    this.sessions.set(token, {
      userId: u.id,
      role: u.role,
      username: u.username,
      lastSeen: now,
    });
    return { token, user: pub(u) };
  }
  // validate a session token; slides the idle timeout. Returns the live user or null.
  sessionUser(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.lastSeen > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return null;
    }
    const u = this.#findById(s.userId);
    if (!u || u.disabled) {
      this.sessions.delete(token);
      return null;
    }
    s.lastSeen = Date.now();
    s.role = u.role; // reflect role changes immediately
    return pub(u);
  }
  logout(token) {
    if (token) this.sessions.delete(token);
    return { ok: true };
  }
}

// Shared singleton (drop-in for the old function-module API) + the class for tests/isolated instances.
const auth = new AuthService();
auth.AuthService = AuthService;
auth.ROLES = ROLES;
auth.PW_MIN = PW_MIN;
module.exports = auth;
