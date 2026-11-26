/**
 * ZoneMatrix Pro - Upstox API v2 Live Market Data Service
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, '_cache/upstox-config.json');
const ENV_FILE = path.join(__dirname, '.env');
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

/**
 * Safely update .env file key-value pairs
 */
function updateEnvFile(keyValues) {
  try {
    let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    for (const [key, val] of Object.entries(keyValues)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${val}`);
      } else {
        content += (content && !content.endsWith('\n') ? '\n' : '') + `${key}=${val}\n`;
      }
    }
    fs.writeFileSync(ENV_FILE, content, 'utf8');
  } catch (err) {
    console.warn('Could not update .env file:', err.message);
  }
}

/**
 * Inspect token structure and expiration (Supports 1-Year Analytics Token and Daily OAuth Tokens)
 */
export function inspectToken(token) {
  if (!token) {
    return { configured: false, isValid: false, isExpired: false, tokenType: 'none', reason: 'No token configured' };
  }
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      const nowSec = Math.floor(Date.now() / 1000);
      const expDate = payload.exp ? new Date(payload.exp * 1000) : null;
      const isExpired = payload.exp && payload.exp <= nowSec;
      const hoursRemaining = payload.exp ? (payload.exp - nowSec) / 3600 : null;
      // Analytics tokens are issued for ~1 year (365 days / ~8760 hrs).
      // Standard OAuth tokens are issued for 1 trading day (expires at 3:30 AM).
      const isLongLived = hoursRemaining == null || hoursRemaining > 48;
      const tokenType = isLongLived ? 'Analytics Token (1-Year Long-Lived)' : 'Standard Access Token (Daily 3:30 AM)';

      if (isExpired) {
        return {
          configured: true,
          isValid: false,
          isExpired: true,
          tokenType,
          isAnalytics: isLongLived,
          userId: payload.sub || null,
          expiresAt: expDate.toISOString(),
          reason: `Upstox token expired on ${expDate.toLocaleDateString('en-IN')} at ${expDate.toLocaleTimeString('en-IN')}. Please generate a new Analytics Token in Upstox Developer Console.`
        };
      }
      return {
        configured: true,
        isValid: true,
        isExpired: false,
        tokenType,
        isAnalytics: isLongLived,
        userId: payload.sub || null,
        expiresAt: expDate ? expDate.toISOString() : null,
        reason: isLongLived ? 'Long-lived Analytics Token active (No daily 3:30 AM expiration)' : 'Standard Access Token active'
      };
    }
  } catch {
    // Non-standard format or opaque token
  }
  return {
    configured: true,
    isValid: true,
    isExpired: false,
    tokenType: 'Analytics Token (Long-Lived)',
    isAnalytics: true,
    reason: 'Token structure recognized'
  };
}

class UpstoxService {
  constructor() {
    this.config = {
      accessToken: process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || '',
      apiKey: process.env.UPSTOX_API_KEY || '',
      apiSecret: process.env.UPSTOX_API_SECRET || '',
      userName: '',
      isActive: false,
      isExpired: false,
      error: null,
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

    // Environment variables take precedence (check UPSTOX_ANALYTICS_TOKEN first, then UPSTOX_ACCESS_TOKEN)
    const envToken = process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN;
    if (envToken) {
      this.config.accessToken = envToken;
    }
    if (process.env.UPSTOX_API_KEY) {
      this.config.apiKey = process.env.UPSTOX_API_KEY;
    }
    if (process.env.UPSTOX_API_SECRET) {
      this.config.apiSecret = process.env.UPSTOX_API_SECRET;
    }

    // Inspect the token immediately
    const tokenInfo = inspectToken(this.config.accessToken);
    if (!this.config.accessToken) {
      this.config.isActive = false;
      this.config.isExpired = false;
      this.config.error = null;
    } else if (tokenInfo.isExpired) {
      this.config.isActive = false;
      this.config.isExpired = true;
      this.config.error = tokenInfo.reason;
    } else {
      this.config.isActive = true;
      this.config.isExpired = false;
      this.config.error = null;
    }
  }

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };

    const tokenInfo = inspectToken(this.config.accessToken);
    if (!this.config.accessToken) {
      this.config.isActive = false;
      this.config.isExpired = false;
      this.config.error = null;
    } else if (tokenInfo.isExpired) {
      this.config.isActive = false;
      this.config.isExpired = true;
      this.config.error = tokenInfo.reason;
    } else {
      this.config.isActive = true;
      this.config.isExpired = false;
      this.config.error = null;
      this.config.lastValidated = new Date().toISOString();
    }

    // Persist to .env and process.env (saves both UPSTOX_ANALYTICS_TOKEN and UPSTOX_ACCESS_TOKEN for compatibility)
    const envUpdates = {};
    if (newConfig.accessToken !== undefined) {
      envUpdates.UPSTOX_ANALYTICS_TOKEN = newConfig.accessToken;
      envUpdates.UPSTOX_ACCESS_TOKEN = newConfig.accessToken;
    }
    if (newConfig.apiKey !== undefined) envUpdates.UPSTOX_API_KEY = newConfig.apiKey;
    if (newConfig.apiSecret !== undefined) envUpdates.UPSTOX_API_SECRET = newConfig.apiSecret;
    if (Object.keys(envUpdates).length > 0) {
      updateEnvFile(envUpdates);
      for (const [k, v] of Object.entries(envUpdates)) {
        process.env[k] = v;
      }
    }

    // Persist to cache file
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
    const isEnv = !!(process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN);
    const tokenInfo = inspectToken(this.config.accessToken);
    const isActuallyExpired = this.config.isExpired || tokenInfo.isExpired;

    return {
      configured: !!this.config.accessToken,
      isActive: this.config.isActive && !isActuallyExpired,
      isExpired: isActuallyExpired,
      tokenType: tokenInfo.tokenType || (tokenInfo.isAnalytics ? 'Analytics Token (1-Year)' : 'Standard Access Token'),
      isAnalytics: tokenInfo.isAnalytics ?? true,
      expiresAt: tokenInfo.expiresAt || null,
      userId: this.config.userName || tokenInfo.userId || 'Upstox Trader',
      error: this.config.error || (isActuallyExpired ? tokenInfo.reason : null),
      maskedToken: this.config.accessToken ? `${this.config.accessToken.slice(0, 8)}...${this.config.accessToken.slice(-6)}` : null,
      lastValidated: this.config.lastValidated,
      source: isEnv ? 'environment' : (this.config.accessToken ? 'user_configured' : 'none')
    };
  }

  // Validate Token with Upstox API
  async validateToken(token) {
    const testToken = token || this.config.accessToken;
    if (!testToken) return { valid: false, message: 'No access token or analytics token provided' };

    const tokenInfo = inspectToken(testToken);
    if (tokenInfo.isExpired) {
      this.config.isActive = false;
      this.config.isExpired = true;
      this.config.error = tokenInfo.reason;
      return { valid: false, message: tokenInfo.reason, isExpired: true };
    }

    try {
      // Step 1: Validate against Upstox Market Data API.
      // Market data endpoints (quotes/LTP) work with both 1-year Analytics Tokens and daily OAuth tokens
      // from any server or IP, without requiring a static IP whitelist.
      const quoteRes = await fetch('https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_INDEX|Nifty 50', {
        headers: {
          'Authorization': `Bearer ${testToken}`,
          'Accept': 'application/json'
        }
      });

      if (!quoteRes.ok) {
        const err = await quoteRes.json().catch(() => ({}));
        const msg = err.errors?.[0]?.message || err.message || `Upstox authentication failed with status ${quoteRes.status}`;
        if (quoteRes.status === 401) {
          this.config.isActive = false;
          this.config.isExpired = true;
          this.config.error = msg;
        }
        return { valid: false, message: msg, status: quoteRes.status };
      }

      // Step 2: Optionally fetch user profile to display account name (works if OAuth token or static IP whitelisted).
      // If 403 or unavailable, we still consider the token valid for analytics & market data.
      let userName = tokenInfo.userId || 'Upstox Analytics User';
      let profileData = null;
      try {
        const profileRes = await fetch('https://api.upstox.com/v2/user/profile', {
          headers: {
            'Authorization': `Bearer ${testToken}`,
            'Accept': 'application/json'
          }
        });
        if (profileRes.ok) {
          const profile = await profileRes.json();
          userName = profile.data?.user_name || profile.data?.email || userName;
          profileData = profile.data;
        }
      } catch {}

      this.config.isActive = true;
      this.config.isExpired = false;
      this.config.userName = userName;
      this.config.error = null;
      this.config.lastValidated = new Date().toISOString();

      return {
        valid: true,
        user: userName,
        profile: profileData,
        tokenType: tokenInfo.tokenType,
        isAnalytics: tokenInfo.isAnalytics
      };
    } catch (e) {
      return { valid: false, message: e.message };
    }
  }

  // Exchange OAuth Authorization Code for Access Token
  async exchangeCodeForToken(code, apiKey, apiSecret, redirectUri) {
    try {
      const bodyParams = new URLSearchParams({
        code,
        client_id: apiKey,
        client_secret: apiSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      });

      const res = await fetch('https://api.upstox.com/v2/login/authorization/token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: bodyParams.toString()
      });

      const data = await res.json();
      if (!res.ok || !data.access_token) {
        return {
          success: false,
          error: data.errors?.[0]?.message || data.message || 'Failed to exchange authorization code with Upstox'
        };
      }

      const accessToken = data.access_token;
      const userName = data.user_name || data.email || 'Upstox Trader';

      this.saveConfig({
        accessToken,
        apiKey,
        apiSecret,
        userName,
        isActive: true,
        isExpired: false,
        error: null,
        lastValidated: new Date().toISOString()
      });

      return {
        success: true,
        message: `Successfully connected to Upstox account (${userName})`,
        user: userName,
        status: this.getStatus()
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Helper to fetch and parse candles from an Upstox URL
  async fetchCandlesUrl(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 401) {
        this.config.isActive = false;
        this.config.isExpired = true;
        this.config.error = 'Upstox Token has expired or is invalid (401 Unauthorized). Please update your Analytics Token in settings.';
      }
      const errorText = await res.text();
      throw new Error(`Upstox Candle API Error (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    const rawCandles = data.data?.candles || [];

    return rawCandles.map(c => {
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
  }

  // Merge historical and today's intraday candle lists
  mergeCandles(arr1 = [], arr2 = []) {
    const map = new Map();
    for (const c of arr1) map.set(c.time, c);
    for (const c of arr2) map.set(c.time, c);
    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }

  // Merge or update the latest daily candle with today's live session data
  mergeDailyCandle(historicalCandles, todayCandle) {
    if (!historicalCandles || !historicalCandles.length) return [todayCandle];
    if (!todayCandle) return historicalCandles;

    const list = [...historicalCandles];
    const last = list[list.length - 1];
    const lastDate = new Date(last.time * 1000).toDateString();
    const todayDate = new Date(todayCandle.time * 1000).toDateString();

    if (lastDate === todayDate) {
      list[list.length - 1] = {
        ...last,
        high: Math.max(last.high, todayCandle.high),
        low: Math.min(last.low, todayCandle.low),
        close: todayCandle.close,
        volume: Math.max(last.volume, todayCandle.volume),
        source: 'upstox_live'
      };
    } else {
      list.push(todayCandle);
    }
    return list;
  }

  // Aggregate today's intraday bars into one daily candle
  aggregateBarsToDaily(bars) {
    if (!bars || !bars.length) return null;
    const sorted = [...bars].sort((a, b) => a.time - b.time);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const today = new Date(last.time * 1000);
    const todayMidnight = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000);

    let high = -Infinity;
    let low = Infinity;
    let volume = 0;

    for (const b of sorted) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += (b.volume || 0);
    }

    return {
      time: todayMidnight,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      source: 'upstox_live'
    };
  }

  // Resample smaller candles into larger minute intervals (e.g. 1m -> 5m, 15m; 30m -> 75m, 125m)
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

  // Fetch Live / Historical Candles from Upstox with live quote overlay
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

    const tokenInfo = inspectToken(this.config.accessToken);
    if (tokenInfo.isExpired) {
      this.config.isActive = false;
      this.config.isExpired = true;
      this.config.error = tokenInfo.reason;
      throw new Error(tokenInfo.reason);
    }

    const cacheKey = `${instrumentKey}|${timeframe}`;
    const cached = this.historyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HISTORY_TTL_MS) {
      return cached.candles.map(c => ({ ...c }));
    }

    const encodedKey = encodeURIComponent(instrumentKey);
    const today = new Date();
    const toDate = today.toISOString().split('T')[0];
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${this.config.accessToken}`
    };

    let formatted = [];
    let targetAggregateMinutes = null;

    if (timeframe === '1w') {
      const url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/week/${toDate}`;
      formatted = await this.fetchCandlesUrl(url, headers);
    } else if (timeframe === '1M') {
      const url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/month/${toDate}`;
      formatted = await this.fetchCandlesUrl(url, headers);
    } else if (timeframe === '5m' || timeframe === '15m' || timeframe === '1m') {
      // 1-minute base data for intraday
      const past10 = new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const histUrl = `https://api.upstox.com/v2/historical-candle/${encodedKey}/1minute/${toDate}/${past10}`;
      const histCandles = await this.fetchCandlesUrl(histUrl, headers).catch(() => []);

      // Also fetch today's live intraday candles
      const liveIntradayUrl = `https://api.upstox.com/v2/historical-candle/intraday/${encodedKey}/1minute`;
      const liveCandles = await this.fetchCandlesUrl(liveIntradayUrl, headers).catch(() => []);

      formatted = this.mergeCandles(histCandles, liveCandles);
      if (timeframe === '5m') targetAggregateMinutes = 5;
      if (timeframe === '15m') targetAggregateMinutes = 15;
    } else if (timeframe === '30m' || timeframe === '60m' || timeframe === '75m' || timeframe === '125m' || timeframe === '240m') {
      // 30-minute base data for multi-hour and 75m bars
      const past60 = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const histUrl = `https://api.upstox.com/v2/historical-candle/${encodedKey}/30minute/${toDate}/${past60}`;
      const histCandles = await this.fetchCandlesUrl(histUrl, headers).catch(() => []);

      // Also fetch today's live intraday candles
      const liveIntradayUrl = `https://api.upstox.com/v2/historical-candle/intraday/${encodedKey}/30minute`;
      const liveCandles = await this.fetchCandlesUrl(liveIntradayUrl, headers).catch(() => []);

      formatted = this.mergeCandles(histCandles, liveCandles);
      if (timeframe === '60m') targetAggregateMinutes = 60;
      if (timeframe === '75m') targetAggregateMinutes = 75;
      if (timeframe === '125m') targetAggregateMinutes = 125;
      if (timeframe === '240m') targetAggregateMinutes = 240;
    } else {
      // Default: daily candles with full historical depth
      const url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/day/${toDate}`;
      formatted = await this.fetchCandlesUrl(url, headers);

      // Fetch today's live session to ensure the daily chart includes the live session candle
      try {
        const liveIntradayUrl = `https://api.upstox.com/v2/historical-candle/intraday/${encodedKey}/30minute`;
        const todayBars = await this.fetchCandlesUrl(liveIntradayUrl, headers);
        if (todayBars && todayBars.length > 0) {
          const todayCandle = this.aggregateBarsToDaily(todayBars);
          if (todayCandle) {
            formatted = this.mergeDailyCandle(formatted, todayCandle);
          }
        }
      } catch {
        // Fallback: try market quote if intraday candle unavailable
        try {
          const quotes = await this.getMarketQuotes([instrumentKey]);
          const quote = quotes[instrumentKey] || Object.values(quotes)[0];
          if (quote && quote.last_price && quote.ohlc) {
            const todayCandle = {
              time: Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000),
              open: quote.ohlc.open,
              high: quote.ohlc.high,
              low: quote.ohlc.low,
              close: quote.last_price,
              volume: quote.volume || 0,
              source: 'upstox_live'
            };
            formatted = this.mergeDailyCandle(formatted, todayCandle);
          }
        } catch {}
      }
    }

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

    if (!res.ok) {
      if (res.status === 401) {
        this.config.isActive = false;
        this.config.isExpired = true;
        this.config.error = 'Upstox Token has expired or is invalid (401 Unauthorized). Please update your Analytics Token in settings.';
      }
      return merged;
    }
    const data = await res.json();
    const fresh = data.data || {};
    for (const [responseKey, quote] of Object.entries(fresh)) {
      const token = quote?.instrument_token;
      const cleanToken = token ? token.replace(':', '|') : null;
      const pipeResponse = responseKey.replace(':', '|');

      const requestKey = missing.find(k => 
        k === responseKey || 
        k === pipeResponse ||
        (token && (k === token || k === cleanToken))
      ) || token || responseKey;

      this.quoteCache.set(requestKey, { at: now, quote, responseKey });
      this.quoteCache.set(responseKey, { at: now, quote, responseKey });
      this.quoteCache.set(pipeResponse, { at: now, quote, responseKey });
      if (token) this.quoteCache.set(token, { at: now, quote, responseKey });
      if (cleanToken) this.quoteCache.set(cleanToken, { at: now, quote, responseKey });

      merged[responseKey] = quote;
      merged[pipeResponse] = quote;
      if (token) merged[token] = quote;
      if (cleanToken) merged[cleanToken] = quote;
    }
    return merged;
  }

  // Helper to fetch live quotes by stock symbols
  async getQuotesForSymbols(symbols = [], instruments = []) {
    if (!this.config.accessToken || !symbols.length) return {};
    const keys = [];
    const symToKey = new Map();

    for (const sym of symbols) {
      const clean = sym.toUpperCase();
      const inst = instruments.find(i => (i.symbol && i.symbol.toUpperCase() === clean));
      const key = inst?.upstoxInstrumentKey || (clean.startsWith('NSE_EQ|') || clean.startsWith('NSE_INDEX|') ? clean : `NSE_EQ|${clean}`);
      keys.push(key);
      symToKey.set(key, clean);
      symToKey.set(key.replace('|', ':'), clean);
      symToKey.set(`NSE_EQ:${clean}`, clean);
    }

    try {
      const rawQuotes = await this.getMarketQuotes(keys);
      const result = {};
      for (const [key, q] of Object.entries(rawQuotes)) {
        const symbol = symToKey.get(key) || key.split(':').pop() || key.split('|').pop();
        result[symbol] = {
          symbol,
          lastPrice: q.last_price,
          close: q.ohlc?.close || q.last_price,
          open: q.ohlc?.open,
          high: q.ohlc?.high,
          low: q.ohlc?.low,
          volume: q.volume,
          change: q.net_change,
          timestamp: q.timestamp
        };
      }
      return result;
    } catch (e) {
      console.warn('Error fetching quotes for symbols:', e.message);
      return {};
    }
  }
}

export const upstox = new UpstoxService();
