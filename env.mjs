import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads key-value pairs from .env into process.env.
 * Uses native process.loadEnvFile (Node 20.6+) when available,
 * with a universal fallback parser for older Node versions.
 */
export function loadEnv(customPath) {
  const envPath = customPath || path.join(__dirname, '.env');
  
  if (typeof process.loadEnvFile === 'function') {
    try {
      if (fs.existsSync(envPath)) {
        process.loadEnvFile(envPath);
        return;
      }
    } catch {
      // Fallback if process.loadEnvFile encounters parsing quirks
    }
  }

  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Env] Notice: .env file not parsed:', err.message);
  }
}

// Automatically execute on import
loadEnv();
