/**
 * C&C Financials - Upstox API v2 Live Market Data Service
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, '_cache/upstox-config.json');
const HISTORY_TTL_MS = 45_000;
const QUOTE_TTL_MS = 8_000;

export function istDateKey(unixSec) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(unixSec * 1000));
}

export function periodKey(unixSec, timeframe) {
  if (timeframe === '1M') return istDateKey(unixSec).slice(0, 7);
  if (timeframe === '1w') {
    const dayStart = Math.floor(new Date(`${istDateKey(unixSec)}T00:00:00+05:30`).getTime() / 1000);
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short'
    }).format(new Date(unixSec * 1000));
    const offset = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday] || 0;
    return istDateKey(dayStart - offset * 86400);
  }
  return istDateKey(unixSec);
}

function periodStartSec(unixSec, timeframe) {
  if (timeframe === '1M') {
    return Math.floor(new Date(`${istDateKey(unixSec).slice(0, 7)}-01T00:00:00+05:30`).getTime() / 1000);
  }
  if (timeframe === '1w') {
    return Math.floor(new Date(`${periodKey(unixSec, '1w')}T00:00:00+05:30`).getTime() / 1000);
  }
  return Math.floor(new Date(`${istDateKey(unixSec)}T00:00:00+05:30`).getTime() / 1000);
}

function quoteEpochSec(quote) {
  const ts = quote?.timestamp ?? quote?.last_trade_time;
  if (typeof ts === 'number') return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  if (typeof ts === 'string' && ts) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

export function intradayBarMinutes(timeframe) {
  const map = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '75m': 75, '125m': 125, '240m': 240 };
  return map[timeframe] || null;
}

// Historical Upstox candles stop at the last completed print. Fold the live
// quote into the forming bar so CMP, high, and low move during the session.
export function mergeLiveQuote(candles, quote, timeframe, barMinutes = null) {
  if (!Array.isArray(candles)) return [];
  if (!quote || quote.last_price == null) return candles.map(c => ({ ...c }));
  const ltp = Number(quote.last_price);
  if (!Number.isFinite(ltp) || ltp <= 0) return candles.map(c => ({ ...c }));

  const out = candles.map(c => ({ ...c }));
  const nowSec = quoteEpochSec(quote);
  const volume = Number(quote.volume) || 0;
  const ohlc = quote.ohlc || {};
  const qHigh = Number(ohlc.high);
  const qLow = Number(ohlc.low);

  if (timeframe === '1d' || timeframe === '1w' || timeframe === '1M') {
    const key = periodKey(nowSec, timeframe);
    const last = out[out.length - 1];
    if (last && periodKey(last.time, timeframe) === key) {
      last.high = Math.max(last.high, ltp, Number.isFinite(qHigh) ? qHigh : 0);
      last.low = Math.min(last.low, ltp, Number.isFinite(qLow) && qLow > 0 ? qLow : ltp);
      last.close = ltp;
      if (timeframe === '1d' && volume) last.volume = volume;
      last.source = 'upstox_live';
      return out;
    }
    const open = Number(ohlc.open) || ltp;
    out.push({
      time: periodStartSec(nowSec, timeframe),
      open,
      high: Math.max(Number.isFinite(qHigh) ? qHigh : 0, ltp, open),
      low: Math.min(Number.isFinite(qLow) && qLow > 0 ? qLow : ltp, ltp, open),
      close: ltp,
      volume,
      source: 'upstox_live'
    });
    return out;
  }

  const minutes = barMinutes || 1;
  const bucket = Math.floor(nowSec / (minutes * 60)) * (minutes * 60);
  const last = out[out.length - 1];
  if (last && last.time === bucket) {
    last.high = Math.max(last.high, ltp);
    last.low = Math.min(last.low, ltp);
    last.close = ltp;
    last.source = 'upstox_live';
    return out;
  }
  if (!last || bucket > last.time) {
    out.push({
      time: bucket,
      open: ltp,
      high: ltp,
      low: ltp,
      close: ltp,
      volume,
      source: 'upstox_live'
    });
  }
  return out;
}

class UpstoxService {
  constructor() {
    this.config = {
      accessToken: process.env.UPSTOX_ACCESS_TOKEN || '',
      apiKey: process.env.UPSTOX_API_KEY || '',
      apiSecret: process.env.UPSTOX_API_SECRET || '',
      isActive: false,
      lastValidated: null
    };
    this.historyCache = new Map();
    this.quoteCache = new Map();
    this.loadSavedConfig();
  }

  loadSavedConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        this.config = { ...this.config, ...saved };
      }
    } catch (e) {
      console.error('Error loading upstox-config:', e.message);
    }
    // Environment variables take precedence over cached config file
    if (process.env.UPSTOX_ACCESS_TOKEN) {
      this.config.accessToken = process.env.UPSTOX_ACCESS_TOKEN;
    }
    if (process.env.UPSTOX_API_KEY) {
      this.config.apiKey = process.env.UPSTOX_API_KEY;
    }
    if (process.env.UPSTOX_API_SECRET) {
      this.config.apiSecret = process.env.UPSTOX_API_SECRET;
    }
    if (this.config.accessToken) {
      this.config.isActive = true;
    }
  }

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    if (this.config.accessToken) {
      this.config.isActive = true;
      this.config.lastValidated = new Date().toISOString();
    }
    try {
      const cacheDir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (err) {
      console.warn('Could not persist upstox config to cache:', err.message);
    }
    return this.getStatus();
  }

  getStatus() {
    const isEnv = !!process.env.UPSTOX_ACCESS_TOKEN;
    return {
      configured: !!this.config.accessToken,
      isActive: this.config.isActive,
      maskedToken: this.config.accessToken ? `${this.config.accessToken.slice(0, 8)}...${this.config.accessToken.slice(-6)}` : null,
      lastValidated: this.config.lastValidated,
      source: isEnv ? 'environment' : (this.config.accessToken ? 'user_configured' : 'none')
    };
  }

  // Validate Token with Upstox API
  async validateToken(token) {
    const testToken = token || this.config.accessToken;
    if (!testToken) return { valid: false, message: 'No access token provided' };

    try {
      const res = await fetch('https://api.upstox.com/v2/user/profile', {
        headers: {
          'Authorization': `Bearer ${testToken}`,
          'Accept': 'application/json'
        }
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { valid: false, message: err.message || `Upstox authentication failed with status ${res.status}` };
      }

      const profile = await res.json();
      return {
        valid: true,
        user: profile.data?.user_name || profile.data?.email || 'Upstox Trader',
        profile: profile.data
      };
    } catch (e) {
      return { valid: false, message: e.message };
    }
  }

  // Helper to aggregate smaller candles into target minute intervals
  aggregateCandles(candles, targetMinutes) {
    if (!candles || !candles.length) return [];
    const targetSec = targetMinutes * 60;
    const grouped = new Map();
    for (const c of candles) {
      const bucketTime = Math.floor(c.time / targetSec) * targetSec;
      if (!grouped.has(bucketTime)) {
        grouped.set(bucketTime, {
          time: bucketTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume || 0,
          source: 'upstox_live'
        });
      } else {
        const g = grouped.get(bucketTime);
        g.high = Math.max(g.high, c.high);
        g.low = Math.min(g.low, c.low);
        g.close = c.close;
        g.volume += (c.volume || 0);
      }
    }
    return Array.from(grouped.values()).sort((a, b) => a.time - b.time);
  }

  // Fetch Live / Historical Candles from Upstox, then overlay the live quote.
  async getCandles(instrumentKey, timeframe = '1d') {
    const series = await this.getHistoricalSeries(instrumentKey, timeframe);
    let quote = null;
    try {
      const quotes = await this.getMarketQuotes([instrumentKey]);
      quote = Object.values(quotes)[0] || null;
    } catch (err) {
      console.warn(`Upstox quote overlay failed for ${instrumentKey}: ${err.message}`);
    }
    return mergeLiveQuote(series, quote, timeframe, intradayBarMinutes(timeframe));
  }

  async getHistoricalSeries(instrumentKey, timeframe = '1d') {
    if (!this.config.accessToken) {
      throw new Error('Upstox Access Token is not configured');
    }

    const cacheKey = `${instrumentKey}|${timeframe}`;
    const cached = this.historyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HISTORY_TTL_MS) {
      return cached.candles.map(c => ({ ...c }));
    }

    const encodedKey = encodeURIComponent(instrumentKey);
    const today = new Date();
    const toDate = today.toISOString().split('T')[0];

    let interval = 'day';
    let url = '';
    let targetAggregateMinutes = null;

    if (timeframe === '1w') {
      interval = 'week';
      url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/week/${toDate}`;
    } else if (timeframe === '1M') {
      interval = 'month';
      url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/month/${toDate}`;
    } else if (timeframe === '5m' || timeframe === '15m' || timeframe === '1m') {
      // 1-minute base data for intraday (safe 10-day range permitted by Upstox API)
      interval = '1minute';
      const past10 = new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/1minute/${toDate}/${past10}`;
      if (timeframe === '5m') targetAggregateMinutes = 5;
      if (timeframe === '15m') targetAggregateMinutes = 15;
    } else if (timeframe === '30m' || timeframe === '60m' || timeframe === '75m' || timeframe === '125m' || timeframe === '240m') {
      // 30-minute base data for multi-hour and 75m bars (safe 60-day range permitted by Upstox API)
      interval = '30minute';
      const past60 = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/30minute/${toDate}/${past60}`;
      if (timeframe === '60m') targetAggregateMinutes = 60;
      if (timeframe === '75m') targetAggregateMinutes = 75;
      if (timeframe === '125m') targetAggregateMinutes = 125;
      if (timeframe === '240m') targetAggregateMinutes = 240;
    } else {
      // Default: daily candles with full historical depth (omitting fromDate yields up to 2,480 bars)
      interval = 'day';
      url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/day/${toDate}`;
    }

    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${this.config.accessToken}`
    };

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Upstox Candle API Error (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    const rawCandles = data.data?.candles || [];

    // Convert Upstox candle format: [timestamp_iso, open, high, low, close, volume, open_interest]
    const formatted = rawCandles.map(c => {
      const timeSec = Math.floor(new Date(c[0]).getTime() / 1000);
      return {
        time: timeSec,
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]) || 0,
        source: 'upstox_live'
      };
    }).sort((a, b) => a.time - b.time);

    // If an aggregated timeframe is requested, resample cleanly
    let series = formatted;
    if (targetAggregateMinutes && targetAggregateMinutes > 1) {
      series = this.aggregateCandles(formatted, targetAggregateMinutes);
    }

    this.historyCache.set(cacheKey, { at: Date.now(), candles: series });
    return series.map(c => ({ ...c }));
  }

  // Fetch Live Market Quotes (LTP, OHLC, volume). Recent quotes are reused for a few seconds.
  async getMarketQuotes(instrumentKeys = []) {
    if (!this.config.accessToken || !instrumentKeys.length) return {};

    const now = Date.now();
    const merged = {};
    const missing = [];
    for (const key of instrumentKeys) {
      const hit = this.quoteCache.get(key);
      if (hit && now - hit.at < QUOTE_TTL_MS) {
        merged[hit.responseKey] = hit.quote;
      } else {
        missing.push(key);
      }
    }

    if (!missing.length) return merged;

    const keysStr = missing.map(k => encodeURIComponent(k)).join(',');
    const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${keysStr}`;

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${this.config.accessToken}`
      }
    });

    if (!res.ok) return merged;
    const data = await res.json();
    const fresh = data.data || {};
    for (const [responseKey, quote] of Object.entries(fresh)) {
      const requestKey = missing.find(k => k === responseKey || k.replace('|', ':') === responseKey) || responseKey.replace(':', '|');
      this.quoteCache.set(requestKey, { at: now, quote, responseKey });
      merged[responseKey] = quote;
    }
    return merged;
  }
}

export const upstox = new UpstoxService();
