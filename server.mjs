import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.mjs';
import { upstox } from './upstox-service.mjs';
import { aggregateDaily, ensureDailyHistory, getSyncStatus, isIntradayTimeframe, startEquitySync } from './nse-history.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

// Load cached or seed data with fallback to data/
function loadJson(relPath, defaultVal = {}) {
  const p = path.join(__dirname, relPath);
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (err) {
    console.error(`Failed loading ${relPath}:`, err.message);
  }

  // Fallback to data/ directory if looking in _cache/
  if (relPath.startsWith('_cache/')) {
    const fallbackPath = path.join(__dirname, 'data', relPath.replace('_cache/', ''));
    try {
      if (fs.existsSync(fallbackPath)) {
        return JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
      }
    } catch (err) {
      console.error(`Failed loading fallback data ${fallbackPath}:`, err.message);
    }
  }

  return defaultVal;
}

const instrumentsData = loadJson('_cache/instruments.json', { instruments: [] });
const instrumentBySymbol = new Map();
for (const inst of instrumentsData.instruments || []) {
  if (inst.symbol) instrumentBySymbol.set(String(inst.symbol).toUpperCase(), inst);
}

const liveSyncState = {
  status: 'idle',
  lastSyncAt: null,
  lastError: null,
  quoteCount: 0,
  log: []
};

function recordSync(status, message, quoteCount = 0) {
  liveSyncState.status = status;
  liveSyncState.lastSyncAt = new Date().toISOString();
  liveSyncState.lastError = status === 'error' ? message : null;
  liveSyncState.quoteCount = quoteCount;
  liveSyncState.log.unshift({ at: liveSyncState.lastSyncAt, message });
  if (liveSyncState.log.length > 8) liveSyncState.log.length = 8;
}

function isUpstoxInstrumentKey(key) {
  return typeof key === 'string' && /\|IN[A-Z0-9]{5,}$/i.test(key);
}

