/**
 * Unit test for step 60 — continuation nudge.
 *
 * T1. plan.md present → first Executor request carries the
 *     [CONTINUATION] prefix; second does not.
 * T2. plan.md absent → no nudge ever.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-continuation-nudge.ts
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
  | { kind: 'execute' }
  | { kind: 'tools'; calls: { name: string; args: any }[] };

class FakeApi {
  public receivedContents: string[] = [];
  constructor(private who: string, private script: Step[]) {}
  private idx = 0;
  async newChat(): Promise<void> { /* no-op */ }
  async chat(_session: unknown, msg: { content: string }): Promise<AssistantResponse> {
    this.receivedContents.push(msg.content);
    if (this.idx >= this.script.length) {
      throw new Error(`FakeApi(${this.who}): script exhausted`);
    }
    const s = this.script[this.idx++];
    if (s.kind === 'execute') {
      return {
        text: '',
        tool_calls: [{
          id: `call_${this.idx}`,
          name: 'execute',
          args: { script: 'print(1)' }
        } as any],
        raw: {}
      };
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
      cwd, name: 'probe-continuation-nudge', task: 'stub',
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

// ---------------------------------------------------------------------------

async function t1_nudge_when_plan_present(): Promise<void> {
  console.log('\nT1: plan.md present → nudge on first, not on second');

  const cwd = freshTmp('probe-cont-t1');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'),
    '# Plan\n- [ ] 1. do a thing\n');

  // Executor: 2 executes, then ALL DONE. Critic: finalize.
  const apiE = new FakeApi('executor', [
    { kind: 'execute' },
    { kind: 'execute' },
    { kind: 'tools',
      calls: [{ name: 'send_message',
                args: { to: 'critic', message: 'ALL DONE: ok' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools',
      calls: [{ name: 'finalize', args: { comment: 'done' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const nudge = lines.filter(e => e.event === 'continuation_nudge');
  check(nudge.length === 1,
    `exactly one continuation_nudge (got ${nudge.length})`);
  if (nudge.length === 1) {
    check(nudge[0].who === 'executor',
      `nudge agent = ${nudge[0].who} (expected executor)`);
  }

  const executorRequests = apiE.receivedContents;
  const prefixed = executorRequests.filter(c => c.startsWith('[CONTINUATION]'));
  check(prefixed.length === 1,
    `exactly one executor request has [CONTINUATION] (got ${prefixed.length})`);
  if (executorRequests.length >= 2) {
    check(!executorRequests[1].startsWith('[CONTINUATION]'),
      'second executor request has no prefix');
  }
}

async function t2_no_nudge_when_no_plan(): Promise<void> {
  console.log('\nT2: plan.md absent → no nudge');

  const cwd = freshTmp('probe-cont-t2');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });

  const apiE = new FakeApi('executor', [
    { kind: 'execute' },
    { kind: 'tools',
      calls: [{ name: 'send_message',
                args: { to: 'critic', message: 'ALL DONE: ok' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools',
      calls: [{ name: 'finalize', args: { comment: 'done' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);
  const nudge = lines.filter(e => e.event === 'continuation_nudge');
  check(nudge.length === 0,
    `no continuation_nudge (got ${nudge.length})`);

  const prefixed = apiE.receivedContents.filter(
    c => c.startsWith('[CONTINUATION]')
  );
  check(prefixed.length === 0,
    `no executor request has [CONTINUATION] (got ${prefixed.length})`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await t1_nudge_when_plan_present();
  await t2_no_nudge_when_no_plan();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: continuation nudge works ===');
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
