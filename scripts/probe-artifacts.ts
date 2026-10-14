/**
 * Unit test for step 31 — artifact lifecycle and chat reset.
 *
 * Mocks ApiClient and Executor. No real API servers needed.
 *
 * Scenarios:
 *   T1. No .pingis/plan.md -> newChat() called for both agents.
 *   T2. .pingis/plan.md present -> newChat() not called.
 *   T3. Done without Critic writing summary.md -> orchestrator writes
 *       a fallback summary; plan.md removed (clean done).
 *   T4. Done with Critic writing summary.md -> orchestrator does not
 *       overwrite; plan.md removed (clean done).
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-artifacts.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiClient } from '../src/api';
import { Executor } from '../src/executor';
import { Logger } from '../src/log';
import { NullPanel, Orchestrator } from '../src/orchestrator';
import { AssistantResponse, ExecResult, StopError } from '../src/types';

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
  const p = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ---------------------------------------------------------------------------
// Fake APIs
// ---------------------------------------------------------------------------

class FakeApiImmediateExhaust {
  public newChatCalls = 0;
  async newChat(): Promise<void> { this.newChatCalls++; }
  async chat(): Promise<AssistantResponse> {
    throw new StopError('context_exhausted', 'fake');
  }
}

class FakeApiStepScript {
  private step = 0;
  constructor(private who: 'executor' | 'critic', private writeSummary: boolean) {}
  public newChatCalls = 0;
  async newChat(): Promise<void> { this.newChatCalls++; }
  async chat(): Promise<AssistantResponse> {
    this.step++;
    const mk = (name: any, args: any): AssistantResponse => ({
      text: '',
      tool_calls: [{ id: `call_${this.step}`, name, args } as any],
      raw: {}
    });
    if (this.who === 'executor') {
      if (this.step === 1) return mk('execute', { script: 'print("noop")' });
      if (this.step === 2) return mk('send_message', { to: 'critic', message: 'ALL DONE: finished' });
    } else {
      if (this.step === 1) {
        const script = this.writeSummary
          ? 'pathlib.Path(".pingis/summary.md").write_text("MARKER", encoding="utf-8")'
          : 'print("noop")';
        return mk('execute', { script });
      }
      if (this.step === 2) return mk('finalize', { comment: 'done' });
    }
    throw new Error(`exhausted: ${this.who} step ${this.step}`);
  }
}

class FakeExecutor {
  constructor(private cwd: string) {}
  async run(call_id: string, script: string): Promise<ExecResult> {
    if (script.includes('summary.md')) {
      const dir = path.join(this.cwd, '.pingis');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'summary.md'), '# Task summary\n\nMarker written by fake executor.\n');
    }
    return {
      call_id,
      command: 'noop',
      exit_code: 0,
      duration_ms: 1,
      stdout: 'ok\n',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false
    };
  }
}

function makeLog(cwd: string): Logger {
  return new Logger(cwd, { appendLine: () => { /* silent */ } });
}

// ---------------------------------------------------------------------------
// T1 / T2 — chat reset decision
// ---------------------------------------------------------------------------

async function t1_noPlan_resetsChats(): Promise<void> {
  console.log('\nT1: no plan.md -> newChat() called for both agents');
  const cwd = freshTmp('probe-artifacts-t1');
  const apiE = new FakeApiImmediateExhaust();
  const apiC = new FakeApiImmediateExhaust();
  const log = makeLog(cwd);

  const orch = new Orchestrator(
    apiE as unknown as ApiClient,
    apiC as unknown as ApiClient,
    new FakeExecutor(cwd) as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd, name: 't1', task: 'stub',
      timeoutMs: 10_000,
      executorPrompt: 'E', criticPrompt: 'C'
    }
  );

  await orch.run();
  log.close();

  check(apiE.newChatCalls === 1, `executor newChat called once (got ${apiE.newChatCalls})`);
  check(apiC.newChatCalls === 1, `critic newChat called once (got ${apiC.newChatCalls})`);
}

