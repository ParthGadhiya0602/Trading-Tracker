"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { istNow } = require("./utils");

class DurableOutbox {
  constructor(file, options = {}) {
    this.file = file;
    this.logError = options.logError || (() => {});
    this.operations = this.read();
    this.processor = null;
    this.draining = false;
    this.timer = null;
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(data.operations) ? data.operations : [];
    } catch (_) {
      return [];
    }
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ operations: this.operations }, null, 2));
    fs.renameSync(temp, this.file);
  }

  setProcessor(processor) {
    this.processor = typeof processor === "function" ? processor : null;
    if (this.processor && this.operations.length) this.schedule(0);
  }

  enqueue(type, payload, options = {}) {
    const dedupeKey = options.dedupeKey || null;
    if (dedupeKey) {
      const pending = this.operations.find((item) => item.dedupeKey === dedupeKey);
      if (pending) {
        pending.type = type;
        pending.payload = payload;
        pending.updatedAt = istNow();
        pending.attempts = 0;
        pending.lastError = null;
        this.write();
        this.schedule(0);
        return pending.operationId;
      }
    }
    const now = istNow();
    const operation = {
      operationId: crypto.randomUUID(),
      type,
      payload,
      dedupeKey,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      lastError: null,
    };
    this.operations.push(operation);
    this.write();
    this.schedule(0);
    return operation.operationId;
  }

  schedule(delayMs) {
    if (!this.processor || this.draining || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  async drain() {
    if (!this.processor || this.draining) return;
    this.draining = true;
    try {
      while (this.processor && this.operations.length) {
        const operation = this.operations[0];
        try {
          await this.processor(operation);
          this.operations.shift();
          this.write();
        } catch (error) {
          operation.attempts += 1;
          operation.lastError = String((error && error.message) || error);
          operation.updatedAt = istNow();
          this.write();
          this.logError("outbox.replay", operation.lastError);
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(operation.attempts, 6));
          this.schedule(delay);
          break;
        }
      }
    } finally {
      this.draining = false;
      if (this.operations.length) this.schedule(1000);
    }
  }

  status() {
    return {
      pending: this.operations.length,
      oldestAt: this.operations.length ? this.operations[0].createdAt : null,
      lastError: this.operations.length ? this.operations[0].lastError : null,
    };
  }
}

module.exports = { DurableOutbox };
