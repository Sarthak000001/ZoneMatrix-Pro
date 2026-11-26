/**
 * Upstox Access Token Generator Helper
 * Run: node get-token.mjs
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, '_cache/upstox-config.json');
const ENV_FILE = path.join(__dirname, '.env');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

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

async function main() {
  console.log('\n======================================================');
  console.log('       Upstox API v2 - Token & Analytics Setup');
  console.log('======================================================\n');

  console.log('💡 RECOMMENDED: 1-Year Upstox Analytics Token (No 3:30 AM Expiry)');
  console.log('Unlike standard trading tokens that expire daily at 3:30 AM,');
  console.log('Upstox Analytics Tokens remain active for 1 full year for');
  console.log('streaming live quotes, prices, and historical candles.');
  console.log('\nTo get your 1-Year Analytics Token:');
  console.log('  1. Open https://developer.upstox.com/ and log in');
  console.log('  2. Click on your App and select the "Analytics" tab');
  console.log('  3. Click "Generate Token" and copy the token string\n');

  const haveAnalytics = await prompt('Do you want to paste a 1-Year Analytics Token? (Y/n) [Y]: ');
  if (!haveAnalytics.trim() || haveAnalytics.trim().toLowerCase().startsWith('y')) {
    const rawToken = await prompt('\nPaste your Upstox Analytics Token: ');
    const token = rawToken.trim();
    if (!token) {
      console.error('Error: No token entered.');
      rl.close();
      return;
    }

    console.log('\nValidating Analytics Token with Upstox Market Data API...');
    try {
      const testRes = await fetch('https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_INDEX|Nifty 50', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });

      if (!testRes.ok) {
        const err = await testRes.json().catch(() => ({}));
        const msg = err.errors?.[0]?.message || err.message || `Upstox returned status ${testRes.status}`;
        console.error(`\nValidation failed: ${msg}`);
        rl.close();
        return;
      }

      // Try fetching profile if available
      let userName = 'Upstox Analytics User';
      try {
        const profRes = await fetch('https://api.upstox.com/v2/user/profile', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        if (profRes.ok) {
          const prof = await profRes.json();
          userName = prof.data?.user_name || prof.data?.email || userName;
        }
      } catch {}

      // Save to .env (primary secure source)
      updateEnvFile({
        UPSTOX_ANALYTICS_TOKEN: token,
        UPSTOX_ACCESS_TOKEN: token
      });

      // Save to _cache/upstox-config.json
      try {
        const cacheDir = path.dirname(CONFIG_FILE);
        if (fs.existsSync(cacheDir)) {
          const configToSave = {
            accessToken: token,
            userName,
            isActive: true,
            isAnalytics: true,
            lastValidated: new Date().toISOString()
          };
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2));
        }
      } catch {}

      console.log('\n======================================================');
      console.log(`SUCCESS! 1-Year Analytics Token Configured (${userName})`);
      console.log('======================================================');
      console.log(`Token: ${token.slice(0, 15)}...${token.slice(-8)}`);
      console.log(`Saved securely to .env as UPSTOX_ANALYTICS_TOKEN`);
      console.log('🎉 No daily 3:30 AM expiration required!');
      console.log('\nYou can now start the application:');
      console.log('  npm start');
      console.log('======================================================\n');
    } catch (err) {
      console.error('Validation error:', err.message);
    } finally {
      rl.close();
    }
    return;
  }

  console.log('\nProceeding with Standard OAuth Token Generator (Expires daily at 3:30 AM)...');

  // Load existing config if available
  let existing = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {}
  }

  const defaultApiKey = process.env.UPSTOX_API_KEY || existing.apiKey || '';
  const defaultSecret = process.env.UPSTOX_API_SECRET || existing.apiSecret || '';
  const defaultRedirect = process.env.UPSTOX_REDIRECT_URI || existing.redirectUri || 'http://localhost:3000';

  const apiKeyInput = await prompt(`1. Enter your Upstox API Key (Client ID) ${defaultApiKey ? `[${defaultApiKey}]` : ''}: `);
  const apiKey = (apiKeyInput.trim() || defaultApiKey).trim();

  if (!apiKey) {
    console.error('Error: API Key is required. Get it from https://developer.upstox.com');
    rl.close();
    return;
  }

  const secretInput = await prompt(`2. Enter your Upstox API Secret ${defaultSecret ? '[saved]' : ''}: `);
  const apiSecret = (secretInput.trim() || defaultSecret).trim();

  if (!apiSecret) {
    console.error('Error: API Secret is required.');
    rl.close();
    return;
  }

  const redirectInput = await prompt(`3. Enter your Redirect URL [${defaultRedirect}]: `);
  const redirectUri = (redirectInput.trim() || defaultRedirect).trim();

  const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(apiKey)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log('\n------------------------------------------------------');
  console.log('4. Open this URL in your browser to log in to Upstox:');
  console.log('------------------------------------------------------');
  console.log(`\n  ${authUrl}\n`);
  console.log('Log in with your Mobile number, OTP, and 6-digit PIN.');
  console.log(`After login, your browser will redirect to a URL like:`);
  console.log(`  ${redirectUri}/?code=XXXXXX`);
  console.log('------------------------------------------------------\n');

  const codeOrUrl = await prompt('5. Paste the redirected URL (or just the "code"): ');
  let authCode = codeOrUrl.trim();

  if (authCode.includes('code=')) {
    const match = authCode.match(/[?&]code=([^&]+)/);
    if (match) {
      authCode = decodeURIComponent(match[1]);
    }
  }

  if (!authCode) {
    console.error('Error: Invalid auth code provided.');
    rl.close();
    return;
  }

  console.log('\nExchanging auth code for Access Token...');

  try {
    const bodyParams = new URLSearchParams({
      code: authCode,
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
      console.error('\nFailed to generate Access Token:');
      console.error(data.errors || data.message || data);
      rl.close();
      return;
    }

    const accessToken = data.access_token;
    const userName = data.user_name || data.email || 'Upstox Trader';

    // Save to .env (primary secure source)
    updateEnvFile({
      UPSTOX_API_KEY: apiKey,
      UPSTOX_API_SECRET: apiSecret,
      UPSTOX_REDIRECT_URI: redirectUri,
      UPSTOX_ANALYTICS_TOKEN: accessToken,
      UPSTOX_ACCESS_TOKEN: accessToken
    });

    // Save to _cache/upstox-config.json if cache directory exists
    try {
      const cacheDir = path.dirname(CONFIG_FILE);
      if (fs.existsSync(cacheDir)) {
        const configToSave = {
          apiKey,
          apiSecret,
          redirectUri,
          accessToken,
          userName,
          userId: data.user_id,
          isActive: true,
          lastValidated: new Date().toISOString()
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2));
      }
    } catch {}

    console.log('\n======================================================');
    console.log(`SUCCESS! Connected to Upstox as: ${userName}`);
    console.log('======================================================');
    console.log(`Access Token: ${accessToken.slice(0, 15)}...${accessToken.slice(-8)}`);
    console.log(`Saved securely to .env (git-ignored)`);
    console.log('\nYou can now start the application:');
    console.log('  npm start');
    console.log('======================================================\n');
  } catch (err) {
    console.error('Network / Request error:', err.message);
  } finally {
    rl.close();
  }
}

main();
