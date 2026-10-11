#!/usr/bin/env python3
"""
Step 31: Pingis owns the multi-agent deployment.

Real user does only three things:
  1. Install DeepSeek Automation API.
  2. Install Pingis.
  3. Log in to DeepSeek once (npm start, browser, Ctrl+C).

Pingis does the rest by itself:
  - calls make-multi-agent.sh on first task (if the deployment is missing),
  - reads agents/agent-N/agent.env and .api-key,
  - calls start-all.sh before each task (if agents are down),
  - calls stop-all.sh after each task (only if we started them).

Settings: only pingis.apiDir is required.

Run from pingis/:
    python scripts/dev/apply_step31_agents.py
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BACKUP = ROOT / '.backup'


# ============ src/config.ts (rewrite) ============

CONFIG_TS = r'''import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AgentEndpoint {
  name: string;      // "agent-1" | "agent-2"
  dir: string;       // absolute path to agent-N/
  port: number;
  apiKey: string;
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
    return { name, dir, port: 0, apiKey: '' };
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

  return { name, dir, port, apiKey };
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
'''


# ============ src/api-process.ts (rewrite) ============

API_PROCESS_TS = r'''import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './log';
import {
  AgentsDeployment,
  deploymentExists,
  loadAgentsDeployment
} from './config';

const STARTUP_TIMEOUT_MS = 240_000;

/**
 * Orchestrates the multi-agent deployment produced by
 * make-multi-agent.sh.
 *
 * Lifecycle:
 *   ensureRunning():
 *     - if deployment folder missing → build it with make-multi-agent.sh
 *     - if both agents already answer /v1/context/status → nothing to do
 *     - else → run scripts/start-all.sh, wait for readiness
 *   stop():
 *     - if we started the agents ourselves → run scripts/stop-all.sh
 */
export class AgentsProcess {
  private deployment: AgentsDeployment;
  private startedByUs = false;

  constructor(
    apiDir: string,
    private log: Logger
  ) {
    this.deployment = loadAgentsDeployment(apiDir);
  }

  get executor() { return this.deployment.executor; }
  get critic() { return this.deployment.critic; }

  async ensureRunning(): Promise<void> {
    if (!deploymentExists(this.deployment)) {
      this.buildDeployment();
      // reload after build — ports and keys are now on disk
      this.deployment = loadAgentsDeployment(this.deployment.apiDir);
    }

    if (await this.bothReady()) {
      this.log.event('orchestrator', 'api_ready', {
        agents_dir: this.deployment.root,
        reused: true
      });
      return;
    }

    const script = path.join(this.deployment.root, 'scripts', 'start-all.sh');
    this.log.event('orchestrator', 'api_spawn', {
      agents_dir: this.deployment.root,
      script
    });

    await this.runScriptSync(script, 'start-all.sh');

    this.startedByUs = true;

    await this.waitBothReady(STARTUP_TIMEOUT_MS);

    this.log.event('orchestrator', 'api_ready', {
      agents_dir: this.deployment.root,
      reused: false
    });
  }

  stop(): void {
    if (!this.startedByUs) return;
    this.startedByUs = false;

    const script = path.join(this.deployment.root, 'scripts', 'stop-all.sh');
    if (!fs.existsSync(script)) return;

    this.log.event('orchestrator', 'api_exit', {
      reason: 'stop_requested',
      script
    });

    const child = spawn(`bash "${script}"`, {
      cwd: this.deployment.root,
      shell: true,
      detached: false,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.on('error', () => { /* ignore */ });
  }

  // --- deployment build ---

  private buildDeployment(): void {
    const script = path.join(
      this.deployment.apiDir, 'tools', 'make-multi-agent.sh'
    );
    if (!fs.existsSync(script)) {
      throw new Error(
        `make-multi-agent.sh not found: ${script}. ` +
        `Update your DeepSeek Automation API clone.`
      );
    }

    const targetRoot = path.dirname(this.deployment.root); // ~/.pingis
    fs.mkdirSync(targetRoot, { recursive: true });

    this.log.event('orchestrator', 'api_spawn', {
      reason: 'build_deployment',
      script,
      target: targetRoot
    });

    const result = runSync(
      `bash "${script}" "${targetRoot}" --agents 2 --force`,
      targetRoot
    );

    if (result.code !== 0) {
      throw new Error(
        `make-multi-agent.sh failed (exit ${result.code}).\n` +
        `${result.stderr || result.stdout}`
      );
    }

    this.log.raw('[agents] deployment built: ' + this.deployment.root);
  }

  // --- readiness ---

  private async bothReady(): Promise<boolean> {
    const [a, b] = await Promise.all([
      this.pingContextStatus(this.deployment.executor),
      this.pingContextStatus(this.deployment.critic)
    ]);
    return a && b;
  }

  private async waitBothReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.bothReady()) return;
      await sleep(2000);
    }
    throw new Error(
      `Agents did not become ready within ${Math.round(timeoutMs / 1000)}s. ` +
      `Check ${this.deployment.root}/agents/agent-1/agent.log and agent-2.`
    );
  }

  private async pingContextStatus(agent: { port: number; apiKey: string }): Promise<boolean> {
    if (!agent.port || !agent.apiKey) return false;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const r = await fetch(
        `http://127.0.0.1:${agent.port}/v1/context/status`,
        {
          headers: { Authorization: `Bearer ${agent.apiKey}` },
          signal: controller.signal
        }
      );
      clearTimeout(t);
      return r.status === 200;
    } catch {
      return false;
    }
  }

  // --- scripts ---

  private async runScriptSync(script: string, label: string): Promise<void> {
    this.log.raw(`[agents] running ${label}`);
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(`bash "${script}"`, {
          cwd: this.deployment.root,
          shell: true,
          detached: false,
          windowsHide: true
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (c: Buffer) => {
          const s = c.toString('utf-8');
          stdout += s;
          for (const line of s.split(/\r?\n/)) {
            if (line.trim()) this.log.raw(`[agents] ${line}`);
          }
        });
        child.stderr.on('data', (c: Buffer) => {
          const s = c.toString('utf-8');
          stderr += s;
          for (const line of s.split(/\r?\n/)) {
            if (line.trim()) this.log.raw(`[agents] ${line}`);
          }
        });
        child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
      }
    );

    if (result.code !== 0) {
      throw new Error(
        `${label} failed (exit ${result.code}).\n` +
        `${result.stderr.split('\n').slice(-10).join('\n')}`
      );
    }
  }
}

function runSync(cmd: string, cwd: string): { code: number; stdout: string; stderr: string } {
  const { execSync } = require('child_process');
  try {
    const stdout = execSync(cmd, { cwd, encoding: 'utf-8', shell: true, windowsHide: true });
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return {
      code: e.status ?? -1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? '')
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}
'''


# ============ panel.ts (targeted edits) ============

def patch_panel() -> None:
    p = ROOT / 'src' / 'panel.ts'
    if not p.exists():
        print('  ! src/panel.ts not found')
        return
    backup('src/panel.ts')
    text = p.read_text(encoding='utf-8')

    # Imports
    text = text.replace(
        "import { ApiProcess } from './api-process';",
        "import { AgentsProcess } from './api-process';"
    )
    text = text.replace(
        "import { loadApiConfig } from './config';",
        "import { loadAgentsDeployment } from './config';"
    )

    # Class fields
    text = text.replace(
        "  private procE?: ApiProcess;\n  private procC?: ApiProcess;",
        "  private agents?: AgentsProcess;"
    )

    # done() cleanup
    text = text.replace(
        """    this.orchestrator = undefined;
    // По требованию: останавливаем API-процессы после каждой задачи.
    this.stopApiProcesses();""",
        """    this.orchestrator = undefined;
    this.agents?.stop();
    this.agents = undefined;"""
    )

    # stopApiProcesses helper
    text = text.replace(
        """  private stopApiProcesses(): void {
    this.procE?.stop();
    this.procC?.stop();
    this.procE = undefined;
    this.procC = undefined;
  }""",
        """  private stopApiProcesses(): void {
    this.agents?.stop();
    this.agents = undefined;
  }"""
    )

    # Config block in onStart
    old_block = """    const cfg = vscode.workspace.getConfiguration('pingis');
    const apiDir         = cfg.get<string>('apiDir') ?? '';
    const fallbackKey    = cfg.get<string>('apiKey') ?? '';
    const timeoutMin     = cfg.get<number>('taskTimeoutMinutes') ?? 120;
    const execTimeoutSec = cfg.get<number>('execTimeoutSeconds') ?? 120;
    const portE          = cfg.get<number>('apiPortExecutor') ?? 3098;
    const portC          = cfg.get<number>('apiPortCritic') ?? 3099;

    if (!apiDir) {
      this.done(
        'bad_request',
        'Set pingis.apiDir in settings — path to the DeepSeek Automation API directory.'
      );
      return;
    }