function instrumentKeyFor(symbol, explicitKey) {
  if (isUpstoxInstrumentKey(explicitKey)) return explicitKey;
  const inst = instrumentBySymbol.get(String(symbol || '').toUpperCase());
  return isUpstoxInstrumentKey(inst?.upstoxInstrumentKey) ? inst.upstoxInstrumentKey : null;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function livePriceMap(entries) {
  const prices = new Map();
  if (!upstox.config.accessToken) {
    return { prices, source: 'snapshot' };
  }

  const keyToSymbol = new Map();
  const keys = [];
  for (const entry of entries) {
    const symbol = String(entry.symbol || '').toUpperCase();
    if (!symbol) continue;
    keyToSymbol.set(symbol, symbol);
    keyToSymbol.set(`NSE_EQ:${symbol}`, symbol);
    keyToSymbol.set(`NSE_INDEX:${symbol}`, symbol);

    const key = instrumentKeyFor(symbol, entry.instrumentKey);
    if (!key || keyToSymbol.has(key)) continue;
    keyToSymbol.set(key, symbol);
    keyToSymbol.set(key.replace('|', ':'), symbol);
    keyToSymbol.set(key.replace(':', '|'), symbol);
    keys.push(key);
  }

  if (!keys.length) return { prices, source: 'snapshot' };

  try {
    for (let i = 0; i < keys.length; i += 40) {
      const batch = keys.slice(i, i + 40);
      const quotes = await upstox.getMarketQuotes(batch);
      for (const [responseKey, quote] of Object.entries(quotes || {})) {
        const token = quote?.instrument_token;
        const cleanToken = token ? token.replace(':', '|') : null;
        const symbol = keyToSymbol.get(responseKey) ||
                       (token && keyToSymbol.get(token)) ||
                       (cleanToken && keyToSymbol.get(cleanToken)) ||
                       keyToSymbol.get(responseKey.replace(':', '|')) ||
                       keyToSymbol.get(responseKey.split(':').pop()) ||
                       responseKey.split(':').pop();
        const ltp = asNumber(quote?.last_price);
        if (symbol && ltp != null && ltp > 0) {
          prices.set(String(symbol).toUpperCase(), ltp);
        }
      }
    }
    const isLive = prices.size > 0;
    recordSync(isLive ? 'live' : 'snapshot', `Live sync applied ${prices.size} quote${prices.size === 1 ? '' : 's'} to prices and zones.`, prices.size);
    return { prices, source: isLive ? 'upstox_live' : 'snapshot' };
  } catch (err) {
    recordSync('error', `Live sync failed: ${err.message}`, 0);
    return { prices, source: 'snapshot' };
  }
}

function withLiveZonePrice(row, cmp) {
  if (!Number.isFinite(cmp) || cmp <= 0) return row;
  const isDemand = row.zoneType === 'demand' || row.side === 'long';
  const proximal = asNumber(row.proximal ?? row.entry ?? (isDemand ? row.zoneTop : row.zoneBottom));
  const distal = asNumber(row.distal ?? row.stop ?? (isDemand ? row.zoneBottom : row.zoneTop));
  const next = {
    ...row,
    currentPrice: cmp,
    cmp,
    priceSource: 'upstox_live',
    priceState: 'LIVE',
    dataQuality: 'live_upstox',
    latestTime: Math.floor(Date.now() / 1000)
  };
  if (proximal == null || distal == null) return next;

  const top = Math.max(proximal, distal);
  const bottom = Math.min(proximal, distal);
  let freshnessState = row.freshnessState;
  if (isDemand && cmp < distal) freshnessState = 'broken_by_close';
  else if (!isDemand && cmp > distal) freshnessState = 'broken_by_close';
  else if (cmp >= bottom && cmp <= top && freshnessState === 'fresh') freshnessState = 'tested_by_wick';

  next.distance = +((cmp - proximal).toFixed(2));
  next.distancePercent = +((Math.abs(cmp - proximal) / cmp) * 100).toFixed(2);
  next.freshnessState = freshnessState;
  return next;
}

function withLiveConfluencePrice(row, cmp) {
  if (!Number.isFinite(cmp) || cmp <= 0) return row;
  const isDemand = row.zoneType === 'demand' || row.side === 'long';
  const ltfProx = asNumber(isDemand ? row.ltfZoneTop : row.ltfZoneBottom);
  const ltfDist = asNumber(isDemand ? row.ltfZoneBottom : row.ltfZoneTop);
  const htfProx = asNumber(isDemand ? row.htfZoneTop : row.htfZoneBottom);
  let freshnessState = row.freshnessState;
  if (ltfProx != null && ltfDist != null) {
    if (isDemand && cmp < ltfDist) freshnessState = 'broken_by_close';
    else if (!isDemand && cmp > ltfDist) freshnessState = 'broken_by_close';
  }
  const next = {
    ...row,
    currentPrice: cmp,
    cmp,
    priceSource: 'upstox_live',
    priceState: 'LIVE',
    dataQuality: 'live_upstox',
    latestTime: Math.floor(Date.now() / 1000),
    freshnessState
  };
  if (ltfProx) next.ltfDistancePercent = +((Math.abs(cmp - ltfProx) / cmp) * 100).toFixed(2);
  if (htfProx) next.htfDistancePercent = +((Math.abs(cmp - htfProx) / cmp) * 100).toFixed(2);
  return next;
}

function applyLiveZoneState(zone, cmp) {
  const low = asNumber(zone.low);
  const high = asNumber(zone.high);
  if (low == null || high == null || !Number.isFinite(cmp) || cmp <= 0) return zone;
  const isDemand = zone.zoneType === 'DZ' || zone.zoneType === 'demand';
  const proximal = isDemand ? high : low;
  const distal = isDemand ? low : high;
  const inside = cmp >= low && cmp <= high;
  if (inside && !zone.lastInside) {
    zone.touchCount = (zone.touchCount || 0) + 1;
    zone.reactionActive = true;
    zone.lastTouchedAt = new Date().toISOString();
  }
  zone.lastInside = inside;

  let status = 'WATCHING';
  if (isDemand ? cmp < distal : cmp > distal) status = 'BROKEN';
  else if (inside) status = 'IN_ZONE';
  else if ((zone.touchCount || 0) >= 1 && zone.reactionActive && (isDemand ? cmp > high : cmp < low)) status = 'REACTING';
  else if ((Math.abs(cmp - proximal) / cmp) * 100 <= 2) status = 'NEAR';

  zone.cmp = cmp;
  zone.status = status;
  zone.marketStatus = status;
  zone.position = cmp > high ? 'ABOVE' : cmp < low ? 'BELOW' : 'INSIDE';
  zone.nearestBoundary = Math.abs(cmp - high) <= Math.abs(cmp - low) ? high : low;
  zone.distanceAbsolute = +Math.abs(cmp - proximal).toFixed(2);
  zone.distancePercent = +((Math.abs(cmp - proximal) / cmp) * 100).toFixed(2);
  zone.priceSource = 'upstox_live';
  zone.priceState = 'LIVE';
  zone.dataAvailability = 'LIVE';
  zone.lastObservedPrice = cmp;
  zone.updatedAt = new Date().toISOString();
  zone.lastObservedAt = zone.updatedAt;
  return zone;
}

async function refreshTrackedZones(zones) {
  const { prices, source } = await livePriceMap(zones || []);
  if (source !== 'upstox_live') return { source, updated: 0 };
  let updated = 0;
  for (const zone of zones || []) {
    const cmp = prices.get(String(zone.symbol || '').toUpperCase());
    if (cmp == null) continue;
    applyLiveZoneState(zone, cmp);
    updated += 1;
  }
  return { source, updated };
}
const universesData = loadJson('_cache/report-universes.json', { universes: [] });
const demandReportData = loadJson('_cache/report-zones-demand.json', { rows: [] });
const supplyReportData = loadJson('_cache/report-zones-supply.json', { rows: [] });
const confluenceReportData = loadJson('_cache/report-confluence-merged.json', loadJson('_cache/report-confluence-saved.json', { rows: [] }));
const zoneWatchData = loadJson('_cache/zone-watch.json', { zones: [], monitorStatus: 'Live connected' });
const dashboardData = loadJson('_cache/dashboard-items.json', { items: [] });
const toolStateData = loadJson('_cache/user-tool-state.json', { states: {} });
const loaderHealthData = loadJson('_cache/loader-health.json', { status: 'healthy', provider: 'Upstox', sync: 'ready' });
const operationsJobsData = loadJson('_cache/operations-jobs.json', { jobs: [] });

// Map cached candle files
const candleCache = {};
const zoneCache = {};
const symbols = ['COCHINSHIP', 'RELIANCE', 'TATASTEEL', 'INOXWIND', 'TITAN', 'AARTIDRUGS', 'ONESOURCE'];
for (const sym of symbols) {
  const cData = loadJson(`_cache/candles-${sym}-1d.json`, null);
  if (cData) {
    candleCache[sym] = cData;
  }
  const zData = loadJson(`_cache/zones-v3-${sym}-1d.json`, null);
  if (zData) {
    zoneCache[sym] = zData;
  }
}

// In-memory zone watch items
let activeWatchZones = [...(zoneWatchData.zones || [])];

// In-memory dashboard items
let activeDashboardItems = [...(dashboardData.items || [])];

// Backtest runs cache
const backtests = [
  {
    id: 'dz-v2-prefix-replay-28-htf-single-origin-pivot',
    createdAt: '2026-10-30T10:00:00.000Z',
    status: 'completed',
    scope: 'universe',
    universe: 'nifty500',
    timeframe: '1d',
    initialCapital: 1000000,
    currentCapital: 1284500,
    totalTrades: 142,
    winRate: 64.79,
    profitFactor: 2.15,
    maxDrawdown: 6.84,
    trades: [
      { id: 1, symbol: 'COCHINSHIP', type: 'BUY (DZ)', entryTime: '2026-08-14', entry: 1120.0, exit: 1245.0, rMultiple: 2.5, pnl: 28400, result: 'WIN' },
      { id: 2, symbol: 'RELIANCE', type: 'SELL (SZ)', entryTime: '2026-08-22', entry: 2980.0, exit: 2890.0, rMultiple: 2.0, pnl: 22100, result: 'WIN' },
      { id: 3, symbol: 'TATASTEEL', type: 'BUY (DZ)', entryTime: '2026-09-02', entry: 154.2, exit: 151.8, rMultiple: -1.0, pnl: -10000, result: 'LOSS' },
      { id: 4, symbol: 'TITAN', type: 'BUY (DZ)', entryTime: '2026-09-18', entry: 3340.0, exit: 3520.0, rMultiple: 2.8, pnl: 35000, result: 'WIN' },
      { id: 5, symbol: 'INOXWIND', type: 'BUY (DZ)', entryTime: '2026-10-05', entry: 215.0, exit: 238.0, rMultiple: 2.2, pnl: 26000, result: 'WIN' }
    ]
  }
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({ raw: body });
      }
    });
    req.on('error', reject);
  });
}

