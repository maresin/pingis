/**
 * Unit test for step 56 — graceful shutdown on soft deadline.
 *
 * T1. Executor makes a few executes; soft deadline fires; the
 *     Executor queue is drained; Critic gets TIME_LIMIT and
 *     finalizes. stop reason = 'done'; plan.md and summary.md exist
 *     (graceful shutdown keeps the plan).
 *
 * T2. Same setup, but the grace window is short and the Critic never
 *     finalizes. Hard deadline fires. stop reason = 'timeout';
 *     summary.md and plan.md are both present.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-soft-deadline.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiClient } from '../src/api';
import { Executor } from '../src/executor';
import { Logger } from '../src/log';
import { NullPanel, Orchestrator } from '../src/orchestrator';
import { AssistantResponse, ExecResult } from '../src/types';

let failures = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

function freshTmp(name: string): string {
  const p = path.join(os.tmpdir(),
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Infinite execute: every chat() returns another execute call.
class InfiniteExecuteApi {
  public calls = 0;
  async newChat(): Promise<void> { /* no-op */ }
  async chat(): Promise<AssistantResponse> {
    this.calls++;
    return {
      text: '',
      tool_calls: [{
        id: `call_${this.calls}`,
        name: 'execute',
        args: { script: 'print(1)' }
      } as any],
      raw: {}
    };
  }
}

// Finalize on the first chat() call.
class FinalizeApi {
  public calls = 0;
  async newChat(): Promise<void> { /* no-op */ }
  async chat(): Promise<AssistantResponse> {
    this.calls++;
    return {
      text: '',
      tool_calls: [{
        id: `call_${this.calls}`,
        name: 'finalize',
        args: { comment: 'soft-deadline' }
      } as any],
      raw: {}
    };
  }
}

class SlowFakeExecutor {
  public calls = 0;
  async run(call_id: string, script: string): Promise<ExecResult> {
    this.calls++;
    await new Promise(r => setTimeout(r, 40));
    return {
      call_id, command: 'noop', exit_code: 0, duration_ms: 40,
      stdout: 'ok\n', stderr: '',
      stdout_truncated: false, stderr_truncated: false
    };
  }
}

function mkLog(cwd: string): Logger {
  return new Logger(cwd, { appendLine: () => { /* silent */ } });
}

async function runOrch(
  cwd: string,
  apiE: InfiniteExecuteApi,
  apiC: FinalizeApi | InfiniteExecuteApi,
  deadlineAt: number,
  graceMs: number,
  exec: SlowFakeExecutor
): Promise<void> {
  const log = mkLog(cwd);
  const orch = new Orchestrator(
    apiE as unknown as ApiClient,
    apiC as unknown as ApiClient,
    exec as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd, name: 'probe-soft-deadline', task: 'stub',
      deadlineAt,
      graceMs,
      executorPrompt: 'E', criticPrompt: 'C'
    }
  );
  await orch.run();
  log.close();
  await new Promise(r => setTimeout(r, 200));
}

function readLog(cwd: string): any[] {
  const logPath = path.join(cwd, '.pingis', 'session.log');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------

async function t1_critic_finalizes_on_soft_deadline(): Promise<void> {
  console.log('\nT1: soft deadline → Critic finalizes → done');

  const cwd = freshTmp('probe-soft-t1');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  // No plan.md → fresh chats (irrelevant here, but sets a known state).

  const apiE = new InfiniteExecuteApi();
  const apiC = new FinalizeApi();
  const exec = new SlowFakeExecutor();

  // Soft deadline very close; grace long enough for the Critic to
  // finalize on its first step.
  await runOrch(cwd, apiE, apiC, Date.now() + 200, 800, exec);
  const lines = readLog(cwd);

  const soft = lines.find(
    e => e.event === 'error' && e.code === 'soft_deadline'
  );
  const stop = lines.find(e => e.event === 'stop');

  // After soft_deadline, the critic must have received a request.
  // The soft-deadline handler pushes TIME_LIMIT directly onto the
  // critic's queue (not via send_message), so there is no `route`
  // event for it. The observable signal is a critic `request` event
  // with a timestamp >= soft_deadline's timestamp.
  const softIdx = lines.findIndex(
    e => e.event === 'error' && e.code === 'soft_deadline'
  );
  const criticRequestAfterSoft = softIdx >= 0 && lines
    .slice(softIdx + 1)
    .some(e => e.who === 'critic' && e.event === 'request');

  check(!!soft, 'soft_deadline event logged');
  check(criticRequestAfterSoft, 'critic received a request after soft_deadline');

  // Executor made fewer than 10 executes — its queue was drained on
  // soft deadline. The exact number is timing-dependent.
  check(exec.calls < 10,
    `executor executed fewer than 10 times (got ${exec.calls})`);

  check(stop?.reason === 'done',
    `stop reason = ${stop?.reason} (expected done)`);

  const planPath = path.join(cwd, '.pingis', 'plan.md');
  const summaryPath = path.join(cwd, '.pingis', 'summary.md');
  // No plan.md existed to begin with, so only summary is checked.
  check(fs.existsSync(summaryPath), 'summary.md written (fallback)');
}

async function t2_hard_deadline_after_short_grace(): Promise<void> {
  console.log('\nT2: short grace → hard deadline → timeout with summary');

  const cwd = freshTmp('probe-soft-t2');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  // A plan.md so we can verify it is preserved on timeout.
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'),
    '# Plan\nreal content\n');

  const apiE = new InfiniteExecuteApi();
  // Critic never finalizes — keeps doing executes until hard deadline.
  const apiC = new InfiniteExecuteApi();
  const exec = new SlowFakeExecutor();

  // Soft at +100ms, hard at +400ms — Critic cannot finish in time.
  await runOrch(cwd, apiE, apiC, Date.now() + 100, 300, exec);
  const lines = readLog(cwd);

  const stop = lines.find(e => e.event === 'stop');
  check(stop?.reason === 'timeout',
    `stop reason = ${stop?.reason} (expected timeout)`);

  const summaryPath = path.join(cwd, '.pingis', 'summary.md');
  const planPath = path.join(cwd, '.pingis', 'plan.md');
  check(fs.existsSync(summaryPath),
    'summary.md written (fallback on timeout)');
  check(fs.existsSync(planPath),
    'plan.md preserved on graceful shutdown');

  const artifact = lines.find(
    e => e.event === 'artifact' && e.action === 'fallback'
  );
  check(!!artifact, 'fallback summary artifact event logged');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await t1_critic_finalizes_on_soft_deadline();
  await t2_hard_deadline_after_short_grace();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: graceful shutdown works ===');
    process.exit(0);
  } else {
    console.log(`=== FAILURE: ${failures} check(s) failed ===`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('CRASH:', e);
  process.exit(2);
});
