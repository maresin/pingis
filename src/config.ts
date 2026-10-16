import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AgentEndpoint {
  // Currently unused. Intended for logging agent identity
  // (agent-1 / agent-2) next to executor / critic in api_ready /
  // api_exit events. Remove if no such log line is planned.
  name: string;      // "agent-1" | "agent-2"
  dir: string;       // absolute path to agent-N/
  port: number;
  apiKey: string;
  // Feature flags read from agent.env (written by
  // make-multi-agent.sh). Recorded in task_start so the log shows
  // which configuration a task ran under.
  enableRag: boolean;
  enableSnapshot: boolean;
  enableRestore: boolean;
}

export interface AgentsDeployment {
  root: string;        // ~/.pingis/deepseek-agents
  apiDir: string;      // <apiDir> — where make-multi-agent.sh lives
  executor: AgentEndpoint;
  critic: AgentEndpoint;
}

/**
 * Pingis builds and uses the multi-agent deployment itself.
 *
 * Location: ~/.pingis/deepseek-agents/
 * Built once by: <apiDir>/tools/make-multi-agent.sh ~/.pingis
 *
 * Requires <apiDir>/state.json to exist (user must have logged in
 * to DeepSeek at least once via `npm start` in apiDir).
 */
export function loadAgentsDeployment(apiDir: string): AgentsDeployment {
  const api = expandHome(apiDir);

  if (!api) {
    throw new Error(
      'pingis.apiDir is not set. Point it to your clone of ' +
      'deepseek-automation-api.'
    );
  }
  if (!fs.existsSync(api)) {
    throw new Error(`apiDir does not exist: ${api}`);
  }
  if (!fs.existsSync(path.join(api, 'state.json'))) {
    throw new Error(
      `Login not found: ${path.join(api, 'state.json')}.\n` +
      `Run this ONCE, by hand:\n` +
      `    cd ${api}\n` +
      `    npm start\n` +
      `Log in to DeepSeek in the browser window, wait for ` +
      `"DeepSeek client ready", then press Ctrl+C.\n` +
      `Then start the task again.`
    );
  }

  const root = path.join(os.homedir(), '.pingis', 'deepseek-agents');

  return {
    root,
    apiDir: api,
    executor: readAgent(root, 1),
    critic: readAgent(root, 2)
  };
}

export function deploymentExists(d: AgentsDeployment): boolean {
  try {
    return (
      fs.existsSync(path.join(d.root, 'scripts', 'start-all.sh')) &&
      fs.existsSync(path.join(d.root, 'agents', 'agent-1', 'agent.env')) &&
      fs.existsSync(path.join(d.root, 'agents', 'agent-2', 'agent.env'))
    );
  } catch {
    return false;
  }
}

function readAgent(root: string, index: number): AgentEndpoint {
  const name = `agent-${index}`;
  const dir = path.join(root, 'agents', name);

  const envPath = path.join(dir, 'agent.env');
  const keyPath = path.join(dir, '.api-key');

  // These may not exist yet — deployment can be built later.
  // Caller must check deploymentExists() first.
  if (!fs.existsSync(envPath) || !fs.existsSync(keyPath)) {
    return {
      name, dir, port: 0, apiKey: '',
      enableRag: false, enableSnapshot: false, enableRestore: false
    };
  }

  const env = readEnv(envPath);
  const port = parseInt(env.PORT ?? '', 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT in ${envPath}`);
  }

  const apiKey = fs.readFileSync(keyPath, 'utf-8').trim();
  if (!apiKey) {
    throw new Error(`Empty .api-key: ${keyPath}`);
  }

  return {
    name, dir, port, apiKey,
    enableRag: parseBool(env.ENABLE_RAG),
    enableSnapshot: parseBool(env.ENABLE_SNAPSHOT),
    enableRestore: parseBool(env.ENABLE_RESTORE)
  };
}

/**
 * Parse a boolean env value strictly. Only the exact string "true"
 * (case-insensitive, trimmed) is true. Everything else — including
 * "false", "0", "no", and unset — is false.
 */
function parseBool(v: string | undefined): boolean {
  return (v ?? '').trim().toLowerCase() === 'true';
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
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
