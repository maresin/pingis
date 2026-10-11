import { spawn, ChildProcess } from 'child_process';
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
      `bash "${script}" "${targetRoot}" --agents 2 --base-port 3098 --force`,
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
