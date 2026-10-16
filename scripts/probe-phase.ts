/**
 * Unit test for step 50 — AgentPhase transitions.
 *
 * Mocks ApiClient and Executor. No real API servers needed.
 *
 * Scenarios:
 *   T1. Normal step: idle → working → idle.
 *   T2. Format retry (one garbage response then a valid one):
 *       working → format_retry → working.
 *   T3. HELP loop: Executor sends HELP:, Critic replies HELP_RESPONSE:,
 *       Executor sends SOLVED:. Expect transitions:
 *         E: working → awaiting_help
 *       C: idle → helping → working
 *
 * The probe reads `agent_phase` events from session.log and asserts
 * that the expected transitions are present. Exact ordering is not
 * asserted — the phase machine has many legitimate orderings, and
 * asserting them rigidly would make this probe brittle.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-phase.ts
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

type Step =
  | { kind: 'broken'; text: string }
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
    if (s.kind === 'broken') {
      return { text: s.text, tool_calls: [], raw: {} };
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
  async run(call_id: string, script: string): Promise<ExecResult> {
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
    new FakeExecutor() as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd, name: 'probe-phase', task: 'stub',
      deadlineAt: Date.now() + 30_000,
      executorPrompt: 'E', criticPrompt: 'C'
    }
  );
  await orch.run();
  log.close();
  await new Promise(r => setTimeout(r, 200));
}

function readPhaseEvents(cwd: string): Array<{
  who: string; from: string; to: string; reason?: string;
}> {
  const logPath = path.join(cwd, '.pingis', 'session.log');
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf-8')
    .split('\n').filter(Boolean);
  const out: Array<{ who: string; from: string; to: string;
                     reason?: string }> = [];
  for (const line of lines) {
    const e = JSON.parse(line);
    if (e.event === 'agent_phase') {
      out.push({ who: e.who, from: e.from, to: e.to, reason: e.reason });
    }
  }
  return out;
}

function hasTransition(
  events: Array<{ who: string; from: string; to: string; reason?: string }>,
  who: string,
  from: string,
  to: string
): boolean {
  return events.some(e => e.who === who && e.from === from && e.to === to);
}

// ---------------------------------------------------------------------------

async function t1_normal_step(): Promise<void> {
  console.log('\nT1: normal step — idle → working → idle');

  const cwd = freshTmp('probe-phase-t1');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const apiE = new FakeApi('executor', [
    { kind: 'tools', calls: [{ name: 'execute',
        args: { script: 'print(1)' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'ALL DONE: ok' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools', calls: [{ name: 'finalize',
        args: { comment: 'done' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const events = readPhaseEvents(cwd);

  check(hasTransition(events, 'executor', 'idle', 'working'),
    'executor: idle → working');
  check(hasTransition(events, 'executor', 'working', 'idle'),
    'executor: working → idle');
  check(hasTransition(events, 'critic', 'idle', 'working'),
    'critic: idle → working');
}

async function t2_format_retry(): Promise<void> {
  console.log('\nT2: format retry — working → format_retry → working');

  const cwd = freshTmp('probe-phase-t2');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const apiE = new FakeApi('executor', [
    { kind: 'broken', text: 'not json' },
    { kind: 'tools', calls: [{ name: 'execute',
        args: { script: 'print(1)' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'ALL DONE: ok' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools', calls: [{ name: 'finalize',
        args: { comment: 'done' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const events = readPhaseEvents(cwd);

  check(hasTransition(events, 'executor', 'working', 'format_retry'),
    'executor: working → format_retry');
  check(hasTransition(events, 'executor', 'format_retry', 'working'),
    'executor: format_retry → working');
}

async function t3_help_loop(): Promise<void> {
  console.log('\nT3: HELP loop — awaiting_help / helping');

  const cwd = freshTmp('probe-phase-t3');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const apiE = new FakeApi('executor', [
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'HELP:\nProblem: x\nTried: y' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'SOLVED: it worked' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'ALL DONE: ok' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'executor', message: 'HELP_RESPONSE: try X' } }] },
    { kind: 'tools', calls: [{ name: 'finalize',
        args: { comment: 'done' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const events = readPhaseEvents(cwd);

  check(hasTransition(events, 'executor', 'working', 'awaiting_help'),
    'executor: working → awaiting_help');
  check(hasTransition(events, 'critic', 'idle', 'helping'),
    'critic: idle → helping (HELP arrived while idle)');
  check(hasTransition(events, 'critic', 'helping', 'working'),
    'critic: helping → working (step started)');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await t1_normal_step();
  await t2_format_retry();
  await t3_help_loop();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: agent phases work ===');
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
