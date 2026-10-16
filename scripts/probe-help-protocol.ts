/**
 * Unit test for the unified HELP protocol.
 *
 * T1. Broken JSON with a valid "message" is salvaged. Dialog continues.
 * T2. Three garbage attempts in a row → orchestrator HELP, no
 *     protocol_violation stop. IMPOSSIBLE from the other agent ends
 *     the task with reason deadlock.
 * T3. HELP → HELP_RESPONSE → SOLVED → done.
 * T4. IMPOSSIBLE from Executor → stop('deadlock'); plan preserved.
 * T5. Help loop across two full rounds — orchestrator HELP fires
 *     more than once; the task ends with IMPOSSIBLE, not with a
 *     hard stop.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-help-protocol.ts
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
    console.log(`  \u2713 ${label}`);
  } else {
    console.error(`  \u2717 ${label}`);
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
  public newChatCalls = 0;
  constructor(private who: string, private script: Step[]) {}
  private idx = 0;
  async newChat(): Promise<void> { this.newChatCalls++; }
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
  apiC: FakeApi,
  task = 'stub'
): Promise<void> {
  const log = mkLog(cwd);
  const orch = new Orchestrator(
    apiE as unknown as ApiClient,
    apiC as unknown as ApiClient,
    new FakeExecutor() as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd, name: 'probe-help-protocol', task,
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

async function t1_salvage_from_broken_message(): Promise<void> {
  console.log('\nT1: broken JSON with valid "message" is salvaged');

  const cwd = freshTmp('probe-hp-t1');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const brokenJson =
    '{"tool_calls":[{"name":"send_message","arguments":' +
    '{"to":"critic","message":"APPROVE_PLAN"';

  const apiE = new FakeApi('executor', [
    { kind: 'broken', text: brokenJson }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools', calls: [{ name: 'execute', args: { script: 'print(1)' } }] },
    { kind: 'tools', calls: [{ name: 'finalize', args: { comment: 'ok' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const salvaged = lines.find(
    e => e.event === 'response' && e.salvaged === true
      && e.kind === 'message_extracted'
  );
  const routed = lines.find(
    e => e.event === 'route' && e.from === 'executor' && e.to === 'critic'
      && typeof e.message === 'string' && e.message.includes('APPROVE_PLAN')
  );
  const stop = lines.find(e => e.event === 'stop');

  check(!!salvaged, 'message_extracted salvage event present');
  check(!!routed, 'APPROVE_PLAN routed to critic');
  check(stop?.reason === 'done', `stop reason = ${stop?.reason} (expected done)`);
}

async function t2_garbage_escalates_to_help(): Promise<void> {
  console.log('\nT2: three garbage attempts → HELP, then IMPOSSIBLE');

  const cwd = freshTmp('probe-hp-t2');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const apiE = new FakeApi('executor', [
    { kind: 'broken', text: 'not json at all' },
    { kind: 'broken', text: 'still garbage' },
    { kind: 'broken', text: 'garbage again' },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'IMPOSSIBLE: cannot reformat' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'executor', message: 'HELP_RESPONSE: try shorter' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const retry1 = lines.find(
    e => e.event === 'error' && e.code === 'no_tool_calls' && e.retry === 1
  );
  const retry2 = lines.find(
    e => e.event === 'error' && e.code === 'no_tool_calls' && e.retry === 2
  );
  const orchHelp = lines.find(
    e => e.event === 'help' && e.initiator === 'orchestrator'
  );
  const stop = lines.find(e => e.event === 'stop');

  check(!!retry1, 'retry 1 (L1a) logged');
  check(!!retry2, 'retry 2 (L1b) logged');
  check(!!orchHelp, 'orchestrator-initiated HELP logged');
  check(stop?.reason !== 'protocol_violation',
    `stop reason = ${stop?.reason} (must not be protocol_violation)`);
  check(stop?.reason === 'gave_up',
    `stop reason = ${stop?.reason} (expected gave_up from IMPOSSIBLE)`);
}

async function t3_help_loop_and_solved(): Promise<void> {
  console.log('\nT3: HELP → HELP_RESPONSE → SOLVED → done');

  const cwd = freshTmp('probe-hp-t3');
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
    { kind: 'tools', calls: [{ name: 'execute', args: { script: 'print(1)' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'executor', message: 'HELP_RESPONSE: try X' } }] },
    { kind: 'tools', calls: [{ name: 'finalize', args: { comment: 'ok' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const helpSent = lines.find(
    e => e.event === 'help' && e.phase === 'HELP'
  );
  const helpResp = lines.find(
    e => e.event === 'help' && e.phase === 'HELP_RESPONSE'
  );
  const solved = lines.find(
    e => e.event === 'help' && e.phase === 'SOLVED'
  );
  const stop = lines.find(e => e.event === 'stop');

  check(!!helpSent, 'HELP event logged');
  check(!!helpResp, 'HELP_RESPONSE event logged');
  check(!!solved, 'SOLVED event logged');
  check(stop?.reason === 'done', `stop reason = ${stop?.reason} (expected done)`);
}

async function t4_impossible_stops_task(): Promise<void> {
  console.log('\nT4: IMPOSSIBLE → deadlock, plan preserved');

  const cwd = freshTmp('probe-hp-t4');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\nreal content\n');

  const apiE = new FakeApi('executor', [
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'IMPOSSIBLE: cannot solve' } }] }
  ]);
  const apiC = new FakeApi('critic', []);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const stop = lines.find(e => e.event === 'stop');
  const summary = path.join(cwd, '.pingis', 'summary.md');
  const plan = path.join(cwd, '.pingis', 'plan.md');

  check(stop?.reason === 'gave_up',
    `stop reason = ${stop?.reason} (expected gave_up)`);
  check(fs.existsSync(summary), 'fallback summary written');
  check(fs.existsSync(plan), 'plan.md preserved (graceful shutdown)');
}

async function t5_help_loop_no_stop(): Promise<void> {
  console.log('\nT5: two full HELP rounds, then IMPOSSIBLE — no hard stop');

  const cwd = freshTmp('probe-hp-t5');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  const apiE = new FakeApi('executor', [
    { kind: 'broken', text: 'r1 garbage a' },
    { kind: 'broken', text: 'r1 garbage b' },
    { kind: 'broken', text: 'r1 garbage c' },
    { kind: 'broken', text: 'r2 garbage a' },
    { kind: 'broken', text: 'r2 garbage b' },
    { kind: 'broken', text: 'r2 garbage c' },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'IMPOSSIBLE: endless format failure' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'executor', message: 'HELP_RESPONSE: try a smaller reply' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'executor', message: 'HELP_RESPONSE: split into two calls' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const helpEvents = lines.filter(
    e => e.event === 'help' && e.initiator === 'orchestrator'
  );
  const stop = lines.find(e => e.event === 'stop');

  check(helpEvents.length >= 2,
    `orchestrator HELP fired ${helpEvents.length} time(s) (>= 2)`);
  check(stop?.reason === 'gave_up',
    `stop reason = ${stop?.reason} (expected gave_up)`);
  check(stop?.reason !== 'protocol_violation',
    'stop reason is not protocol_violation');
}

async function main(): Promise<void> {
  await t1_salvage_from_broken_message();
  await t2_garbage_escalates_to_help();
  await t3_help_loop_and_solved();
  await t4_impossible_stops_task();
  await t5_help_loop_no_stop();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: HELP protocol works ===');
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
