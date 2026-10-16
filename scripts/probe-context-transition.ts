/**
 * Unit test for step 51f — chat-transition detector.
 *
 * Scenario: the Executor returns three responses with context_status
 * percent_used at 88, 3, 5. The 88 → 3 drop crosses the 50-point
 * threshold and must produce one context_transition event. The 3 → 5
 * step is ordinary growth and must not.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-context-transition.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiClient } from '../src/api';
import { Executor } from '../src/executor';
import { Logger } from '../src/log';
import { NullPanel, Orchestrator } from '../src/orchestrator';
import { AssistantResponse, ContextStatus, ExecResult } from '../src/types';

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

type Step = {
  kind: 'tools';
  calls: { name: string; args: any }[];
  percent: number;
};

class FakeApi {
  constructor(private who: string, private script: Step[]) {}
  private idx = 0;
  async newChat(): Promise<void> { /* no-op */ }
  async chat(): Promise<AssistantResponse> {
    if (this.idx >= this.script.length) {
      throw new Error(`FakeApi(${this.who}): script exhausted`);
    }
    const s = this.script[this.idx++];
    const context_status: ContextStatus = {
      chars_used: s.percent * 24000,
      chars_limit: 2_400_000,
      percent_used: s.percent,
      language_coefficient: 2.4,
      warning: null,
      recommendation: null
    };
    return {
      text: '',
      tool_calls: s.calls.map((c, i) => ({
        id: `call_${this.idx}_${i}`,
        name: c.name as any,
        args: c.args
      })) as any,
      context_status,
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
      cwd, name: 'probe-context-transition', task: 'stub',
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

async function t1_transition_detected(): Promise<void> {
  console.log('\nT1: 88% → 3% triggers one transition event');

  const cwd = freshTmp('probe-transition-t1');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const apiE = new FakeApi('executor', [
    { kind: 'tools',
      calls: [{ name: 'execute', args: { script: 'print(1)' } }],
      percent: 88 },
    { kind: 'tools',
      calls: [{ name: 'execute', args: { script: 'print(2)' } }],
      percent: 3 },
    { kind: 'tools',
      calls: [{ name: 'send_message',
                args: { to: 'critic', message: 'ALL DONE: ok' } }],
      percent: 5 }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools',
      calls: [{ name: 'finalize', args: { comment: 'done' } }],
      percent: 4 }
  ]);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const transitions = lines.filter(
    e => e.event === 'context_transition' && e.who === 'executor'
  );

  check(transitions.length === 1,
    `exactly one transition detected (got ${transitions.length})`);
  if (transitions.length === 1) {
    const t = transitions[0];
    check(t.from_percent === 88,
      `from_percent = ${t.from_percent} (expected 88)`);
    check(t.to_percent === 3,
      `to_percent = ${t.to_percent} (expected 3)`);
  }

  const criticTransitions = lines.filter(
    e => e.event === 'context_transition' && e.who === 'critic'
  );
  check(criticTransitions.length === 0,
    `no transition for critic on its first response (got ${criticTransitions.length})`);
}

async function main(): Promise<void> {
  await t1_transition_detected();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: context-transition detector works ===');
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
