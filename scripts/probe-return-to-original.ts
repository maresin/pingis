/**
 * Unit test for step 51b — HELP_RESPONSE wrap.
 *
 * Mocks ApiClient and Executor. No real API servers needed.
 *
 * Scenario:
 *   - Executor sends HELP: to Critic.
 *   - Critic replies HELP_RESPONSE:.
 *   - The message the orchestrator routes from Critic back to Executor
 *     must contain:
 *       * the "Return to your original task" preamble,
 *       * the Executor's original framing (the request it was working
 *         from when it sent HELP:),
 *       * the raw HELP_RESPONSE text from Critic.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-return-to-original.ts
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
      cwd, name: 'probe-return-to-original', task: 'stub',
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

async function t1_wrap_help_response(): Promise<void> {
  console.log('\nT1: HELP_RESPONSE wrapped with return-to-original');

  const cwd = freshTmp('probe-return-t1');
  fs.mkdirSync(path.join(cwd, '.pingis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pingis', 'plan.md'), '# Plan\n');

  // Executor: execute, then HELP, then ALL DONE.
  // Critic: execute (reads files), HELP_RESPONSE, execute (verifies), finalize.
  const apiE = new FakeApi('executor', [
    { kind: 'tools', calls: [{ name: 'execute',
        args: { script: 'print(1)' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'HELP:\nProblem: x\nTried: y' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'critic', message: 'ALL DONE: ok' } }] }
  ]);
  const apiC = new FakeApi('critic', [
    { kind: 'tools', calls: [{ name: 'execute',
        args: { script: 'print(1)' } }] },
    { kind: 'tools', calls: [{ name: 'send_message',
        args: { to: 'executor',
                message: 'HELP_RESPONSE: try X instead of Y' } }] },
    { kind: 'tools', calls: [{ name: 'finalize',
        args: { comment: 'done' } }] }
  ]);

  await runOrch(cwd, apiE, apiC);
  const lines = readLog(cwd);

  const routeCriticToExecutor = lines.find(
    e => e.event === 'route'
      && e.from === 'critic'
      && e.to === 'executor'
      && typeof e.message === 'string'
  );

  check(!!routeCriticToExecutor,
    'route critic → executor exists');
  const msg: string = routeCriticToExecutor?.message ?? '';

  check(msg.includes('Return to your original task'),
    'wrapped message contains the preamble');
  check(msg.includes('HELP_RESPONSE: try X instead of Y'),
    'wrapped message still contains the raw HELP_RESPONSE text');
  check(msg.includes('Original request:'),
    'wrapped message labels the original request section');
  check(msg.includes('Suggestion from critic:'),
    'wrapped message labels the suggestion section');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await t1_wrap_help_response();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: HELP_RESPONSE wrap works ===');
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
