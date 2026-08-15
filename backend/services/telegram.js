"use strict";

const fs = require("fs");
const path = require("path");
const { connectMongoWithRetry } = require("../core/mongo-retry");
const { DurableOutbox } = require("../core/durable-outbox");
const { istNow, istFromMs, envFlag } = require("../core/utils");
const { logErrorOnce, resetErrorOnce } = require("../core/logger");

const ROOT = path.join(__dirname, "..");
const STORE_DIR = path.join(ROOT, "store");
const STORE_FILE = path.join(STORE_DIR, "telegram.json");
const OUTBOX_FILE = path.join(STORE_DIR, "telegram-outbox.json");
const MAX_ATTEMPTS = 6;
const WORKER_MS = 1000;
const DEFAULT_BOT_USERNAME = "ZoneTrackerAlertBot";

// ---- pure helpers (no instance state) ----
function readConfig() {
  if (envFlag(process.env.TELEGRAM_DISABLED) || envFlag(process.env.ALERTS_NO_TICK))
    return null;
  // env only (TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME / MONGO_URI)
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!botToken) return null;
  return {
    botToken,
    botUsername: String(process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME)
      .replace(/^@/, "")
      .trim(),
    mongoUri: String(process.env.MONGO_URI || "").trim(),
  };
}

