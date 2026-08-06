"use strict";

const fs = require("fs");
const path = require("path");
const { connectMongoWithRetry } = require("./mongo-retry");
const { DurableOutbox } = require("./durable-outbox");

const ROOT = path.join(__dirname, "..");
const STORE_DIR = path.join(ROOT, "store");
const STORE_FILE = path.join(STORE_DIR, "telegram.json");
const OUTBOX_FILE = path.join(STORE_DIR, "telegram-outbox.json");
const CONFIG_FILE = path.join(ROOT, "config.json");
const MAX_ATTEMPTS = 6;
const WORKER_MS = 1000;
const DEFAULT_BOT_USERNAME = "ZoneTrackerAlertBot";

let auth = null;
let config = null;
let store = { deliveries: [], updateOffset: 0 };
let backend = "file";
let deliveriesColl = null;
let metaColl = null;
let processedColl = null;
let workerTimer = null;
let pollTimer = null;
let reconnectTimer = null;
let reconnecting = false;
let polling = false;
let logError = () => {};
let onUserChange = () => {};

const outbox = new DurableOutbox(OUTBOX_FILE, {
  logError: (scope, error) => logError(scope, error),
});

function readConfig() {
  if (process.env.TELEGRAM_DISABLED || process.env.ALERTS_NO_TICK) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const telegram = parsed && parsed.telegram;
    if (!telegram || !telegram.botToken) return null;
    return {
      botToken: String(telegram.botToken).trim(),
      botUsername: String(telegram.botUsername || DEFAULT_BOT_USERNAME)
        .replace(/^@/, "")
        .trim(),
      mongoUri:
        parsed.mongo && parsed.mongo.uri ? String(parsed.mongo.uri).trim() : "",
    };
  } catch (_) {
    return null;
  }
}

function readStore() {
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

function saveStore() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const temp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, STORE_FILE);
}

