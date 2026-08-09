"use strict";

/**
 * Provider-agnostic LLM pre-market analysis.
 *
 * Reads its own `llm` block from config.json (like telegram.js). During pre-open
 * (09:00-09:15 IST) server.js fires analyze(payload) fire-and-forget; this module
 * batches the pre-open data into LLM prompts and caches per-stock signals
 * (bullish/bearish/neutral + confidence + reasoning) for the trading day.
 *
 * Zero npm dependencies - uses Node 18+ built-in fetch. Provider is swapped via
 * config (openai | anthropic | gemini); missing/disabled block = feature dormant.
 */

const { istNow } = require("./utils");

const BATCH_SIZE = 25; // stocks per LLM call
const CALL_TIMEOUT_MS = 30_000;

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-opus-4-8",
  gemini: "gemini-1.5-flash",
};

const SYSTEM_PROMPT = `You are a quantitative pre-market analyst for the Indian stock market (NSE).
You analyze pre-open auction data (09:00-09:15 IST) to produce directional signals
for the upcoming continuous trading session (09:15-15:30 IST).

For each stock provided, assess the pre-open data and produce:
- "signal": one of "bullish", "bearish", or "neutral"
- "confidence": an integer from 0 to 100
- "reasoning": 1-2 concise sentences explaining the signal

Key factors to weigh:
1. GAP: IEP vs previous close (direction and magnitude of the opening gap)
2. PRESSURE: totalBuyQty vs totalSellQty ratio (>1.5 = buy pressure, <0.67 = sell pressure)
3. ATO IMBALANCE: at-the-open order flow direction
4. DEPTH ASYMMETRY: distribution of buy vs sell quantities across the order book
5. PRICE POSITION: how the IEP relates to the 52-week high/low range

Respond with ONLY a valid JSON object (no markdown fences, no text outside JSON):
{ "signals": { "SYMBOL": { "signal": "...", "confidence": N, "reasoning": "..." } } }`;

// --- module state ---
let config = null; // { provider, apiKey, model, temperature, maxTokens }
let analysisCache = null; // { date, analyzedAt, marketStatus, stocks:{}, meta:{} }
let analyzing = false; // mutex: one LLM run at a time
let lastError = null; // set when a run fails with no cache produced
let logError = () => {};

// Config source: ENVIRONMENT VARIABLES only.
//   LLM_PROVIDER   openai | anthropic | gemini
//   LLM_API_KEY    the provider key (feature is dormant until this is set)
//   LLM_MODEL      optional (defaults per provider)
//   LLM_TEMPERATURE / LLM_MAX_TOKENS  optional
//   LLM_ENABLED    optional; set to "false" to force off even with a key
// No key/provider -> returns null -> feature stays off. config.json is NOT read.
function readConfig() {
  const provider = String(process.env.LLM_PROVIDER || "").toLowerCase().trim();
  const apiKey = String(process.env.LLM_API_KEY || "").trim();
  if (!apiKey || !provider) return null;
  if (String(process.env.LLM_ENABLED).toLowerCase() === "false") return null;
  if (!DEFAULT_MODELS[provider]) return null;
  return {
    provider,
    apiKey,
    model: String(process.env.LLM_MODEL || DEFAULT_MODELS[provider]).trim(),
    temperature: Number.isFinite(Number(process.env.LLM_TEMPERATURE))
      ? Number(process.env.LLM_TEMPERATURE)
      : 0.3,
    maxTokens: Number(process.env.LLM_MAX_TOKENS) || 1024,
  };
}

function load(options = {}) {
  if (options.logError) logError = options.logError;
  config = readConfig();
  return configured();
}

function configured() {
  return config !== null;
}

function todayIST() {
  return istNow().slice(0, 10); // YYYY-MM-DD
}

// ---------------- provider abstraction ----------------