"""

    new_block = """    const cfg = vscode.workspace.getConfiguration('pingis');
    const apiDir         = cfg.get<string>('apiDir') ?? '';
    const timeoutMin     = cfg.get<number>('taskTimeoutMinutes') ?? 120;
    const execTimeoutSec = cfg.get<number>('execTimeoutSeconds') ?? 120;

    if (!apiDir) {
      this.done(
        'bad_request',
        'Set pingis.apiDir in settings — path to your clone of ' +
        'deepseek-automation-api.'
      );
      return;
    }
"""

    if old_block not in text:
        print('  ! panel.ts: config block not found')
    else:
        text = text.replace(old_block, new_block, 1)
        print('  panel.ts: config block replaced')

    # Start block
    old_start = """    // Запускаем API-процессы (или переиспользуем, если уже отвечают).
    this.procE = new ApiProcess({
      apiDir, port: portE, who: 'executor', logger: this.log
    });
    this.procC = new ApiProcess({
      apiDir, port: portC, who: 'critic', logger: this.log
    });

    try {
      await this.procE.ensureRunning();
      await this.procC.ensureRunning();
    } catch (e: any) {
      this.done('server_error', `Failed to start API: ${e.message ?? e}`);
      return;
    }

    // .api-key создаётся API не в момент готовности /health, а чуть позже.
    // Ждём появления файлов, иначе прочитаем пусто или устаревший ключ.
    try {
      await waitForKeyFile(this.procE.keyPath, 120_000);
      await waitForKeyFile(this.procC.keyPath, 120_000);
    } catch (e: any) {
      this.done('unauthorized', String(e.message ?? e));
      return;
    }

    const apiCfgE = loadApiConfig(apiDir, this.procE.baseUrl, fallbackKey, 'executor');
    const apiCfgC = loadApiConfig(apiDir, this.procC.baseUrl, fallbackKey, 'critic');

    if (!apiCfgE.apiKey || !apiCfgC.apiKey) {
      this.done(
        'unauthorized',
        'API keys not found in ~/.pingis/executor/ and ~/.pingis/critic/. ' +
        'Check Output → Pingis — the API may have failed to log in.'
      );
      return;
    }