async function processOutbox(operation) {
  if (await processedColl.findOne({ _id: operation.operationId })) return;
  if (operation.type === "TELEGRAM_DELIVERY_PUT") {
    const delivery = operation.payload;
    const id = `${delivery.eventId}:${delivery.userId}`;
    await deliveriesColl.replaceOne(
      { _id: id },
      { ...delivery, _id: id },
      { upsert: true },
    );
  } else if (operation.type === "TELEGRAM_OFFSET_PUT") {
    await metaColl.replaceOne(
      { _id: "telegram_update_offset" },
      { _id: "telegram_update_offset", value: operation.payload.value },
      { upsert: true },
    );
  } else {
    throw new Error(`unknown Telegram outbox operation: ${operation.type}`);
  }
  await processedColl.updateOne(
    { _id: operation.operationId },
    {
      $setOnInsert: {
        type: operation.type,
        processedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

function queueDelivery(delivery) {
  outbox.enqueue("TELEGRAM_DELIVERY_PUT", { ...delivery }, {
    dedupeKey: `telegram:${delivery.eventId}:${delivery.userId}`,
  });
}

function queueOffset() {
  outbox.enqueue(
    "TELEGRAM_OFFSET_PUT",
    { value: store.updateOffset },
    { dedupeKey: "telegram:update-offset" },
  );
}

function configureCollections(db) {
  deliveriesColl = db.collection("telegram_deliveries");
  metaColl = db.collection("meta");
  processedColl = db.collection("processed_operations");
  outbox.setProcessor(processOutbox);
}

function mongoDbName(uri) {
  return (
    (uri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] ||
    "trading_tracker"
  );
}

async function reconnectMongo() {
  if (!config || !config.mongoUri || backend === "mongo" || reconnecting) return;
  reconnecting = true;
  try {
    const client = await connectMongoWithRetry(config.mongoUri, {
      retries: 0,
      serverSelectionTimeoutMS: 5000,
    });
    configureCollections(client.db(mongoDbName(config.mongoUri)));
    await deliveriesColl.createIndex(
      { eventId: 1, userId: 1 },
      { unique: true },
    );
    await outbox.drain();
    backend = "mongo";
    console.log("  Telegram: MongoDB connection restored; pending deliveries synced");
  } catch (error) {
    backend = "file";
    outbox.setProcessor(null);
    logError("telegram.mongo.reconnect", error);
  } finally {
    reconnecting = false;
  }
}

function startReconnectWorker() {
  if (!config || !config.mongoUri || reconnectTimer) return;
  reconnectTimer = setInterval(() => void reconnectMongo(), 15_000);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

async function load(options = {}) {
  auth = options.auth;
  logError = options.logError || logError;
  onUserChange = options.onUserChange || onUserChange;
  config = readConfig();
  store = readStore();
  if (!config || !config.botToken) return "disabled";
  if (config.mongoUri) {
    try {
      const client = await connectMongoWithRetry(config.mongoUri, {
        retries: 3,
        retryDelayMs: 3000,
        serverSelectionTimeoutMS: 8000,
      });
      configureCollections(client.db(mongoDbName(config.mongoUri)));
      await outbox.drain();
      await deliveriesColl.createIndex(
        { eventId: 1, userId: 1 },
        { unique: true },
      );
      const [docs, offsetDoc] = await Promise.all([
        deliveriesColl.find({}).toArray(),
        metaColl.findOne({ _id: "telegram_update_offset" }),
      ]);
      if (docs.length || offsetDoc) {
        store = {
          deliveries: docs.map((doc) => {
            delete doc._id;
            return doc;
          }),
          updateOffset: Number(offsetDoc && offsetDoc.value) || 0,
        };
      } else {
        for (const delivery of store.deliveries) queueDelivery(delivery);
        queueOffset();
      }
      for (const delivery of store.deliveries) {
        if (delivery.status !== "sending") continue;
        delivery.status = "failed";
        delivery.nextAttemptAt = new Date().toISOString();
        delivery.lastError = "delivery interrupted before acknowledgement";
        queueDelivery(delivery);
      }
      backend = "mongo";
    } catch (error) {
      backend = "file";
      outbox.setProcessor(null);
      logError("telegram.mongo", error);
      for (const delivery of store.deliveries) queueDelivery(delivery);
      queueOffset();
    }
  }
  saveStore();
  startWorkers();
  startReconnectWorker();
  return backend;
}

function configured() {
  return !!(config && config.botToken);
}

function publicConfig() {
  return {
    configured: configured(),
    botUsername: (config && config.botUsername) || "",
  };
}

function enqueue(event) {
  if (!configured() || !event || !event.id) return;
  const recipients = auth.telegramRecipients();
  const now = new Date().toISOString();
  for (const recipient of recipients) {
    if (
      store.deliveries.some(
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
    store.deliveries.push(delivery);
    queueDelivery(delivery);
  }
  saveStore();
}

async function telegramRequest(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/${method}`,
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

async function processDelivery(delivery) {
  delivery.status = "sending";
  delivery.attempts += 1;
  delivery.updatedAt = new Date().toISOString();
  queueDelivery(delivery);
  saveStore();
  try {
    const message = await telegramRequest("sendMessage", {
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
        auth.markTelegramUnreachable(delivery.userId, error.message);
        onUserChange(delivery.userId);
      }
    } else {
      delivery.status = "failed";
      const delay = Math.min(15 * 60_000, 5000 * 2 ** (delivery.attempts - 1));
      delivery.nextAttemptAt = new Date(Date.now() + delay).toISOString();
    }
    logError("telegram.delivery", delivery.lastError);
  }
  delivery.updatedAt = new Date().toISOString();
  queueDelivery(delivery);
  saveStore();
}

async function deliveryTick() {
  const now = new Date().toISOString();
  const ready = store.deliveries
    .filter(
      (delivery) =>
        (delivery.status === "pending" || delivery.status === "failed") &&
        (!delivery.nextAttemptAt || delivery.nextAttemptAt <= now),
    )
    .slice(0, 3);
  await Promise.allSettled(ready.map(processDelivery));
}

async function processUpdate(update) {
  const message = update && update.message;
  if (!message) return;
  const code = parseLinkCommand(message && message.text);
  if (!code) {
    if (/^\/start(?:@\w+)?$/i.test(String(message.text || "").trim())) {
      try {
        await telegramRequest("sendMessage", {
          chat_id: message.chat.id,
          text: "Open Telegram settings in Trading Tracker and create a connection link first.",
        });
      } catch (error) {
        logError("telegram.start.reply", error);
      }
    }
    return;
  }
  const result = auth.consumeTelegramLinkCode(code, {
    chatId: message.chat.id,
    telegramUserId: message.from && message.from.id,
    telegramUsername: message.from && message.from.username,
  });
  const reply = result.error
    ? `Link failed: ${result.error}`
    : `Telegram linked to ${result.username}. Alert deliveries are now enabled.`;
  if (!result.error && result.user) onUserChange(result.user.id);
  try {
    await telegramRequest("sendMessage", { chat_id: message.chat.id, text: reply });
  } catch (error) {
    logError("telegram.link.reply", error);
  }
}

function parseLinkCommand(text) {
  const match = String(text || "")
    .trim()
    .match(/^\/(?:link|start)(?:@\w+)?\s+([A-Z0-9_-]+)$/i);
  return match ? match[1] : null;
}

async function pollUpdates() {
  if (!configured() || polling) return;
  polling = true;
  try {
    const updates = await telegramRequest("getUpdates", {
      offset: store.updateOffset,
      timeout: 25,
      allowed_updates: ["message"],
    });
    for (const update of updates || []) {
      await processUpdate(update);
      store.updateOffset = Math.max(store.updateOffset, Number(update.update_id) + 1);
      queueOffset();
      saveStore();
    }
  } catch (error) {
    logError("telegram.poll", error);
  } finally {
    polling = false;
    pollTimer = setTimeout(pollUpdates, 1000);
    if (pollTimer.unref) pollTimer.unref();
  }
}

function startWorkers() {
  if (!configured()) return;
  if (!workerTimer) {
    workerTimer = setInterval(() => void deliveryTick(), WORKER_MS);
    if (workerTimer.unref) workerTimer.unref();
  }
  void pollUpdates();
}

function deliveryStatus(userId) {
  const deliveries = store.deliveries.filter((item) => item.userId === userId);
  const counts = {};
  for (const delivery of deliveries)
    counts[delivery.status] = (counts[delivery.status] || 0) + 1;
  return { counts, backend, pendingSync: outbox.status().pending };
}

module.exports = {
  load,
  configured,
  publicConfig,
  enqueue,
  deliveryStatus,
  parseLinkCommand,
};
