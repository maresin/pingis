import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentName } from './types';

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  source: 'apikey-file' | 'env' | 'settings';
  maxContextChars: number;
}

const DEFAULT_CONTEXT_CHARS = 1_000_000;

export function stateDirFor(who: AgentName): string {
  return path.join(os.homedir(), '.pingis', who);
}

export function apiKeyPathFor(who: AgentName): string {
  return path.join(stateDirFor(who), '.api-key');
}

/**
 * Read API settings. The API directory is the READ-ONLY source of .env.
 * The key is read from ~/.pingis/<who>/.api-key, where it is written
 * by the API process itself (we redirect DEEPSEEK_API_KEY_PATH).
 */
export function loadApiConfig(
  apiDir: string,
  fallbackBaseUrl: string,
  fallbackApiKey: string,
  who?: AgentName
): ApiConfig {
  const dir = expandHome(apiDir);

  const envPath = dir ? path.join(dir, '.env') : '';
  const env = envPath && fs.existsSync(envPath) ? readEnv(envPath) : {};

  // IMPORTANT: do NOT overwrite baseUrl from .env.
  // We assigned the port when spawning the API process (panel.ts), and .env
  // may contain a stale PORT from manual runs. If we take it here,
  // both clients (executor/critic) will go to the same port
  // and the second will get 401 from the wrong key.
  const baseUrl = fallbackBaseUrl;

  let maxContextChars = DEFAULT_CONTEXT_CHARS;
  if (env.DEEPSEEK_MAX_CONTEXT_CHARS) {
    const n = parseInt(env.DEEPSEEK_MAX_CONTEXT_CHARS, 10);
    if (Number.isFinite(n) && n > 0) maxContextChars = n;
  }

  // Agent key — only from ~/.pingis/<who>/.api-key.
  // Do NOT fall back to apiDir/.api-key: it may contain a key
  // from manual API runs that our process does not recognize.
  if (who) {
    const keyPath = apiKeyPathFor(who);
    if (fs.existsSync(keyPath)) {
      const apiKey = fs.readFileSync(keyPath, 'utf-8').trim();
      if (apiKey) return { baseUrl, apiKey, source: 'apikey-file', maxContextChars };
    }
    // File missing — return empty key. panel.ts will see it and show
    // a clear error to the user.
    return { baseUrl, apiKey: '', source: 'apikey-file', maxContextChars };
  }

  // The branch without `who` — only for probe scripts or debugging.
  if (dir) {
    const legacyKeyPath = path.join(dir, '.api-key');
    if (fs.existsSync(legacyKeyPath)) {
      const apiKey = fs.readFileSync(legacyKeyPath, 'utf-8').trim();
      if (apiKey) return { baseUrl, apiKey, source: 'apikey-file', maxContextChars };
    }
  }

  if (env.API_KEY) {
    return { baseUrl, apiKey: env.API_KEY, source: 'env', maxContextChars };
  }

  return { baseUrl, apiKey: fallbackApiKey, source: 'settings', maxContextChars };
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