async function callLLM(systemPrompt, userPrompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    if (config.provider === "openai") return await callOpenAI(systemPrompt, userPrompt, ctrl.signal);
    if (config.provider === "anthropic") return await callAnthropic(systemPrompt, userPrompt, ctrl.signal);
    if (config.provider === "gemini") return await callGemini(systemPrompt, userPrompt, ctrl.signal);
    return null;
  } catch (error) {
    logError("llm.call", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function httpJson(url, init, signal) {
  const response = await fetch(url, { ...init, signal });
  let body = {};
  try {
    body = await response.json();
  } catch (_) {}
  if (!response.ok) {
    const desc = (body && (body.error?.message || body.error || body.message)) || `HTTP ${response.status}`;
    throw new Error(typeof desc === "string" ? desc : JSON.stringify(desc));
  }
  return body;
}

async function callOpenAI(systemPrompt, userPrompt, signal) {
  const body = await httpJson(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    },
    signal,
  );
  return {
    text: body.choices?.[0]?.message?.content || "",
    promptTokens: body.usage?.prompt_tokens || 0,
    completionTokens: body.usage?.completion_tokens || 0,
  };
}

async function callAnthropic(systemPrompt, userPrompt, signal) {
  const body = await httpJson(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    },
    signal,
  );
  return {
    text: (body.content || []).map((b) => b.text || "").join(""),
    promptTokens: body.usage?.input_tokens || 0,
    completionTokens: body.usage?.output_tokens || 0,
  };
}

async function callGemini(systemPrompt, userPrompt, signal) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const body = await httpJson(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: config.maxTokens,
          responseMimeType: "application/json",
        },
      }),
    },
    signal,
  );
  const parts = body.candidates?.[0]?.content?.parts || [];
  return {
    // thinking models may return reasoning as `thought:true` parts - keep only
    // the answer parts so they don't pollute the JSON we parse
    text: parts
      .filter((p) => !p.thought)
      .map((p) => p.text || "")
      .join(""),
    promptTokens: body.usageMetadata?.promptTokenCount || 0,
    completionTokens: body.usageMetadata?.candidatesTokenCount || 0,
  };
}

// ---------------- prompt construction ----------------

// Flatten all dashboard indices into one de-duplicated stock list. Only stocks
// carrying a preOpen order book are worth analyzing.
function collectPreOpenStocks(payload) {
  const seen = new Set();
  const stocks = [];
  for (const index of Object.keys(payload || {})) {
    for (const row of (payload[index] && payload[index].data) || []) {
      if (!row || !row.symbol || seen.has(row.symbol)) continue;
      if (!row.preOpen) continue;
      seen.add(row.symbol);
      stocks.push(row);
    }
  }
  return stocks;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmtNum(n) {
  return Number.isFinite(Number(n)) ? Number(n) : "-";
}

function buildUserPrompt(batch) {
  const blocks = batch.map((r) => {
    const po = r.preOpen || {};
    const buy = fmtNum(po.totalBuyQty);
    const sell = fmtNum(po.totalSellQty);
    const ratio =
      Number(po.totalSellQty) > 0 ? (Number(po.totalBuyQty) / Number(po.totalSellQty)).toFixed(2) : "-";
    const ladder = (po.ladder || [])
      .map((l) => `  ${fmtNum(l.price)} | ${fmtNum(l.buyQty)} | ${fmtNum(l.sellQty)}`)
      .join("\n");
    return [
      `=== ${r.symbol} ===`,
      `IEP: ${fmtNum(r.open)} | Prev Close: ${fmtNum(r.prevClose)} | Change: ${fmtNum(r.change)} (${fmtNum(r.pChange)}%)`,
      `Buy Qty: ${buy} | Sell Qty: ${sell} | B/S Ratio: ${ratio}`,
      `ATO Buy: ${fmtNum(po.ato && po.ato.buyQty)} | ATO Sell: ${fmtNum(po.ato && po.ato.sellQty)}`,
      `Matched Qty: ${fmtNum(po.finalQty)}`,
      `52W High: ${fmtNum(r.yearHigh)} | 52W Low: ${fmtNum(r.yearLow)}`,
      ladder ? `Order Book (price | buyQty | sellQty):\n${ladder}` : "Order Book: n/a",
    ].join("\n");
  });
  return `Pre-open auction data snapshot (${istNow()}):\n\n${blocks.join("\n\n")}\n\nAnalyze each stock above and return the signals JSON.`;
}

// ---------------- response parsing ----------------

const SIGNALS = new Set(["bullish", "bearish", "neutral"]);

function parseResponse(text) {
  const out = {};
  let parsed;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (_) {
    return out;
  }
  const signals = parsed && parsed.signals;
  if (!signals || typeof signals !== "object") return out;
  for (const sym of Object.keys(signals)) {
    const s = signals[sym] || {};
    const signal = String(s.signal || "").toLowerCase().trim();
    if (!SIGNALS.has(signal)) continue;
    let confidence = Math.round(Number(s.confidence));
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(100, confidence));
    const reasoning = String(s.reasoning || "").trim().slice(0, 500);
    out[sym.toUpperCase()] = { signal, confidence, reasoning };
  }
  return out;
}

