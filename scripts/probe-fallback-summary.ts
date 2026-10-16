/**
 * Unit test for step 65 — fallback summary on any stop reason.
 *
 * T1. network_error (StopError raised from api.chat) → summary.md
 *     written even though network_error is not in the "usual" list.
 * T2. unknown_tool (executor tries to call finalize) → summary.md
 *     written.
 * T3. The Critic's own summary is never overwritten: a fake Critic
 *     writes summary.md before finalize; orchestrator must not touch
 *     it.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-fallback-summary.ts
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
  const p = path.join(os.tmpdir(),
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

type Step =
  | { kind: 'throw_stop'; reason: string }
  | { kind: 'tools'; calls: { name: string; args: any }[] };

class FakeApi {
  constructor(private who: string, private script: Step[]) {}
  private idx = 0;
  async newChat(): Promise<void> { /* no-op */ }
  async chat(): Promise<AssistantResponse> {
    if (this.idx >= this.script.length) {
      throw new Error(`FakeApi(${this.who}): script exhausted`);
    }
    const s = this.script[this.idx++];
    if (s.kind === 'throw_stop') {
      throw new StopError(s.reason as any, 'simulated');
    }
    return {
      text: '',
      tool_calls: s.calls.map((c, i) => ({
        id: `call_${this.idx}_${i}`,
        name: c.name as any,
        args: c.args
      })) as any,
      raw: {}
    };
  }
}

class FakeExecutor {
  constructor(private cwd: string) {}

  async run(call_id: string, script: string): Promise<ExecResult> {
    // In real use, the Critic writes .pingis/summary.md via execute.
    // When the fake script mentions summary.md, simulate that write
    // so probes can verify the orchestrator leaves the file alone.
    if (script.includes('summary.md')) {
      const dir = path.join(this.cwd, '.pingis');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'summary.md'),
        '# Task summary\n\nCritic-authored content. Do not touch.\n'
      );
    }
    return {
      call_id, command: 'noop', exit_code: 0, duration_ms: 1,
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
  apiE: FakeApi,
  apiC: FakeApi
): Promise<void> {
  const log = mkLog(cwd);
  const orch = new Orchestrator(
    apiE as unknown as ApiClient,
    apiC as unknown as ApiClient,
    new FakeExecutor(cwd) as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd, name: 'probe-fallback-summary', task: 'stub',
      deadlineAt: Date.now() + 30_000,
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

async function t1_network_error(): Promise<void> {
  console.log('\nT1: network_error → summary written');

  const cwd = freshTmp('probe-fallback-t1');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'),
    '# Plan\nreal content\n');

  const apiE = new FakeApi('executor', [
    { kind: 'throw_stop', reason: 'network_error' }
  ]);
  const apiC = new FakeApi('critic', []);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const stop = lines.find(e => e.event === 'stop');
  const summary = path.join(cwd, '.pingis', 'summary.md');
  const plan = path.join(cwd, '.pingis', 'plan.md');

  check(stop?.reason === 'network_error',
    `stop reason = ${stop?.reason} (expected network_error)`);
  check(fs.existsSync(summary),
    'summary.md written even for network_error');
  check(fs.existsSync(plan),
    'plan.md preserved (graceful shutdown keeps it)');
}

async function t2_unknown_tool(): Promise<void> {
  console.log('\nT2: unknown_tool (executor calls finalize) → summary written');

  const cwd = freshTmp('probe-fallback-t2');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });

  const apiE = new FakeApi('executor', [
    { kind: 'tools',
      calls: [{ name: 'finalize', args: { comment: 'not mine' } }] }
  ]);
  const apiC = new FakeApi('critic', []);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const stop = lines.find(e => e.event === 'stop');
  const summary = path.join(cwd, '.pingis', 'summary.md');

  check(stop?.reason === 'unknown_tool',
    `stop reason = ${stop?.reason} (expected unknown_tool)`);
  check(fs.existsSync(summary),
    'summary.md written even for unknown_tool');
}

async function t3_critic_summary_untouched(): Promise<void> {
  console.log('\nT3: Critic writes its own summary → orchestrator leaves it');

  const cwd = freshTmp('probe-fallback-t3');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });

  // Executor: ALL DONE. Critic: execute that writes summary.md
  // (FakeExecutor simulates the write when the script mentions
  // summary.md), then finalize. The orchestrator must leave the
  // file untouched.
  const apiE = new FakeApi('executor', [
    { kind: 'tools',
      calls: [{ name: 'send_message',
                args: { to: 'critic', message: 'ALL DONE: ok' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools',
      calls: [{ name: 'execute',
                args: { script: 'print("write .pingis/summary.md")' } }] },
    { kind: 'tools',
      calls: [{ name: 'finalize', args: { comment: 'done' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);

  const summary = path.join(cwd, '.pingis', 'summary.md');
  const text = fs.readFileSync(summary, 'utf-8');
  check(text.includes('Critic-authored content'),
    'critic summary not overwritten');
  check(!text.includes('fallback'),
    'fallback marker absent');
}

// ---------------------------------------------------------------------------

async function t4_stale_summary_cleared(): Promise<void> {
  console.log('\nT4: stale summary.md is cleared at task start');

  const cwd = freshTmp('probe-fallback-t4');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  // A stale summary from a previous task. It must not survive.
  fs.writeFileSync(path.join(cwd, '.pingis', 'summary.md'),
    '# Stale summary from a previous task. Must not survive.\n');

  const apiE = new FakeApi('executor', [
    { kind: 'throw_stop', reason: 'network_error' }
  ]);
  const apiC = new FakeApi('critic', []);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const reset = lines.find(
    e => e.event === 'artifact'
      && e.action === 'reset'
      && e.kind === 'summary'
  );
  const summary = path.join(cwd, '.pingis', 'summary.md');

  check(!!reset, 'artifact reset summary event logged');
  check(fs.existsSync(summary),
    'summary.md exists after run (fallback wrote it)');
  if (fs.existsSync(summary)) {
    const content = fs.readFileSync(summary, 'utf-8');
    check(!content.includes('Stale summary'),
      'old content gone');
    check(content.includes('fallback'),
      'fallback content present');
  }
}

async function t5_halted_batch_persists_results(): Promise<void> {
  console.log('\nT5: halted batch persists tool results');

  // Batch: [execute, finalize]. The Executor is not allowed to
  // finalize, so the batch halts on the second call. The result of
  // the first (execute) must still be written and logged before the
  // task stops — step68 behavior.
  const cwd = freshTmp('probe-fallback-t5');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });

  const apiE = new FakeApi('executor', [
    { kind: 'tools', calls: [
      { name: 'execute', args: { script: 'print("side effect")' } },
      { name: 'finalize', args: { comment: 'not mine' } }
    ]}
  ]);
  const apiC = new FakeApi('critic', []);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const routed = lines.find(
    e => e.event === 'route'
      && e.kind === 'tool_results'
      && e.halted === true
  );
  const stop = lines.find(e => e.event === 'stop');

  check(!!routed, 'tool_results route logged with halted=true');
  check(routed?.count === 1,
    `route count = ${routed?.count} (expected 1)`);
  check(stop?.reason === 'unknown_tool',
    `stop reason = ${stop?.reason} (expected unknown_tool)`);
}

async function main(): Promise<void> {
  await t1_network_error();
  await t2_unknown_tool();
  await t3_critic_summary_untouched();
  await t4_stale_summary_cleared();
  await t5_halted_batch_persists_results();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: fallback summary on any stop ===');
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