function mongoDbName(uri) {
  return (
    (uri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
    "trading_tracker"
  );
}

function parseLinkCommand(text) {
  const match = String(text || "")
    .trim()
    .match(/^\/(?:link|start)(?:@\w+)?\s+([A-Z0-9_-]+)$/i);
  return match ? match[1] : null;
}

// Durable Telegram delivery + inbound link polling. Owns its state, timers, Mongo↔file
// backend and outbox; exported as a shared singleton (drop-in for the old function-module),
// with the class attached for tests / isolated instances.
class TelegramService {
  constructor() {
    this.auth = null;
    this.config = null;
    this.store = { deliveries: [], updateOffset: 0 };
    this.backend = "file";
    this.deliveriesColl = null;
    this.metaColl = null;
    this.processedColl = null;
    this.workerTimer = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.polling = false;
    this.logError = () => {};
    this.onUserChange = () => {};
    this.isMarketOpen = () => true; // gate getUpdates polling to market hours (set in load)
    this.pollBackoffMs = 1000; // grows on repeated poll errors (e.g. bad token), caps at 60s
    this.outbox = new DurableOutbox(OUTBOX_FILE, {
      logError: (scope, error) => this.logError(scope, error),
    });
  }

  #readStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      return {
        deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
        updateOffset: Number(parsed.updateOffset) || 0,
      };
    } catch (_) {
      return { deliveries: [], updateOffset: 0 };
    }
  }

  #saveStore() {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const temp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.store, null, 2));
    fs.renameSync(temp, STORE_FILE);
  }

  async #processOutbox(operation) {
    if (await this.processedColl.findOne({ _id: operation.operationId })) return;
    if (operation.type === "TELEGRAM_DELIVERY_PUT") {
      const delivery = operation.payload;
      const id = `${delivery.eventId}:${delivery.userId}`;
      await this.deliveriesColl.replaceOne(
        { _id: id },
        { ...delivery, _id: id },
        { upsert: true },
      );
    } else if (operation.type === "TELEGRAM_OFFSET_PUT") {
      await this.metaColl.replaceOne(
        { _id: "telegram_update_offset" },
        { _id: "telegram_update_offset", value: operation.payload.value },
        { upsert: true },
      );
    } else {
      throw new Error(`unknown Telegram outbox operation: ${operation.type}`);
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

  #queueDelivery(delivery) {
    this.outbox.enqueue("TELEGRAM_DELIVERY_PUT", { ...delivery }, {
      dedupeKey: `telegram:${delivery.eventId}:${delivery.userId}`,
    });
  }

  #queueOffset() {
    this.outbox.enqueue(
      "TELEGRAM_OFFSET_PUT",
      { value: this.store.updateOffset },
      { dedupeKey: "telegram:update-offset" },
    );
  }

  #configureCollections(db) {
    this.deliveriesColl = db.collection("telegram_deliveries");
    this.metaColl = db.collection("meta");
    this.processedColl = db.collection("processed_operations");
    this.outbox.setProcessor((operation) => this.#processOutbox(operation));
  }

  async #reconnectMongo() {
    if (!this.config || !this.config.mongoUri || this.backend === "mongo" || this.reconnecting)
      return;
    this.reconnecting = true;
    try {
      const client = await connectMongoWithRetry(this.config.mongoUri, {
        retries: 0,
        serverSelectionTimeoutMS: 5000,
      });
      this.#configureCollections(client.db(mongoDbName(this.config.mongoUri)));
      await this.deliveriesColl.createIndex(
        { eventId: 1, userId: 1 },
        { unique: true },
      );
      await this.outbox.drain();
      this.backend = "mongo";
      resetErrorOnce("telegram.mongo.reconnect");
      console.log("  Telegram: MongoDB connection restored; pending deliveries synced");
    } catch (error) {
      this.backend = "file";
      this.outbox.setProcessor(null);
      logErrorOnce("telegram.mongo.reconnect", error); // log once per outage
    } finally {
      this.reconnecting = false;
    }
  }

  #startReconnectWorker() {
    if (!this.config || !this.config.mongoUri || this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => void this.#reconnectMongo(), 15_000);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  async load(options = {}) {
    this.auth = options.auth;
    this.logError = options.logError || this.logError;
    this.onUserChange = options.onUserChange || this.onUserChange;
    this.isMarketOpen = options.isMarketOpen || this.isMarketOpen;
    this.config = readConfig();
    this.store = this.#readStore();
    if (!this.config || !this.config.botToken) return "disabled";
    if (this.config.mongoUri) {
      try {
        const client = await connectMongoWithRetry(this.config.mongoUri, {
          retries: 1,
          retryDelayMs: 2000,
          serverSelectionTimeoutMS: 6000,
        });
        this.#configureCollections(client.db(mongoDbName(this.config.mongoUri)));
        await this.outbox.drain();
        await this.deliveriesColl.createIndex(
          { eventId: 1, userId: 1 },
          { unique: true },
        );
        const [docs, offsetDoc] = await Promise.all([
          this.deliveriesColl.find({}).toArray(),
          this.metaColl.findOne({ _id: "telegram_update_offset" }),
        ]);
        if (docs.length || offsetDoc) {
          this.store = {
            deliveries: docs.map((doc) => {
              delete doc._id;
              return doc;
            }),
            updateOffset: Number(offsetDoc && offsetDoc.value) || 0,
          };
        } else {
          for (const delivery of this.store.deliveries) this.#queueDelivery(delivery);
          this.#queueOffset();
        }
        for (const delivery of this.store.deliveries) {
          if (delivery.status !== "sending") continue;
          delivery.status = "failed";
          delivery.nextAttemptAt = istNow();
          delivery.lastError = "delivery interrupted before acknowledgement";
          this.#queueDelivery(delivery);
        }
        this.backend = "mongo";
      } catch (error) {
        this.backend = "file";
        this.outbox.setProcessor(null);
        this.logError("telegram.mongo", error);
        for (const delivery of this.store.deliveries) this.#queueDelivery(delivery);
        this.#queueOffset();
      }
    }
    this.#saveStore();
    this.#startWorkers();
    this.#startReconnectWorker();
    return this.backend;
  }

  configured() {
    return !!(this.config && this.config.botToken);
  }

  publicConfig() {
    return {
      configured: this.configured(),
      botUsername: (this.config && this.config.botUsername) || "",
    };
  }

  enqueue(event) {
    if (!this.configured() || !event || !event.id) return;
    const recipients = this.auth.telegramRecipients();
    const now = istNow();
    for (const recipient of recipients) {
      if (
        this.store.deliveries.some(
          (delivery) =>
            delivery.eventId === event.id && delivery.userId === recipient.userId,
        )
      )
        continue;
      const delivery = {
        eventId: event.id,
        userId: recipient.userId,
        chatId: recipient.chatId,
        text: event.text,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        telegramMessageId: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.deliveries.push(delivery);
      this.#queueDelivery(delivery);
    }
    this.#saveStore();
  }

  async #telegramRequest(method, body) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    let result = {};
    try {
      result = await response.json();
    } catch (_) {}
    if (!response.ok || result.ok === false) {
      const error = new Error(result.description || `Telegram HTTP ${response.status}`);
      error.permanent = response.status === 400 || response.status === 403;
      throw error;
    }
    return result.result;
  }

  async #processDelivery(delivery) {
    delivery.status = "sending";
    delivery.attempts += 1;
    delivery.updatedAt = istNow();
    this.#queueDelivery(delivery);
    this.#saveStore();
    try {
      const message = await this.#telegramRequest("sendMessage", {
        chat_id: delivery.chatId,
        text: delivery.text,
      });
      delivery.status = "sent";
      delivery.telegramMessageId = String(message.message_id);
      delivery.lastError = null;
      delivery.nextAttemptAt = null;
    } catch (error) {
      delivery.lastError = String((error && error.message) || error);
      if (error.permanent || delivery.attempts >= MAX_ATTEMPTS) {
        delivery.status = "dead";
        delivery.nextAttemptAt = null;
        if (error.permanent) {
          this.auth.markTelegramUnreachable(delivery.userId, error.message);
          this.onUserChange(delivery.userId);
        }
      } else {
        delivery.status = "failed";
        const delay = Math.min(15 * 60_000, 5000 * 2 ** (delivery.attempts - 1));
        delivery.nextAttemptAt = istFromMs(Date.now() + delay);
      }
      this.logError("telegram.delivery", delivery.lastError);
    }
    delivery.updatedAt = istNow();
    this.#queueDelivery(delivery);
    this.#saveStore();
  }

  async #deliveryTick() {
    const now = istNow();
    const ready = this.store.deliveries
      .filter(
        (delivery) =>
          (delivery.status === "pending" || delivery.status === "failed") &&
          (!delivery.nextAttemptAt || delivery.nextAttemptAt <= now),
      )
      .slice(0, 3);
    await Promise.allSettled(ready.map((delivery) => this.#processDelivery(delivery)));
  }

  async #processUpdate(update) {
    const message = update && update.message;
    if (!message) return;
    const code = parseLinkCommand(message && message.text);
    if (!code) {
      if (/^\/start(?:@\w+)?$/i.test(String(message.text || "").trim())) {
        try {
          await this.#telegramRequest("sendMessage", {
            chat_id: message.chat.id,
            text: "Open Telegram settings in Trading Tracker and create a connection link first.",
          });
        } catch (error) {
          this.logError("telegram.start.reply", error);
        }
      }
      return;
    }
    const result = this.auth.consumeTelegramLinkCode(code, {
      chatId: message.chat.id,
      telegramUserId: message.from && message.from.id,
      telegramUsername: message.from && message.from.username,
    });
    const reply = result.error
      ? `Link failed: ${result.error}`
      : `Telegram linked to ${result.username}. Alert deliveries are now enabled.`;
    if (!result.error && result.user) this.onUserChange(result.user.id);
    try {
      await this.#telegramRequest("sendMessage", { chat_id: message.chat.id, text: reply });
    } catch (error) {
      this.logError("telegram.link.reply", error);
    }
  }

  async #pollUpdates() {
    if (!this.configured() || this.polling) return;
    // Only poll for inbound updates during market hours; recheck every 30s otherwise.
    if (!this.isMarketOpen()) {
      this.pollTimer = setTimeout(() => this.#pollUpdates(), 30_000);
      if (this.pollTimer.unref) this.pollTimer.unref();
      return;
    }
    this.polling = true;
    let ok = false;
    try {
      const updates = await this.#telegramRequest("getUpdates", {
        offset: this.store.updateOffset,
        timeout: 25,
        allowed_updates: ["message"],
      });
      for (const update of updates || []) {
        await this.#processUpdate(update);
        this.store.updateOffset = Math.max(
          this.store.updateOffset,
          Number(update.update_id) + 1,
        );
        this.#queueOffset();
        this.#saveStore();
      }
      ok = true;
    } catch (error) {
      // dedupe (log once) + exponential backoff so a bad token can't spam every 1s
      logErrorOnce("telegram.poll", error);
    } finally {
      this.polling = false;
      if (ok) {
        this.pollBackoffMs = 1000;
        resetErrorOnce("telegram.poll");
      } else {
        this.pollBackoffMs = Math.min(60_000, this.pollBackoffMs * 2);
      }
      this.pollTimer = setTimeout(() => this.#pollUpdates(), this.pollBackoffMs);
      if (this.pollTimer.unref) this.pollTimer.unref();
    }
  }

  #startWorkers() {
    if (!this.configured()) return;
    if (!this.workerTimer) {
      this.workerTimer = setInterval(() => void this.#deliveryTick(), WORKER_MS);
      if (this.workerTimer.unref) this.workerTimer.unref();
    }
    void this.#pollUpdates();
  }

  deliveryStatus(userId) {
    const deliveries = this.store.deliveries.filter((item) => item.userId === userId);
    const counts = {};
    for (const delivery of deliveries)
      counts[delivery.status] = (counts[delivery.status] || 0) + 1;
    return { counts, backend: this.backend, pendingSync: this.outbox.status().pending };
  }

  // pure regex helper, exposed for callers/tests (no instance state)
  parseLinkCommand(text) {
    return parseLinkCommand(text);
  }
}

// Shared singleton (drop-in for the old function-module API) + the class for tests/isolated instances.
const telegram = new TelegramService();
telegram.TelegramService = TelegramService;
module.exports = telegram;