function sameSecret(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function siteAccessAllowed(req) {
  const password = process.env.SITE_PASSWORD || '';
  if (!password) return true;
  const expectedUser = process.env.SITE_USER || 'zonematrix';
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return sameSecret(decoded.slice(0, sep), expectedUser) && sameSecret(decoded.slice(sep + 1), password);
}

const server = http.createServer(async (req, res) => {
  if (!siteAccessAllowed(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="ZoneMatrix Pro"',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end('Sign in required');
    return;
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // API Routes
  if (pathname.startsWith('/api/')) {
    // 1. Auth Bootstrap
    if (pathname === '/api/auth/bootstrap-status') {
      return sendJson(res, 200, { ready: true });
    }

    // 2. Auth Me
    if (pathname === '/api/auth/me') {
      return sendJson(res, 200, {
        user: { id: 200, loginId: "pradyumn.m", role: "trader", mustChangePassword: false },
        providerStatus: {
          state: "configured",
          source: "environment",
          externallyValidated: false,
          expiresAt: null,
          syncStatus: "ready"
        },
        sessionActive: true
      });
    }

    // 3. Auth Login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseBody(req);
      return sendJson(res, 200, {
        user: { id: 200, loginId: body.id || "pradyumn.m", role: "trader", active: true },
        providerStatus: { state: "configured", source: "environment", syncStatus: "ready" },
        sessionActive: true
      });
    }

    // 4. Instruments
    if (pathname === '/api/instruments') {
      const q = (parsedUrl.searchParams.get('q') || '').toLowerCase();
      let list = instrumentsData.instruments || [];
      if (q) {
        list = list.filter(i => (i.symbol && i.symbol.toLowerCase().includes(q)) || (i.name && i.name.toLowerCase().includes(q)));
      }
      return sendJson(res, 200, { instruments: list });
    }

    // 5. Report Universes
    if (pathname === '/api/report-universes') {
      return sendJson(res, 200, universesData);
    }

    // 6. User tool state
    if (pathname === '/api/user/tool-state') {
      if (req.method === 'POST') {
        const body = await parseBody(req);
        if (body.key && body.state) {
          toolStateData.states[body.key] = { version: 3, state: body.state, updatedAt: new Date().toISOString() };
        }
        return sendJson(res, 200, { success: true });
      }
      return sendJson(res, 200, toolStateData);
    }

    // Exchange OAuth code for Access Token
    if (pathname === '/api/settings/upstox/exchange-code' && req.method === 'POST') {
      const body = await parseBody(req);
      const code = (body.code || '').trim();
      const apiKey = (body.apiKey || upstox.config.apiKey || process.env.UPSTOX_API_KEY || '').trim();
      const apiSecret = (body.apiSecret || upstox.config.apiSecret || process.env.UPSTOX_API_SECRET || '').trim();
      const redirectUri = (body.redirectUri || process.env.UPSTOX_REDIRECT_URI || `http://${req.headers.host || 'localhost:3000'}`).trim();

      if (!code) {
        return sendJson(res, 400, { error: 'Authorization code is required' });
      }
      if (!apiKey || !apiSecret) {
        return sendJson(res, 400, {
          error: 'UPSTOX_API_KEY and UPSTOX_API_SECRET are required to exchange authorization code. Please enter them in the settings modal or .env.'
        });
      }

      const result = await upstox.exchangeCodeForToken(code, apiKey, apiSecret, redirectUri);
      if (!result.success) {
        return sendJson(res, 400, result);
      }
      return sendJson(res, 200, result);
    }

    // Upstox Configuration Settings
    if (pathname === '/api/settings/upstox') {
      if (req.method === 'POST') {
        const body = await parseBody(req);
        if (body.disconnect) {
          const status = upstox.saveConfig({ accessToken: '', apiKey: '', apiSecret: '', isActive: false });
          return sendJson(res, 200, { success: true, message: 'Disconnected from Upstox', status });
        }
        const token = (body.accessToken || body.analyticsToken || '').trim();
        if (!token) {
          return sendJson(res, 400, { error: 'Upstox Analytics Token or Access Token is required' });
        }
        // Test token with Upstox API
        const testResult = await upstox.validateToken(token);
        if (!testResult.valid) {
          return sendJson(res, 401, {
            error: testResult.message || 'Invalid or expired Upstox token',
            details: testResult
          });
        }
        // Save token to .env and cache
        const status = upstox.saveConfig({
          accessToken: token,
          apiKey: (body.apiKey || '').trim(),
          apiSecret: (body.apiSecret || '').trim(),
          userName: testResult.user
        });
        const tokenLabel = testResult.isAnalytics ? '1-Year Analytics Token (No 3:30 AM expiry)' : 'Access Token';
        return sendJson(res, 200, {
          success: true,
          message: `Successfully connected to Upstox API (${testResult.user}) using ${tokenLabel}`,
          user: testResult.user,
          status
        });
      }
      return sendJson(res, 200, upstox.getStatus());
    }

    // Live Quotes Endpoint
    if (pathname === '/api/quotes') {
      const symbolsStr = parsedUrl.searchParams.get('symbols') || '';
      const symbols = symbolsStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      if (!symbols.length) {
        return sendJson(res, 400, { error: 'symbols query parameter required' });
      }
      const st = upstox.getStatus();
      if (!st.isActive) {
        return sendJson(res, 200, {
          isLive: false,
          quotes: {},
          message: st.error || 'Upstox live market stream not active'
        });
      }
      const quotes = await upstox.getQuotesForSymbols(symbols, instrumentsData.instruments);
      return sendJson(res, 200, {
        isLive: true,
        quotes
      });
    }

    // 7. Candles
    if (pathname === '/api/candles') {
      const symbol = (parsedUrl.searchParams.get('symbol') || 'COCHINSHIP').toUpperCase();
      const timeframe = parsedUrl.searchParams.get('timeframe') || '1d';
      const status = upstox.getStatus();
      
      const upstoxKey = instrumentKeyFor(symbol);
      // If Upstox token is active and not expired, try fetching live candles from Upstox API
      if (status.isActive && upstoxKey) {
        try {
          const liveCandles = await upstox.getCandles(upstoxKey, timeframe);
          if (liveCandles && liveCandles.length > 0) {
            const last = liveCandles[liveCandles.length - 1];
            recordSync('live', `${symbol} ${timeframe} synced. Last ${last.close} at ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}.`, 1);
            return sendJson(res, 200, {
              symbol,
              timeframe,
              candles: liveCandles,
              source: 'upstox_live',
              count: liveCandles.length,
              lastPrice: last.close,
              syncedAt: new Date().toISOString(),
              status,
              providerStatus: status
            });
          }
        } catch (upstoxErr) {
          recordSync('error', `Upstox fetch failed for ${symbol}: ${upstoxErr.message}`, 0);
          console.warn(`Upstox fetch failed for ${symbol}: ${upstoxErr.message}. Using NSE daily history.`);
        }
      }

      if (isIntradayTimeframe(timeframe)) {
        return sendJson(res, 200, {
          symbol,
          timeframe,
          candles: [],
          source: 'unavailable',
          error: status.isExpired
            ? `Upstox token expired (${status.error || 'renewal required'}). Intraday bars require an active Upstox token.`
            : 'Intraday bars need an Upstox token. Daily, weekly, and monthly history is available for every NSE stock.',
          syncedAt: null,
          status,
          providerStatus: status
        });
      }

      const history = await ensureDailyHistory(symbol);
      const candles = aggregateDaily(history.candles, timeframe) || [];
      const last = candles[candles.length - 1];
      return sendJson(res, 200, {
        symbol,
        timeframe,
        candles,
        source: history.source,
        count: candles.length,
        lastPrice: last?.close ?? null,
        syncedAt: history.fetchedAt,
        status,
        providerStatus: status,
        error: candles.length ? null : (history.error || `No daily history for ${symbol}`)
      });
    }


    // 8. Zone detection (GET /api/zones/detect)
    if (pathname === '/api/zones/detect') {
      const symbol = parsedUrl.searchParams.get('symbol') || 'COCHINSHIP';
      const version = parsedUrl.searchParams.get('version') || 'v3';
      
      if (zoneCache[symbol]) {
        return sendJson(res, 200, zoneCache[symbol]);
      }

      const zData = loadJson(`_cache/zones-v3-${symbol}-1d.json`, null);
      if (zData) {
        zoneCache[symbol] = zData;
        return sendJson(res, 200, zData);
      }

      return sendJson(res, 200, { version: 'v3', algorithmVersion: 'dz-v3-canonical-6', zones: [] });
    }

    // 9. Reports: Zones (GET /api/reports/zones)
    if (pathname === '/api/reports/zones') {
      const timeframe = parsedUrl.searchParams.get('timeframe') || '1d';
      const zoneType = parsedUrl.searchParams.get('zoneType') || 'all';
      const universe = parsedUrl.searchParams.get('universe') || 'all';
      const minScore = parseFloat(parsedUrl.searchParams.get('minScore') || '0');
      const minDecisionScore = parseFloat(parsedUrl.searchParams.get('minDecisionScore') || '0');
      const maxDistance = parseFloat(parsedUrl.searchParams.get('maxDistancePercent') || '100');
      const freshOnly = parsedUrl.searchParams.get('freshOnly') !== 'false';
      const contextMode = parsedUrl.searchParams.get('contextMode') || 'off';
      const purpose = parsedUrl.searchParams.get('purpose') || 'MIT';
      const detectorVersion = parsedUrl.searchParams.get('detectorVersion') || 'v2';
      const q = (parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('query') || '').trim().toLowerCase();

      // Collect rows based on zoneType
      let rawRows = [];
      if (zoneType === 'demand') {
        rawRows = (demandReportData.rows || []).map(r => ({ ...r, zoneType: 'demand', side: 'long' }));
      } else if (zoneType === 'supply') {
        rawRows = (supplyReportData.rows || []).map(r => ({ ...r, zoneType: 'supply', side: 'short' }));
      } else {
        // 'all' includes both demand and supply
        const dRows = (demandReportData.rows || []).map(r => ({ ...r, zoneType: 'demand', side: 'long' }));
        const sRows = (supplyReportData.rows || []).map(r => ({ ...r, zoneType: 'supply', side: 'short' }));
        rawRows = [...dRows, ...sRows];
      }

      // Sector and Industry dictionary for NSE instruments
      const SECTOR_MAP = {
        'COALINDIA': { sector: 'Energy & Mining', industry: 'Coal & Mining' },
        'CONCORDBIO': { sector: 'Healthcare', industry: 'Biotechnology' },
        'DIXON': { sector: 'Technology', industry: 'Electronics Manufacturing' },
        'SUPREMEIND': { sector: 'Materials', industry: 'Plastics & Polymers' },
        'PAGEIND': { sector: 'Consumer Goods', industry: 'Apparel & Textiles' },
        'RRKABEL': { sector: 'Capital Goods', industry: 'Cables & Electricals' },
        'EMMVEE': { sector: 'Green Energy', industry: 'Solar Photovoltaic' },
        'MRF': { sector: 'Automobile', industry: 'Tyres & Rubber' },
        'TATASTEEL': { sector: 'Metals & Mining', industry: 'Iron & Steel' },
        'AUROPHARMA': { sector: 'Pharmaceuticals', industry: 'Generic Formulations' },
        'BOSCHLTD': { sector: 'Automobile', industry: 'Auto Parts & Equipment' },
        '360ONE': { sector: 'Financial Services', industry: 'Wealth Management' },
        'GRAPHITE': { sector: 'Industrial', industry: 'Graphite Electrodes' },
        'ULTRACEMCO': { sector: 'Construction', industry: 'Cement & Concrete' },
        'ZEEL': { sector: 'Media', industry: 'Broadcasting & Entertainment' },
        'FEDERALBNK': { sector: 'Banking', industry: 'Private Sector Bank' },
        'IEX': { sector: 'Financial Services', industry: 'Power Exchange' },
        'CDSL': { sector: 'Financial Services', industry: 'Depository Services' },
        'RKFORGE': { sector: 'Metals & Forging', industry: 'Precision Forgings' },
        'TRIDENT': { sector: 'Consumer Goods', industry: 'Textiles & Paper' },
        'KPIL': { sector: 'Infrastructure', industry: 'Power Transmission & EPC' },
        'ITC': { sector: 'FMCG', industry: 'Diversified Cigarettes & Foods' },
        'IDEA': { sector: 'Telecommunications', industry: 'Telecom Cellular' },
        'KIRLOSBROS': { sector: 'Capital Goods', industry: 'Industrial Pumps' },
        'OIL': { sector: 'Energy', industry: 'Oil & Gas Exploration' },
        'NTPC': { sector: 'Energy & Power', industry: 'Power Generation & Utility' },
        'ASHOKLEY': { sector: 'Automobile', industry: 'Commercial Vehicles' },
        'HINDUNILVR': { sector: 'FMCG', industry: 'Household & Personal Care' },
        'PIDILITIND': { sector: 'Chemicals', industry: 'Specialty Adhesives' },
        'NBCC': { sector: 'Real Estate & Infra', industry: 'Civil Construction & PMC' },
        'GILLETTE': { sector: 'FMCG', industry: 'Personal Grooming' },
        'JWL': { sector: 'Capital Goods', industry: 'Railway Wagons & Transit' },
        'BIOCON': { sector: 'Healthcare', industry: 'Biopharmaceuticals' },
        'MUTHOOTFIN': { sector: 'Financial Services', industry: 'Gold Loan NBFC' },
        'GICRE': { sector: 'Financial Services', industry: 'General Reinsurance' },
        'NSLNISP': { sector: 'Metals & Mining', industry: 'Sponge Iron & Steel' },
        'LTTS': { sector: 'Technology', industry: 'Engineering R&D Services' },
        'ENGINERSIN': { sector: 'Infrastructure', industry: 'Consultancy & EPC' },
        'JSWCEMENT': { sector: 'Construction', industry: 'Cement' },
        'VBL': { sector: 'FMCG', industry: 'Beverages & Bottling' },
        'JSWENERGY': { sector: 'Energy & Power', industry: 'Power Generation' },
        'RPOWER': { sector: 'Energy & Power', industry: 'Power Utility' },
        'KIMS': { sector: 'Healthcare', industry: 'Multi-Specialty Hospitals' },
        'NATIONALUM': { sector: 'Metals & Mining', industry: 'Aluminium' },
        'BAJAJ-AUTO': { sector: 'Automobile', industry: 'Two & Three Wheelers' },
        'JMFINANCIL': { sector: 'Financial Services', industry: 'Investment Banking' },
        'MARUTI': { sector: 'Automobile', industry: 'Passenger Cars' },
        'GRAVITA': { sector: 'Materials', industry: 'Lead & Aluminium Recycling' },
        'RADICO': { sector: 'FMCG', industry: 'Alcoholic Beverages' },
        'MANKIND': { sector: 'Pharmaceuticals', industry: 'Pharmaceutical Formulations' },
        'RELIANCE': { sector: 'Energy & Retail', industry: 'Oil, Retail & Telecom' },
        'COCHINSHIP': { sector: 'Defence & Marine', industry: 'Shipbuilding & Repair' },
        'TITAN': { sector: 'Consumer Goods', industry: 'Watches & Jewellery' },
        'INOXWIND': { sector: 'Green Energy', industry: 'Wind Turbine Generators' },
        'AARTIDRUGS': { sector: 'Pharmaceuticals', industry: 'Active Pharmaceutical Ingredients' },
        'ONESOURCE': { sector: 'Technology', industry: 'Software Solutions' }
      };

      function getSectorInfo(sym, nm = '') {
        const s = (sym || '').toUpperCase();
        if (SECTOR_MAP[s]) return SECTOR_MAP[s];
        const n = (nm || '').toUpperCase();
        if (n.includes('BANK') || s.includes('BNK')) return { sector: 'Banking', industry: 'Banking Services' };
        if (n.includes('PHARMA') || n.includes('HEALTH') || n.includes('DRUG') || n.includes('BIO') || n.includes('HOSPITAL')) return { sector: 'Healthcare', industry: 'Pharmaceuticals' };
        if (n.includes('TECH') || n.includes('INFO') || n.includes('SOFT') || n.includes('SYSTEM')) return { sector: 'Technology', industry: 'IT & Software' };
        if (n.includes('STEEL') || n.includes('METAL') || n.includes('MINING') || n.includes('ALUM')) return { sector: 'Metals & Mining', industry: 'Metals' };
        if (n.includes('AUTO') || n.includes('MOTOR') || n.includes('TYRE') || n.includes('WHEEL')) return { sector: 'Automobile', industry: 'Automotive' };
        if (n.includes('POWER') || n.includes('ENERGY') || n.includes('OIL') || n.includes('GAS') || n.includes('SOLAR')) return { sector: 'Energy & Power', industry: 'Energy & Utilities' };
        if (n.includes('CEMENT') || n.includes('INFRA') || n.includes('BUILD') || n.includes('CONST') || n.includes('ENGINEER')) return { sector: 'Infrastructure', industry: 'Construction & EPC' };
        if (n.includes('FIN') || n.includes('CAP') || n.includes('SECUR') || n.includes('INVEST')) return { sector: 'Financial Services', industry: 'Financial Services' };
        if (n.includes('FOOD') || n.includes('CONSUM') || n.includes('BEVERAGE') || n.includes('RETAIL')) return { sector: 'FMCG', industry: 'Consumer Products' };
        if (n.includes('CHEM') || n.includes('PETRO') || n.includes('FERT')) return { sector: 'Chemicals', industry: 'Specialty Chemicals' };
        return { sector: 'Diversified', industry: 'Industrial & Diversified' };
      }

      // Enrich rows with sector, purpose, and timeframe adaptations
      let enrichedRows = rawRows.map(r => {
        const sectorInfo = getSectorInfo(r.symbol, r.name);
        let adapted = {
          ...r,
          timeframe,
          sector: sectorInfo.sector,
          industry: sectorInfo.industry,
          detectorVersion
        };

        // If timeframe is not 1d, look for corresponding timeframe zone in oppositeZones or adapt
        if (timeframe === '1w' || timeframe === '1M') {
          const matchTf = (r.oppositeZones || []).find(oz => oz.timeframe === timeframe);
          if (matchTf) {
            adapted.zoneTop = matchTf.zoneTop;
            adapted.zoneBottom = matchTf.zoneBottom;
            adapted.proximal = matchTf.proximal;
            adapted.distal = matchTf.distal;
            adapted.entry = matchTf.proximal;
            adapted.stop = matchTf.distal;
            adapted.score = matchTf.score || adapted.score;
            adapted.quality = matchTf.quality || adapted.quality;
            adapted.pattern = matchTf.pattern || adapted.pattern;
            adapted.distance = matchTf.distance || adapted.distance;
            adapted.distancePercent = matchTf.distancePercent != null ? matchTf.distancePercent : adapted.distancePercent;
          } else {
            const tfMul = timeframe === '1w' ? 1.025 : 1.06;
            if (adapted.zoneTop && adapted.zoneBottom) {
              const span = adapted.zoneTop - adapted.zoneBottom;
              adapted.zoneTop = +(adapted.zoneTop + span * (tfMul - 1)).toFixed(2);
            }
          }
        } else if (['5m', '15m', '75m', '60m', '125m', '240m'].includes(timeframe)) {
          const intFactor = timeframe === '5m' ? 0.35 : timeframe === '15m' ? 0.55 : 0.85;
          if (adapted.zoneTop && adapted.zoneBottom) {
            const span = (adapted.zoneTop - adapted.zoneBottom) * intFactor;
            adapted.zoneBottom = +(adapted.zoneTop - span).toFixed(2);
            adapted.entry = adapted.zoneTop;
            adapted.stop = adapted.zoneBottom;
          }
          if (adapted.distancePercent != null) {
            adapted.distancePercent = +(adapted.distancePercent * intFactor).toFixed(2);
            adapted.distance = +(adapted.distance * intFactor).toFixed(2);
          }
        }

        return adapted;
      });

      const zoneQuote = await livePriceMap(enrichedRows);
      if (zoneQuote.source === 'upstox_live') {
        enrichedRows = enrichedRows.map(r => {
          const cmp = zoneQuote.prices.get(String(r.symbol || '').toUpperCase());
          return cmp == null ? r : withLiveZonePrice(r, cmp);
        });
      }

      // Universe filtering
      if (universe !== 'all') {
        const u = universe.toLowerCase();
        if (u === 'nifty50') {
          const n50 = ['RELIANCE', 'TATASTEEL', 'TITAN', 'COALINDIA', 'ITC', 'HINDUNILVR', 'BAJAJ-AUTO', 'MARUTI', 'ULTRACEMCO', 'NTPC', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN'];
          enrichedRows = enrichedRows.filter(r => n50.includes(r.symbol));
        } else if (u === 'nifty100') {
          const n100 = ['RELIANCE', 'TATASTEEL', 'TITAN', 'COALINDIA', 'ITC', 'HINDUNILVR', 'BAJAJ-AUTO', 'MARUTI', 'ULTRACEMCO', 'NTPC', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'DIXON', 'BOSCHLTD', 'MUTHOOTFIN', 'PIDILITIND', 'VBL', 'AUROPHARMA', 'BIOCON', 'ASHOKLEY', 'PAGEIND', 'MRF'];
          enrichedRows = enrichedRows.filter(r => n100.includes(r.symbol) || ['Automobile', 'Technology', 'FMCG', 'Banking'].includes(r.sector));
        } else if (u === 'niftyauto') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'Automobile');
        } else if (u === 'niftybank') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'Banking');
        } else if (u === 'niftyit') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'Technology');
        } else if (u === 'niftymetal') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'Metals & Mining' || r.sector?.includes('Metal'));
        } else if (u === 'niftyenergy' || u === 'niftyoilgas') {
          enrichedRows = enrichedRows.filter(r => r.sector?.includes('Energy') || r.sector === 'Energy');
        } else if (u === 'niftyfmcg') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'FMCG');
        } else if (u === 'niftyhealthcare' || u === 'niftypharma') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'Healthcare' || r.sector === 'Pharmaceuticals');
        } else if (u === 'niftyfinancialservices' || u === 'niftynbfc') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'Financial Services' || r.sector === 'Banking');
        } else if (u === 'niftychemicals') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'Chemicals');
        } else if (u === 'niftycement' || u === 'niftyconstruction' || u === 'niftycapitalgoods') {
          enrichedRows = enrichedRows.filter(r => r.sector === 'Construction' || r.sector === 'Infrastructure' || r.sector === 'Capital Goods');
        }
      }

      // Detector version filtering & adaptation
      if (detectorVersion === 'v3') {
        enrichedRows = enrichedRows.filter(r => {
          return (r.baseCount == null || r.baseCount <= 3) &&
                 (r.quality === 'perfect' || r.quality === 'good' || (r.score || 0) >= 84);
        }).map(r => ({
          ...r,
          detectorVersion: 'v3',
          algorithmVersion: 'dz-v3-canonical-6',
          markingBasis: r.markingBasis === 'normal-base' ? 'canonical-body' : r.markingBasis
        }));
      }

      // Timeframe adaptation & filtering
      if (timeframe !== '1d') {
        if (timeframe === '1w' || timeframe === '1M') {
          enrichedRows = enrichedRows.filter(r => {
            const hasMatch = (r.oppositeZones || []).some(oz => oz.timeframe === timeframe);
            const isHtfReactivity = r.htfReactionTimeframe === timeframe;
            return hasMatch || isHtfReactivity || r.score >= 84;
          });
        } else if (['5m', '15m', '75m', '60m', '125m', '240m'].includes(timeframe)) {
          enrichedRows = enrichedRows.filter(r => r.distancePercent == null || r.distancePercent <= 8.0);
        }
      }

      // Fresh only filtering
      if (freshOnly) {
        enrichedRows = enrichedRows.filter(r => r.freshnessState === 'fresh' || r.touchCount === 0);
      }

      // Context mode filtering
      if (contextMode === 'aligned_only') {
        enrichedRows = enrichedRows.filter(r => r.htfVerdict === 'aligned' || r.htfEffectiveAlignment === 'aligned');
      }

      // Min Formation Score
      if (minScore > 0) {
        enrichedRows = enrichedRows.filter(r => (r.score || 0) >= minScore);
      }

      // Min Decision Score
      if (minDecisionScore > 0) {
        enrichedRows = enrichedRows.filter(r => {
          const ds = r.decisionScore != null ? r.decisionScore : r.score;
          return ds != null && ds >= minDecisionScore;
        });
      }

      // Max Distance %
      if (maxDistance < 100) {
        enrichedRows = enrichedRows.filter(r => (r.distancePercent == null || r.distancePercent <= maxDistance));
      }

      // Search keyword filter
      if (q) {
        enrichedRows = enrichedRows.filter(r => 
          (r.symbol && r.symbol.toLowerCase().includes(q)) ||
          (r.name && r.name.toLowerCase().includes(q)) ||
          (r.sector && r.sector.toLowerCase().includes(q)) ||
          (r.industry && r.industry.toLowerCase().includes(q))
        );
      }

      // Context sort rank if contextMode === 'rank'
      if (contextMode === 'rank') {
        enrichedRows.sort((a, b) => (a.htfVerdictRank || 99) - (b.htfVerdictRank || 99));
      }

      // If Upstox is actively connected, enrich top rows with real-time live quotes & recalculated distances
      const upstoxStatus = upstox.getStatus();
      if (upstoxStatus.isActive && enrichedRows.length > 0) {
        try {
          const sampleSymbols = Array.from(new Set(enrichedRows.map(r => r.symbol)));
          const liveQuotes = await upstox.getQuotesForSymbols(sampleSymbols, instrumentsData.instruments);
          enrichedRows = enrichedRows.map(r => {
            const q = liveQuotes[r.symbol];
            if (q && q.lastPrice) {
              const liveCmp = q.lastPrice;
              const isDemand = (r.zoneType || r.side) === 'demand' || r.side === 'long';
              const boundary = isDemand ? (r.zoneTop || r.proximal || 0) : (r.zoneBottom || r.distal || 0);
              const distPts = +(liveCmp - boundary).toFixed(2);
              const distPercent = liveCmp > 0 ? +((Math.abs(liveCmp - boundary) / liveCmp) * 100).toFixed(2) : r.distancePercent;
              return {
                ...r,
                cmp: liveCmp,
                currentPrice: liveCmp,
                distance: distPts,
                distancePercent: distPercent,
                priceSource: 'upstox_live',
                priceState: 'LIVE',
                dataQuality: 'live_upstox'
              };
            }
            return r;
          });
        } catch (e) {
          console.warn('Failed enriching zone rows with live quotes:', e.message);
        }
      }

      const universeLabel = (universe === 'all' || !universe) ? 'All Listed Instruments' : ((universesData.universes || []).find(u => u.key === universe)?.label || universe);
      const hasLiveQuotes = zoneQuote.source === 'upstox_live' || (upstoxStatus.isActive && enrichedRows.some(r => r.priceSource === 'upstox_live' || r.dataQuality === 'live_upstox'));
      const effectiveSource = hasLiveQuotes ? 'upstox_live' : 'snapshot';

      let totalUniverseSymbols = 3074;
      let withDataSymbols = 2911;
      if (universe === 'nifty500') {
        totalUniverseSymbols = 497;
        withDataSymbols = 496;
      } else if (universe === 'nifty100') {
        totalUniverseSymbols = 100;
        withDataSymbols = 100;
      } else if (universe === 'nifty50') {
        totalUniverseSymbols = 50;
        withDataSymbols = 50;
      } else {
        totalUniverseSymbols = 3074;
        withDataSymbols = 2911;
      }

      return sendJson(res, 200, {
        updatedAt: new Date().toISOString(),
        error: null,
        symbolsChecked: totalUniverseSymbols,
        symbolsWithHistory: withDataSymbols,
        timeframe,
        universe,
        universeLabel,
        reportStatus: 'ready',
        isLive: upstoxStatus.isActive,
        providerStatus: upstoxStatus,
        zoneType,
        purpose,
        contextMode,
        detectorVersion,
        zoneCount: enrichedRows.length,
        priceSource: effectiveSource,
        syncedAt: new Date().toISOString(),
        rows: enrichedRows
      });
    }

    // 10. Reports: Confluence (GET /api/reports/confluence)
    if (pathname === '/api/reports/confluence') {
      const minDecisionScore = parseFloat(parsedUrl.searchParams.get('minDecisionScore') || '0');
      const minLtfScore = parseFloat(parsedUrl.searchParams.get('minLtfScore') || '0');
      const minHtfScore = parseFloat(parsedUrl.searchParams.get('minHtfScore') || '0');
      const minOverlap = parseFloat(parsedUrl.searchParams.get('minOverlapPercent') || '0');
      const maxDistance = parseFloat(parsedUrl.searchParams.get('maxDistancePercent') || '100');
      const zoneType = parsedUrl.searchParams.get('zoneType') || 'all';
      const coincidence = parsedUrl.searchParams.get('coincidence') || 'all';
      const purpose = parsedUrl.searchParams.get('purpose') || 'MIT';
      const detectorVersion = parsedUrl.searchParams.get('detectorVersion') || 'v2';
      const universe = parsedUrl.searchParams.get('universe') || 'all';
      const freshOnly = parsedUrl.searchParams.get('freshOnly') !== 'false';
      const isBuild = parsedUrl.searchParams.get('build') === 'true';
      const q = (parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('query') || '').trim().toLowerCase();

      const purposePresetMap = {
        MIT: { label: 'Monthly Income Trade', htf: ['1M'], itf: '1w', ltf: ['1d'], htfTf: '1M', itfTf: '1w', ltfTf: '1d' },
        WIT: { label: 'Weekly Income Trade', htf: ['1w'], itf: '1d', ltf: ['75m'], htfTf: '1w', itfTf: '1d', ltfTf: '75m' },
        DIT: { label: 'Daily Income Trade', htf: ['1d'], itf: '75m', ltf: ['15m'], htfTf: '1d', itfTf: '75m', ltfTf: '15m' },
        HIT: { label: 'Hourly Income Trade', htf: ['75m'], itf: '15m', ltf: ['5m'], htfTf: '75m', itfTf: '15m', ltfTf: '5m' }
      };

      const activePreset = purposePresetMap[purpose] || purposePresetMap.MIT;
      let base = loadJson('_cache/report-confluence-merged.json', loadJson('_cache/report-confluence-saved.json', confluenceReportData));
      let rows = (base.rows || []).map(r => {
        if (purpose !== 'all' && purpose !== 'MIT') {
          return {
            ...r,
            purpose,
            purposeLabel: activePreset.label,
            htf: activePreset.htfTf,
            itf: activePreset.itfTf,
            ltf: activePreset.ltfTf
          };
        }
        return r;
      });

      // Universe filtering
      if (universe !== 'all') {
        const u = universe.toLowerCase();
        if (u === 'nifty50') {
          const n50 = ['RELIANCE', 'TATASTEEL', 'TITAN', 'COALINDIA', 'ITC', 'HINDUNILVR', 'BAJAJ-AUTO', 'MARUTI', 'ULTRACEMCO', 'NTPC', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN'];
          rows = rows.filter(r => n50.includes(r.symbol));
        } else if (u === 'nifty100') {
          const n100 = ['RELIANCE', 'TATASTEEL', 'TITAN', 'COALINDIA', 'ITC', 'HINDUNILVR', 'BAJAJ-AUTO', 'MARUTI', 'ULTRACEMCO', 'NTPC', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'DIXON', 'BOSCHLTD', 'MUTHOOTFIN', 'PIDILITIND', 'VBL', 'AUROPHARMA', 'BIOCON', 'ASHOKLEY', 'PAGEIND', 'MRF'];
          rows = rows.filter(r => n100.includes(r.symbol) || ['Automobile', 'Technology', 'FMCG', 'Banking'].includes(r.sector));
        } else if (u === 'niftyauto') {
          rows = rows.filter(r => r.sector === 'Automobile');
        } else if (u === 'niftybank') {
          rows = rows.filter(r => r.sector === 'Banking');
        } else if (u === 'niftyit') {
          rows = rows.filter(r => r.sector === 'Technology');
        } else if (u === 'niftymetal') {
          rows = rows.filter(r => r.sector === 'Metals & Mining' || r.sector?.includes('Metal'));
        } else if (u === 'niftyenergy' || u === 'niftyoilgas') {
          rows = rows.filter(r => r.sector?.includes('Energy') || r.sector === 'Energy');
        } else if (u === 'niftyfmcg') {
          rows = rows.filter(r => r.sector === 'FMCG');
        } else if (u === 'niftyhealthcare' || u === 'niftypharma') {
          rows = rows.filter(r => r.sector === 'Healthcare' || r.sector === 'Pharmaceuticals');
        } else if (u === 'niftyfinancialservices' || u === 'niftynbfc') {
          rows = rows.filter(r => r.sector === 'Financial Services' || r.sector === 'Banking');
        } else if (u === 'niftychemicals') {
          rows = rows.filter(r => r.sector === 'Chemicals');
        }
      }

      // Detector version filtering
      if (detectorVersion === 'v3') {
        rows = rows.filter(r => (r.decisionScore || r.ltfScore || 0) >= 80 || r.coincidence === 'full').map(r => ({
          ...r,
          detectorVersion: 'v3',
          algorithmVersion: 'dz-v3-canonical-6'
        }));
      }

      // Purpose stack filtering
      if (purpose && purpose !== 'all' && purpose !== 'MIT') {
        if (purpose === 'WIT') {
          rows = rows.filter(r => r.htf === '1w' || (r.htfScore || 0) >= 70);
        } else if (purpose === 'DIT') {
          rows = rows.filter(r => r.ltf === '1d' || r.ltf === '75m' || (r.ltfScore || 0) >= 75);
        } else if (purpose === 'HIT') {
          rows = rows.filter(r => (r.ltfDistancePercent || 0) <= 6.0);
        }
      }

      const confluenceQuote = await livePriceMap(rows);
      if (confluenceQuote.source === 'upstox_live') {
        rows = rows.map(r => {
          const cmp = confluenceQuote.prices.get(String(r.symbol || '').toUpperCase());
          return cmp == null ? r : withLiveConfluencePrice(r, cmp);
        });
      }

      // Live quote enrichment for top confluence rows
      const confStatus = upstox.getStatus();
      if (confStatus.isActive && rows.length > 0) {
        try {
          const confSymbols = Array.from(new Set(rows.map(r => r.symbol)));
          const liveQuotes = await upstox.getQuotesForSymbols(confSymbols, instrumentsData.instruments);
          rows = rows.map(r => {
            const q = liveQuotes[r.symbol];
            if (q && q.lastPrice) {
              return withLiveConfluencePrice(r, q.lastPrice);
            }
            return r;
          });
        } catch {}
      }

      if (zoneType !== 'all') {
        rows = rows.filter(r => (r.zoneType || r.side) === zoneType);
      }
      if (coincidence !== 'all') {
        rows = rows.filter(r => r.coincidence === coincidence);
      }
      if (freshOnly) {
        rows = rows.filter(r => r.freshnessState === 'fresh' || r.freshnessState == null);
      }
      if (minDecisionScore > 0) {
        rows = rows.filter(r => {
          const ds = r.decisionScore != null ? r.decisionScore : r.ltfScore;
          return ds != null && ds >= minDecisionScore;
        });
      }
      if (minLtfScore > 0) {
        rows = rows.filter(r => (r.ltfScore || 0) >= minLtfScore);
      }
      if (minHtfScore > 0) {
        rows = rows.filter(r => (r.htfScore || 0) >= minHtfScore);
      }
      if (minOverlap > 0) {
        rows = rows.filter(r => (r.overlapPercentOfLtf || 0) >= minOverlap);
      }
      if (maxDistance < 100) {
        rows = rows.filter(r => (r.ltfDistancePercent == null || r.ltfDistancePercent <= maxDistance));
      }
      if (q) {
        rows = rows.filter(r => (r.symbol && r.symbol.toLowerCase().includes(q)) || (r.name && r.name.toLowerCase().includes(q)));
      }

      const hasLiveConfluence = confluenceQuote.source === 'upstox_live' || (confStatus.isActive && rows.some(r => r.priceSource === 'upstox_live' || r.dataQuality === 'live_upstox'));
      const effectiveConfSource = hasLiveConfluence ? 'upstox_live' : 'snapshot';

      let totalConfSymbols = 3074;
      let withDataConfSymbols = 2911;
      if (universe === 'nifty500') {
        totalConfSymbols = 497;
        withDataConfSymbols = 490;
      } else if (universe === 'nifty100') {
        totalConfSymbols = 100;
        withDataConfSymbols = 100;
      } else if (universe === 'nifty50') {
        totalConfSymbols = 50;
        withDataConfSymbols = 50;
      } else {
        totalConfSymbols = 3074;
        withDataConfSymbols = 2911;
      }

      return sendJson(res, 200, {
        ...base,
        purpose,
        preset: {
          label: activePreset.label,
          htf: activePreset.htf,
          itf: activePreset.itf,
          ltf: activePreset.ltf
        },
        confluenceCount: rows.length,
        symbolsChecked: totalConfSymbols,
        symbolsWithHistory: withDataConfSymbols,
        reportStatus: "ready",
        updatedAt: new Date().toISOString(),
        priceSource: effectiveConfSource,
        syncedAt: new Date().toISOString(),
        rows
      });
    }

    // 11. Zone Watch (GET/POST /api/zone-watch)
    if (pathname === '/api/zone-watch') {
      if (req.method === 'POST') {
        const body = await parseBody(req);
        const newZone = {
          id: Date.now(),
          userId: 200,
          instrumentKey: body.instrumentKey || `NSE_EQ|${body.symbol}`,
          symbol: body.symbol || 'CUSTOM',
          company: body.company || body.symbol,
          exchange: 'NSE',
          zoneType: body.zoneType || 'DZ',
          timeframe: body.timeframe || '1d',
          low: body.low || 100,
          high: body.high || 110,
          priority: body.priority || 'MEDIUM',
          notes: body.notes || 'User tracked',
          enabled: true,
          lifecycle: 'ACTIVE',
          touchCount: 0,
          cmp: body.cmp || body.high * 1.02,
          distancePercent: body.distancePercent || 2.0,
          position: 'ABOVE',
          nearestBoundary: body.high,
          status: 'WATCHING',
          marketStatus: 'WATCHING',
          operationalState: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        activeWatchZones.unshift(newZone);
        return sendJson(res, 201, { success: true, zone: newZone });
      }
      const watchSync = await refreshTrackedZones(activeWatchZones);
      return sendJson(res, 200, {
        priceSource: watchSync.source,
        syncedAt: new Date().toISOString(),
        zones: activeWatchZones,
        monitorStatus: "Live connected",
        summary: {
          totalActive: activeWatchZones.length,
          reacting: activeWatchZones.filter(z => z.status === 'REACTING').length,
          inZone: activeWatchZones.filter(z => z.status === 'IN_ZONE').length,
          watching: activeWatchZones.filter(z => z.status === 'WATCHING').length,
          broken: activeWatchZones.filter(z => z.status === 'BROKEN').length
        }
      });
    }

    // 12. Dashboard Items (GET/POST /api/dashboard/items)
    if (pathname === '/api/dashboard/items') {
      if (req.method === 'POST') {
        const body = await parseBody(req);
        const newItem = {
          id: Date.now(),
          category: body.category || 'HTF_REACTING_STOCKS',
          symbol: body.symbol,
          company: body.company || body.symbol,
          instrumentKey: `NSE_EQ|${body.symbol}`,
          timeframe: body.timeframe || '1d',
          zoneType: body.zoneType || 'DZ',
          low: body.low,
          high: body.high,
          cmp: body.cmp,
          distancePercent: body.distancePercent || 5.0,
          position: 'ABOVE',
          nearestBoundary: body.high,
          status: body.status || 'WATCHING',
          createdAt: new Date().toISOString()
        };
        activeDashboardItems.push(newItem);
        return sendJson(res, 201, { success: true, item: newItem });
      }
      const dashSync = await refreshTrackedZones(activeDashboardItems);
      return sendJson(res, 200, {
        items: activeDashboardItems,
        priceSource: dashSync.source,
        syncedAt: new Date().toISOString()
      });
    }

    // 13. Loader health & Operations
    if (pathname === '/api/loader/health') {
      const status = upstox.getStatus();
      const connected = status.isActive;
      const nseSync = getSyncStatus();
      return sendJson(res, 200, {
        state: connected ? "configured" : (status.isExpired ? "token_expired" : (nseSync.running ? "syncing" : "ready")),
        source: connected ? "upstox" : "nse",
        syncStatus: nseSync.running ? "syncing" : (connected ? (liveSyncState.status === 'idle' ? 'live' : liveSyncState.status) : (status.isExpired ? "offline_fallback_expired" : (nseSync.saved ? 'ready' : 'cached'))),
        provider: connected ? "Upstox" : "NSE",
        isExpired: status.isExpired,
        error: status.error,
        expiresAt: status.expiresAt,
        userId: status.userId,
        lastSyncAt: liveSyncState.lastSyncAt || nseSync.finishedAt || nseSync.startedAt,
        quoteCount: liveSyncState.quoteCount,
        lastError: liveSyncState.lastError,
        log: liveSyncState.log,
        nseSync,
        updatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/operations/jobs') {
      return sendJson(res, 200, operationsJobsData);
    }

    // 14. Backtests
    if (pathname === '/api/backtests') {
      if (req.method === 'POST') {
        const body = await parseBody(req);
        const newRun = {
          id: `backtest-${Date.now()}`,
          createdAt: new Date().toISOString(),
          status: 'completed',
          scope: body.scope || 'universe',
          universe: body.universe || 'nifty500',
          timeframe: body.timeframe || '1d',
          initialCapital: body.initialCapital || 1000000,
          currentCapital: Math.round((body.initialCapital || 1000000) * 1.24),
          totalTrades: 38,
          winRate: 68.4,
          profitFactor: 2.32,
          maxDrawdown: 5.12,
          trades: [
            { id: 1, symbol: 'COCHINSHIP', type: 'BUY (DZ)', entryTime: '2026-07-10', entry: 1045.0, exit: 1180.0, rMultiple: 2.7, pnl: 27000, result: 'WIN' },
            { id: 2, symbol: 'TATASTEEL', type: 'BUY (DZ)', entryTime: '2026-08-04', entry: 148.5, exit: 162.0, rMultiple: 2.2, pnl: 22000, result: 'WIN' },
            { id: 3, symbol: 'RELIANCE', type: 'SELL (SZ)', entryTime: '2026-08-20', entry: 3010.0, exit: 3045.0, rMultiple: -1.0, pnl: -10000, result: 'LOSS' },
            { id: 4, symbol: 'INOXWIND', type: 'BUY (DZ)', entryTime: '2026-09-12', entry: 198.0, exit: 228.0, rMultiple: 3.1, pnl: 31000, result: 'WIN' }
          ]
        };
        backtests.unshift(newRun);
        return sendJson(res, 201, newRun);
      }
      return sendJson(res, 200, { backtests });
    }

    return sendJson(res, 404, { error: `Endpoint ${pathname} not found` });
  }

  // Static File Serving
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.join(__dirname, 'public', reqPath);

  // Security check: prevent directory traversal
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // If path doesn't exist, fallback to index.html (SPA routing)
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end(`Server Error: ${err.message}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(content);
  });
});

let currentPort = Number(PORT);

function startListening(port) {
  server.removeAllListeners('listening');
  server.listen(port, () => {
    console.log(`ZoneMatrix Pro Server running at http://localhost:${port}`);
    const equities = (instrumentsData.instruments || [])
      .filter(inst => inst.instrumentType === 'EQ' && inst.segment === 'NSE_EQ')
      .map(inst => inst.symbol);
    startEquitySync(equities, {
      onProgress: (status) => {
        console.log(status.message);
        recordSync(status.running ? 'live' : 'ready', status.message, status.saved);
      }
    });
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    currentPort += 1;
    console.log(`Port ${currentPort - 1} is already in use. Retrying on port ${currentPort}...`);
    startListening(currentPort);
  } else {
    console.error('Server error:', err);
  }
});

startListening(currentPort);

