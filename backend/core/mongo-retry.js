"use strict";

async function connectMongoWithRetry(uri, options = {}) {
  const retries = Math.max(0, Number(options.retries) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);
  const serverSelectionTimeoutMS = Math.max(
    1,
    Number(options.serverSelectionTimeoutMS) || 8000,
  );
  const MongoClientClass =
    options.MongoClientClass || require("mongodb").MongoClient;
  const waitFor =
    options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const client = new MongoClientClass(uri, { serverSelectionTimeoutMS });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      try {
        await client.close();
      } catch (_) {}
      if (attempt >= retries) break;
      if (options.onRetry) {
        options.onRetry({
          error,
          retry: attempt + 1,
          retries,
          retryDelayMs,
        });
      }
      await waitFor(retryDelayMs);
    }
  }

  throw lastError || new Error("MongoDB connection failed");
}

module.exports = { connectMongoWithRetry };
