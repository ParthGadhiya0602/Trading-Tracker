"use strict";

const { logWarn } = require("../core/logger");
const { STREAM_WS } = require("./env");

function loadFeedConfig() {
  if (!process.env.FEED_JSON) return null;
  try {
    const feed = JSON.parse(process.env.FEED_JSON);
    if (feed && feed.base && feed.indicesEndpoint) return feed;
  } catch (_) {}
  return null;
}

const FEED = loadFeedConfig();
const BASE = FEED ? FEED.base : null;
const FEED_REF = FEED && FEED.referer ? `${BASE}${FEED.referer}` : null;
const INDEX_URL = (name) =>
  `${BASE}${FEED.indicesEndpoint}${encodeURIComponent(name)}`;

function requireFeed() {
  if (!FEED)
    throw new Error(
      "data source not configured - set the FEED_JSON env var (see .env.sample)",
    );
}

function requireStream() {
  if (!STREAM_WS) return null;
  const stream = FEED && FEED.stream;
  if (!stream || !stream.wsBase || !stream.constituents) {
    logWarn(
      "stream",
      "STREAM_WS is set but `feed.stream` is missing/incomplete in FEED_JSON " +
        "(see .env.sample) - continuing in pure-REST mode.",
    );
    return null;
  }
  return stream;
}

module.exports = {
  loadFeedConfig,
  FEED,
  BASE,
  FEED_REF,
  INDEX_URL,
  requireFeed,
  requireStream,
};
