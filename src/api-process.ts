import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentName } from './types';
import { Logger } from './log';

const IS_WINDOWS = process.platform === 'win32';

export interface ApiProcessOptions {
  apiDir: string;
  port: number;
  who: AgentName;
  logger: Logger;
  startupTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;

export class ApiProcess {
  private child: ChildProcess | null = null;
  private startedByUs = false;
  private stateDir: string;

  constructor(private opts: ApiProcessOptions) {
    const home = os.homedir();
    this.stateDir = path.join(home, '.pingis', opts.who);
  }

  get port(): number { return this.opts.port; }
  get baseUrl(): string { return `http://127.0.0.1:${this.opts.port}`; }
  get keyPath(): string { return path.join(this.stateDir, '.api-key'); }

  async ensureRunning(): Promise<void> {
    if (!fs.existsSync(path.join(this.opts.apiDir, '.env'))) {
      throw new Error(
        `File not found: ${path.join(this.opts.apiDir, '.env')}. ` +
        `Set a valid pingis.apiDir in settings.`
      );
    }

    this.killPortOccupants();

    fs.mkdirSync(this.stateDir, { recursive: true });

    // Delete stale .api-key; otherwise waitForKeyFile returns
    // instantly, we send the old key, and the API replies 401/503.
    const staleKey = path.join(this.stateDir, '.api-key');
    try { fs.unlinkSync(staleKey); } catch { /* already gone */ }

    await this.spawnProcess();
    await this.waitReady();
  }

  stop(): void {
    if (!this.startedByUs || !this.child) return;
    const pid = this.child.pid;
    this.startedByUs = false;
    this.child = null;
    if (!pid) return;

    this.opts.logger.event('orchestrator', 'api_exit', {
      agent: this.opts.who, code: 0, reason: 'stop_requested'
    });

    killProcessTree(pid);
  }

  private killPortOccupants(): void {
    const port = this.opts.port;

    if (IS_WINDOWS) {
      this.killPortWindows(port);
    } else {
      this.killPortUnix(port);
    }
  }

  private killPortWindows(port: number): void {
    let pids: number[] = [];

    try {
      // netstat -ano: last column is PID. Filter to LISTENING.
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf-8',
        windowsHide: true
      });
      const seen = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        if (Number.isFinite(pid) && pid > 0) seen.add(pid);
      }
      pids = [...seen];
    } catch {
      // findstr found nothing -> port is free.
    }

    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, {
          stdio: 'ignore',
          windowsHide: true
        });
      } catch { /* ignore */ }
    }

    if (pids.length > 0) {
      this.opts.logger.event('orchestrator', 'api_cleanup', {
        agent: this.opts.who, port, killed_pids: pids
      });
      try { execSync('timeout /t 1 /nobreak >nul', { stdio: 'ignore', windowsHide: true }); } catch {}
    }
  }

  private killPortUnix(port: number): void {
    let pids: number[] = [];

    try {
      const out = execSync(`lsof -ti:${port} 2>/dev/null || true`, {
        encoding: 'utf-8'
      }).trim();
      if (out) {
        pids = out.split(/\s+/).filter(Boolean).map(s => parseInt(s, 10));
      }
    } catch {
      try {
        execSync(`fuser -k ${port}/tcp 2>/dev/null || true`);
      } catch { /* ignore */ }
    }

    for (const pid of pids) {
      if (!Number.isFinite(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }

    if (pids.length > 0) {
      this.opts.logger.event('orchestrator', 'api_cleanup', {
        agent: this.opts.who, port, killed_pids: pids
      });
      try { execSync('sleep 1'); } catch {}
    }
  }

  private async spawnProcess(): Promise<void> {
    const envVars = readEnv(path.join(this.opts.apiDir, '.env'));

    const overrides: Record<string, string> = {
      PORT: String(this.opts.port),
      DEEPSEEK_STATE_PATH: path.join(this.stateDir, 'state.json'),
      DEEPSEEK_CHAT_STATE_PATH: path.join(this.stateDir, 'chat_state.json'),
      DEEPSEEK_API_KEY_PATH: path.join(this.stateDir, '.api-key'),
      DEEPSEEK_UPLOAD_DIR: path.join(this.stateDir, 'uploads'),
      RAG_DATA_DIR: path.join(this.stateDir, 'rag_data')
    };

    this.opts.logger.event('orchestrator', 'api_spawn', {
      agent: this.opts.who,
      api_dir: this.opts.apiDir,
      port: this.opts.port,
      state_dir: this.stateDir
    });

    this.child = spawn('npm', ['start'], {
      cwd: this.opts.apiDir,
      env: { ...process.env, ...envVars, ...overrides },
      shell: true,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.startedByUs = true;

    const prefix = this.opts.who === 'executor' ? '[api-e]' : '[api-c]';
    const forward = (stream: NodeJS.ReadableStream) => {
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) this.opts.logger.raw(`${prefix} ${line}`);
        }
      });
    };
    if (this.child.stdout) forward(this.child.stdout);
    if (this.child.stderr) forward(this.child.stderr);

    this.child.on('exit', (code) => {
      if (this.startedByUs) {
        this.opts.logger.event('orchestrator', 'api_exit', {
          agent: this.opts.who, code: code ?? -1, reason: 'unexpected'
        });
      }
      this.startedByUs = false;
      this.child = null;
    });

    this.child.on('error', (err) => {
      this.opts.logger.event('orchestrator', 'api_exit', {
        agent: this.opts.who, code: -1, reason: 'spawn_error', error: String(err)
      });
    });
  }

  private async waitReady(): Promise<void> {
    const timeout = this.opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.ping()) {
        this.opts.logger.event('orchestrator', 'api_ready', {
          agent: this.opts.who,
          port: this.opts.port,
          state_dir: this.stateDir
        });
        return;
      }
      await sleep(1000);
    }
    throw new Error(
      `API (${this.opts.who}) did not respond at ${this.baseUrl} ` +
      `within ${Math.round(timeout / 1000)}s. Check Output → Pingis.`
    );
  }

  private async ping(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const r = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return r.ok;
    } catch {
      return false;
    }
  }
}

function killProcessTree(pid: number): void {
  if (IS_WINDOWS) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch { /* already dead */ }
    return;
  }

  try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
  }, 8000);
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

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}