async function t2_withPlan_doesNotReset(): Promise<void> {
  console.log('\nT2: plan.md present -> newChat() not called');
  const cwd = freshTmp('probe-artifacts-t2');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const apiE = new FakeApiImmediateExhaust();
  const apiC = new FakeApiImmediateExhaust();
  const log = makeLog(cwd);

  const orch = new Orchestrator(
    apiE as unknown as ApiClient,
    apiC as unknown as ApiClient,
    new FakeExecutor(cwd) as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd, name: 't2', task: 'stub',
      timeoutMs: 10_000,
      executorPrompt: 'E', criticPrompt: 'C'
    }
  );

  await orch.run();
  log.close();

  check(apiE.newChatCalls === 0, `executor newChat not called (got ${apiE.newChatCalls})`);
  check(apiC.newChatCalls === 0, `critic newChat not called (got ${apiC.newChatCalls})`);
}

// ---------------------------------------------------------------------------
// T3 / T4 — summary and plan lifecycle
// ---------------------------------------------------------------------------

async function t3_doneWithoutSummary_writesFallback(): Promise<void> {
  console.log('\nT3: done without Critic summary -> fallback written; plan deleted');
  const cwd = freshTmp('probe-artifacts-t3');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\nOriginal plan content.\n');

  const apiE = new FakeApiStepScript('executor', false);
  const apiC = new FakeApiStepScript('critic', false);
  const log = makeLog(cwd);

  const orch = new Orchestrator(
    apiE as unknown as ApiClient,
    apiC as unknown as ApiClient,
    new FakeExecutor(cwd) as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd, name: 't3', task: 'stub task',
      timeoutMs: 30_000,
      executorPrompt: 'E', criticPrompt: 'C'
    }
  );

  await orch.run();
  log.close();

  const summaryPath = path.join(cwd, '.pingis', 'summary.md');
  const planPath = path.join(cwd, '.pingis', 'plan.md');
  check(fs.existsSync(summaryPath), 'summary.md created');
  if (fs.existsSync(summaryPath)) {
    const text = fs.readFileSync(summaryPath, 'utf-8');
    check(text.includes('fallback'), 'summary contains fallback marker');
    check(text.includes('Original plan content'), 'summary contains plan verbatim');
  }
  check(!fs.existsSync(planPath), 'plan.md deleted on clean done');
}

async function t4_doneWithSummary_keepsCriticVersion(): Promise<void> {
  console.log('\nT4: done with Critic summary -> not overwritten; plan deleted');
  const cwd = freshTmp('probe-artifacts-t4');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const apiE = new FakeApiStepScript('executor', false);
  const apiC = new FakeApiStepScript('critic', true);
  const log = makeLog(cwd);

  const orch = new Orchestrator(
    apiE as unknown as ApiClient,
    apiC as unknown as ApiClient,
    new FakeExecutor(cwd) as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd, name: 't4', task: 'stub task',
      timeoutMs: 30_000,
      executorPrompt: 'E', criticPrompt: 'C'
    }
  );

  await orch.run();
  log.close();

  const summaryPath = path.join(cwd, '.pingis', 'summary.md');
  const planPath = path.join(cwd, '.pingis', 'plan.md');
  check(fs.existsSync(summaryPath), 'summary.md exists');
  if (fs.existsSync(summaryPath)) {
    const text = fs.readFileSync(summaryPath, 'utf-8');
    check(text.includes('Marker written by fake executor'), 'summary left untouched by orchestrator');
    check(!text.includes('fallback'), 'fallback marker absent');
  }
  check(!fs.existsSync(planPath), 'plan.md deleted on clean done');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await t1_noPlan_resetsChats();
  await t2_withPlan_doesNotReset();
  await t3_doneWithoutSummary_writesFallback();
  await t4_doneWithSummary_keepsCriticVersion();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: artifact lifecycle works ===');
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