function stripFences(text) {
  const t = String(text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : t;
}

// ---------------- top-level analyze ----------------

async function analyze(payload) {
  if (!configured() || analyzing) return;
  const today = todayIST();
  if (analysisCache && analysisCache.date === today) return; // already done today

  analyzing = true;
  const startMs = Date.now();
  try {
    const stocks = collectPreOpenStocks(payload);
    if (!stocks.length) return;

    const snapshotBySym = new Map(stocks.map((r) => [r.symbol.toUpperCase(), r]));
    const signals = {};
    let promptTokens = 0;
    let completionTokens = 0;

    for (const batch of chunk(stocks, BATCH_SIZE)) {
      const result = await callLLM(SYSTEM_PROMPT, buildUserPrompt(batch));
      if (!result) continue;
      const parsed = parseResponse(result.text);
      Object.assign(signals, parsed);
      promptTokens += result.promptTokens || 0;
      completionTokens += result.completionTokens || 0;
    }

    if (!Object.keys(signals).length) {
      lastError = "no signals parsed from LLM response";
      return; // leave cache empty; status -> error, next tick retries
    }

    const analyzedAt = istNow();
    const stocksOut = {};
    for (const sym of Object.keys(signals)) {
      const snap = snapshotBySym.get(sym) || {};
      stocksOut[sym] = {
        symbol: sym,
        ...signals[sym],
        iep: Number.isFinite(Number(snap.open)) ? Number(snap.open) : null,
        prevClose: Number.isFinite(Number(snap.prevClose)) ? Number(snap.prevClose) : null,
        pChange: Number.isFinite(Number(snap.pChange)) ? Number(snap.pChange) : null,
        analyzedAt,
      };
    }

    lastError = null;
    analysisCache = {
      date: today,
      analyzedAt,
      marketStatus: "Pre-open",
      stocks: stocksOut,
      meta: {
        provider: config.provider,
        model: config.model,
        promptTokens,
        completionTokens,
        durationMs: Date.now() - startMs,
        count: Object.keys(stocksOut).length,
      },
    };
  } catch (error) {
    lastError = String((error && error.message) || error);
    logError("llm.analyze", error);
  } finally {
    analyzing = false;
  }
}

// ---------------- readers ----------------

function getAnalysis(symbol) {
  if (!analysisCache) return null;
  return analysisCache.stocks[String(symbol || "").toUpperCase()] || null;
}

function getStatus() {
  if (!configured()) return "unavailable";
  if (analysisCache) return "ready";
  if (lastError) return "error";
  return "pending";
}

function cacheDate() {
  return analysisCache ? analysisCache.date : null;
}

function lastErrorMessage() {
  return lastError;
}

function clearCache() {
  analysisCache = null;
  lastError = null;
}

module.exports = {
  load,
  configured,
  analyze,
  getAnalysis,
  getStatus,
  cacheDate,
  lastErrorMessage,
  clearCache,
};
