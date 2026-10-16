/**
 * Unit test for step 51c — format-HELP budget.
 *
 * Scenario: the Executor returns garbage on every request. After
 * MAX_FORMAT_ROUNDS full rounds (5 × L1a+L1b+L3 = 15 attempts), the
 * next unparseable response stops the task with 'protocol_violation'.
 *
 * Expected sequence per round:
 *   broken → L1a (retry 1)
 *   broken → L1b (retry 2)
 *   broken → L3 (orchestrator HELP, round++)
 *
 * After 5 rounds, the next broken response triggers the budget guard
 * on the way to L1a and stops the task.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-format-budget.ts
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
      // Return a plain broken response rather than throwing, so that
      // a runaway loop does not crash the probe with an "exhausted"
      // error — it just keeps failing.
      return { text: 'runaway loop', tool_calls: [], raw: {} };
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
      cwd, name: 'probe-format-budget', task: 'stub',
      deadlineAt: Date.now() + 60_000,
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

async function t1_budget_exhausted(): Promise<void> {
  console.log('\nT1: 5 rounds × 3 broken → protocol_violation');

  const cwd = freshTmp('probe-format-budget-t1');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  // Executor: 5 rounds × 3 broken = 15 broken, then one more to trigger
  // the budget guard. Extra broken responses are harmless.
  const brokenRounds: Step[] = [];
  for (let i = 0; i < 16; i++) {
    brokenRounds.push({ kind: 'broken', text: `garbage #${i + 1}` });
  }
  const apiE = new FakeApi('executor', brokenRounds);

  // Critic: 5 HELP_RESPONSE replies (one per round). The sixth is never
  // requested, but keep a few extras to avoid a script-exhaustion crash
  // if the loop runs away.
  const criticSteps: Step[] = [];
  for (let i = 0; i < 6; i++) {
    criticSteps.push({
      kind: 'tools',
      calls: [{ name: 'send_message',
                args: { to: 'executor',
                        message: `HELP_RESPONSE: try again #${i + 1}` } }]
    });
  }
  const apiC = new FakeApi('critic', criticSteps);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const orchHelp = lines.filter(
    e => e.event === 'help' && e.initiator === 'orchestrator'
  );
  const budget = lines.find(
    e => e.event === 'error' && e.code === 'format_budget_exhausted'
  );
  const stop = lines.find(e => e.event === 'stop');

  check(orchHelp.length === 5,
    `orchestrator HELP fired exactly 5 times (got ${orchHelp.length})`);
  check(!!budget, 'format_budget_exhausted event logged');
  check(budget?.rounds === 5,
    `budget event reports 5 rounds (got ${budget?.rounds})`);
  check(stop?.reason === 'protocol_violation',
    `stop reason = ${stop?.reason} (expected protocol_violation)`);
}

async function main(): Promise<void> {
  await t1_budget_exhausted();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: format-HELP budget works ===');
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