"""

    new_start = """    try {
      this.agents = new AgentsProcess(apiDir, this.log);
      await this.agents.ensureRunning();
    } catch (e: any) {
      this.done('server_error', String(e?.message ?? e));
      return;
    }

    const apiCfgE = {
      baseUrl: `http://127.0.0.1:${this.agents.executor.port}`,
      apiKey:  this.agents.executor.apiKey,
      maxContextChars: 2_400_000
    };
    const apiCfgC = {
      baseUrl: `http://127.0.0.1:${this.agents.critic.port}`,
      apiKey:  this.agents.critic.apiKey,
      maxContextChars: 2_400_000
    };
"""

    if old_start not in text:
        print('  ! panel.ts: start block not found')
    else:
        text = text.replace(old_start, new_start, 1)
        print('  panel.ts: start block replaced')

    # Remove waitForKeyFile helper if present
    import re
    text = re.sub(
        r"\nasync function waitForKeyFile\([\s\S]*?\n\}\n",
        "\n",
        text
    )

    p.write_text(text, encoding='utf-8')


# ============ package.json ============

def patch_package_json() -> None:
    p = ROOT / 'package.json'
    if not p.exists():
        return
    backup('package.json')
    data = json.loads(p.read_text(encoding='utf-8'))
    props = data['contributes']['configuration']['properties']

    for old in (
        'pingis.apiBaseUrl', 'pingis.apiKey',
        'pingis.apiPortExecutor', 'pingis.apiPortCritic',
        'pingis.agentsDir'
    ):
        props.pop(old, None)

    props['pingis.apiDir'] = {
        'type': 'string',
        'default': '',
        'description':
            'Path to your clone of deepseek-automation-api. Pingis builds ' +
            'the multi-agent deployment (~/.pingis/deepseek-agents/) itself ' +
            'from this clone and manages the agents automatically.'
    }

    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('  package.json: only apiDir remains')


def backup(rel: str) -> None:
    src = ROOT / rel
    if not src.exists():
        return
    dst = BACKUP / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def write_file(rel: str, content: str) -> None:
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    backup(rel)
    p.write_text(content, encoding='utf-8')
    print(f'  wrote {rel} ({len(content)} bytes)')


def git_commit(message: str) -> None:
    if not (ROOT / '.git').exists():
        print('  git: no repo, skipping commit')
        return
    try:
        subprocess.run(['git', 'add', '-A'], cwd=ROOT, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-m', message], cwd=ROOT, check=True, capture_output=True)
        print(f'  git: committed "{message}"')
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode('utf-8', errors='replace').strip()
        print(f'  git: skipped ({stderr.splitlines()[0] if stderr else "no changes"})')


def main() -> int:
    if not (ROOT / 'package.json').exists() or not (ROOT / 'src').exists():
        print('ERROR: run from the pingis/ extension root.')
        return 1
    BACKUP.mkdir(exist_ok=True)

    print('Rewriting src/config.ts:')
    write_file('src/config.ts', CONFIG_TS)

    print('Rewriting src/api-process.ts:')
    write_file('src/api-process.ts', API_PROCESS_TS)

    print('Patching src/panel.ts:')
    patch_panel()

    print('Patching package.json:')
    patch_package_json()

    print('Git:')
    git_commit('feat: Pingis builds and manages the multi-agent deployment itself')

    print()
    print('Done. Next:')
    print('  npm run compile')
    print()
    print('Real user does nothing new. Set pingis.apiDir once, log in to')
    print('DeepSeek once via `npm start`, then just use the panel.')
    return 0


if __name__ == '__main__':
    sys.exit(main())