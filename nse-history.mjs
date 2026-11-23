/**
 * Daily NSE history for every equity in the instrument master.
 * Upstox is used when a token is connected. Otherwise each symbol is loaded
 * from Yahoo's public NSE series (SYMBOL.NS) and stored under _cache/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '_cache');
const DATA_DIR = path.join(__dirname, 'data');
const FRESH_MS = 12 * 60 * 60 * 1000;
const FAILED_RETRY_MS = 6 * 60 * 60 * 1000;

const inflight = new Map();
const syncState = {
  running: false,
  total: 0,
  completed: 0,
  saved: 0,
  failed: 0,
  lastSymbol: null,
  startedAt: null,
  finishedAt: null,
  message: 'Not started'
};

function istDateKey(unixSec) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(unixSec * 1000));
}

function safeSymbol(symbol) {
  const cleaned = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.&-]{0,30}$/.test(cleaned)) return null;
  return cleaned;
}

function cachePath(symbol) {
  return path.join(CACHE_DIR, `candles-${symbol}-1d.json`);
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readStored(symbol) {
  return readJson(cachePath(symbol)) || readJson(path.join(DATA_DIR, `candles-${symbol}-1d.json`));
}

function isFresh(payload) {
  if (!payload) return false;
  const at = Date.parse(payload.fetchedAt || '');
  if (!Number.isFinite(at)) return false;
  const age = Date.now() - at;
  if (payload.error) return age < FAILED_RETRY_MS;
  return age < FRESH_MS && Array.isArray(payload.candles) && payload.candles.length > 0;
}

function writeStored(symbol, payload) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const temp = `${cachePath(symbol)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload));
  fs.renameSync(temp, cachePath(symbol));
}

async function fetchYahooDaily(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?interval=1d&range=5y&includeAdjustedClose=false`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    }
  });
  if (res.status === 429) {
    const error = new Error('Yahoo rate limit');
    error.code = 'RATE_LIMIT';
    throw error;
  }
  if (!res.ok) throw new Error(`Yahoo history ${res.status} for ${symbol}`);
  const body = await res.json();
  const result = body.chart?.result?.[0];
  const error = body.chart?.error;
  if (!result || error) {
    throw new Error(error?.description || `No NSE history for ${symbol}`);
  }
  const stamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < stamps.length; i++) {
    const open = Number(quote.open?.[i]);
    const high = Number(quote.high?.[i]);
    const low = Number(quote.low?.[i]);
    const close = Number(quote.close?.[i]);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    const px = (value) => Math.round(value * 100) / 100;
    candles.push({
      time: stamps[i],
      open: px(open),
      high: px(high),
      low: px(low),
      close: px(close),
      volume: Number(quote.volume?.[i]) || 0,
      source: 'yahoo_nse'
    });
  }
  candles.sort((a, b) => a.time - b.time);
  if (!candles.length) throw new Error(`No NSE bars for ${symbol}`);
  return candles;
}

export async function ensureDailyHistory(symbol) {
  const key = safeSymbol(symbol);
  if (!key) return { symbol, candles: [], source: 'unavailable', error: 'Invalid symbol' };
  if (inflight.has(key)) return inflight.get(key);

  const job = loadDaily(key).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function loadDaily(symbol) {
  const stored = readStored(symbol);
  if (isFresh(stored)) {
    return {
      symbol,
      candles: stored.candles || [],
      source: stored.source || 'cache',
      fetchedAt: stored.fetchedAt,
      error: stored.error || null
    };
  }

  try {
    const candles = await fetchYahooDaily(symbol);
    const payload = {
      symbol,
      timeframe: '1d',
      source: 'yahoo_nse',
      fetchedAt: new Date().toISOString(),
      candles
    };
    writeStored(symbol, payload);
    return { symbol, candles, source: 'yahoo_nse', fetchedAt: payload.fetchedAt, error: null };
  } catch (err) {
    if (stored?.candles?.length && err.code !== 'RATE_LIMIT') {
      return { symbol, candles: stored.candles, source: stored.source || 'cache', fetchedAt: stored.fetchedAt || null, error: null };
    }
    if (err.code !== 'RATE_LIMIT') {
      writeStored(symbol, {
        symbol,
        timeframe: '1d',
        source: 'yahoo_nse',
        fetchedAt: new Date().toISOString(),
        candles: [],
        error: err.message
      });
    }
    return { symbol, candles: stored?.candles || [], source: 'unavailable', fetchedAt: null, error: err.message, rateLimited: err.code === 'RATE_LIMIT' };
  }
}

function bucketStart(unixSec, timeframe) {
  const key = istDateKey(unixSec);
  const [year, month, day] = key.split('-').map(Number);
  let monthIndex = month;
  let dayOfMonth = 1;
  if (timeframe === '1w') {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date(unixSec * 1000));
    const offset = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday] || 0;
    return Math.floor(new Date(`${key}T00:00:00+05:30`).getTime() / 1000) - offset * 86400;
  }
  if (timeframe === '3M') monthIndex = Math.floor((month - 1) / 3) * 3 + 1;
  else if (timeframe === '6M') monthIndex = month <= 6 ? 1 : 7;
  else if (timeframe === '1Y') monthIndex = 1;
  else if (timeframe !== '1M') dayOfMonth = day;
  const mm = String(monthIndex).padStart(2, '0');
  const dd = String(timeframe === '1d' ? day : dayOfMonth).padStart(2, '0');
  return Math.floor(new Date(`${year}-${mm}-${dd}T00:00:00+05:30`).getTime() / 1000);
}

const HIGHER = new Set(['1d', '1w', '1M', '3M', '6M', '1Y']);

export function aggregateDaily(candles, timeframe) {
  if (!timeframe || timeframe === '1d') return candles || [];
  if (!HIGHER.has(timeframe)) return null;
  const grouped = new Map();
  for (const candle of candles || []) {
    const time = bucketStart(candle.time, timeframe);
    const prev = grouped.get(time);
    if (!prev) {
      grouped.set(time, { ...candle, time });
    } else {
      prev.high = Math.max(prev.high, candle.high);
      prev.low = Math.min(prev.low, candle.low);
      prev.close = candle.close;
      prev.volume = (prev.volume || 0) + (candle.volume || 0);
    }
  }
  return [...grouped.values()].sort((a, b) => a.time - b.time);
}

export function isIntradayTimeframe(timeframe) {
  return !HIGHER.has(timeframe);
}

export function getSyncStatus() {
  return { ...syncState };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function startEquitySync(symbols, options = {}) {
  if (syncState.running) return getSyncStatus();
  const list = [...new Set((symbols || []).map(safeSymbol).filter(Boolean))];
  syncState.running = true;
  syncState.total = list.length;
  syncState.completed = 0;
  syncState.saved = 0;
  syncState.failed = 0;
  syncState.lastSymbol = null;
  syncState.startedAt = new Date().toISOString();
  syncState.finishedAt = null;
  syncState.message = `Saving daily history for ${list.length} NSE stocks`;
  options.onProgress?.(getSyncStatus());

  const concurrency = 2;
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      const symbol = list[index];
      let result = await ensureDailyHistory(symbol);
      if (result.rateLimited) {
        await sleep(8000);
        result = await ensureDailyHistory(symbol);
      }
      syncState.completed += 1;
      syncState.lastSymbol = symbol;
      if (result.candles?.length) syncState.saved += 1;
      else syncState.failed += 1;
      syncState.message = `NSE history ${syncState.saved}/${syncState.total} saved` + (syncState.failed ? `, ${syncState.failed} unavailable` : '');
      if (syncState.completed === 1 || syncState.completed % 25 === 0 || syncState.completed === syncState.total) {
        options.onProgress?.(getSyncStatus());
      }
      await sleep(350);
    }
  }

  Promise.all(Array.from({ length: concurrency }, () => worker()))
    .then(() => {
      syncState.running = false;
      syncState.finishedAt = new Date().toISOString();
      syncState.message = `NSE history ready: ${syncState.saved} stocks saved, ${syncState.failed} unavailable`;
      options.onProgress?.(getSyncStatus());
    })
    .catch((err) => {
      syncState.running = false;
      syncState.finishedAt = new Date().toISOString();
      syncState.message = `NSE history stopped: ${err.message}`;
      options.onProgress?.(getSyncStatus());
    });

  return getSyncStatus();
}
