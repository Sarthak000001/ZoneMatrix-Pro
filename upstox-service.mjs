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

class UpstoxService {
  constructor() {
    this.config = {
      accessToken: process.env.UPSTOX_ACCESS_TOKEN || '',
      apiKey: process.env.UPSTOX_API_KEY || '',
      apiSecret: process.env.UPSTOX_API_SECRET || '',
      isActive: false,
      lastValidated: null
    };
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

  // Fetch Live / Historical Candles from Upstox
  async getCandles(instrumentKey, timeframe = '1d') {
    if (!this.config.accessToken) {
      throw new Error('Upstox Access Token is not configured');
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
    if (targetAggregateMinutes && targetAggregateMinutes > 1) {
      return this.aggregateCandles(formatted, targetAggregateMinutes);
    }

    return formatted;
  }

  // Fetch Live Market Quotes (LTP, OHLC, volume)
  async getMarketQuotes(instrumentKeys = []) {
    if (!this.config.accessToken || !instrumentKeys.length) return {};

    const keysStr = instrumentKeys.map(k => encodeURIComponent(k)).join(',');
    const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${keysStr}`;

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${this.config.accessToken}`
      }
    });

    if (!res.ok) return {};
    const data = await res.json();
    return data.data || {};
  }
}

export const upstox = new UpstoxService();
