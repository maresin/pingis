/**
 * Unit test for the HELP protocol.
 *
 * Mocks ApiClient and Executor. No real API servers needed.
 * Checks:
 *   1. Executor sends HELP: -> Critic receives it.
 *   2. Critic replies HELP_RESPONSE: -> Executor receives it.
 *   3. Executor eventually sends ALL DONE -> Critic finalizes.
 *   4. stop reason=done.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-help.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiClient } from '../src/api';
import { Executor } from '../src/executor';
import { Logger } from '../src/log';
import { NullPanel, Orchestrator } from '../src/orchestrator';
import { AssistantResponse, ExecResult } from '../src/types';

const TMP = path.join(os.tmpdir(), 'probe-help-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
console.log('TMP:', TMP);

const log = new Logger(TMP, {
  appendLine: (s: string) => console.log(s)
});

type Step =
  | 'execute'
  | 'send_help'
  | 'send_all_done'
  | 'send_help_response'
  | 'send_approve_stage'
  | 'finalize';

class FakeApi {
  private count = 0;
  constructor(
    private who: string,
    private script: Step[]
  ) {}

  async newChat(): Promise<void> { /* no-op */ }

  async chat(): Promise<AssistantResponse> {
    const step = this.script[this.count++];
    console.log(`[fake-${this.who}] step #${this.count}: ${step}`);
    if (!step) throw new Error('script exhausted for ' + this.who);

    const mk = (args: any): AssistantResponse => ({
      text: '',
      tool_calls: [{
        id: `call_${this.count}`,
        name: args.name,
        args: args.args
      } as any],
      raw: {}
    });

    if (step === 'execute') {
      return mk({ name: 'execute', args: { script: 'print("noop")' } });
    }
    if (step === 'send_help') {
      return mk({
        name: 'send_message',
        args: {
          to: 'critic',
          message:
            'HELP:\n' +
            'Problem: regex fails on IPv6 addresses.\n' +
            'Error: ValueError: no match at position 0\n' +
            'Tried: \\S+ for ip; \\S+ for url; \\[.+\\] for ts\n' +
            'Files: /tmp/help-test/loganalyzer/parser.py\n' +
            'Question: how to match IPv6 in the ip field?'
        }
      });
    }
    if (step === 'send_all_done') {
      return mk({
        name: 'send_message',
        args: { to: 'critic', message: 'ALL DONE: parser works on all cases.' }
      });
    }
    if (step === 'send_help_response') {
      return mk({
        name: 'send_message',
        args: {
          to: 'executor',
          message:
            'HELP_RESPONSE: use a bracketed class for ip: ' +
            String.raw`(?P<ip>\[[0-9a-fA-F:]+\]|[0-9.]+)`
        }
      });
    }
    if (step === 'send_approve_stage') {
      return mk({
        name: 'send_message',
        args: { to: 'executor', message: 'APPROVE_STAGE' }
      });
    }
    if (step === 'finalize') {
      return mk({
        name: 'finalize',
        args: { comment: 'Parser verified on all edge cases.' }
      });
    }
    throw new Error('unknown step: ' + step);
  }
}

class FakeExecutor {
  async run(call_id: string, script: string, command?: string): Promise<ExecResult> {
    console.log(`[fake-exec] script len=${script.length}`);
    return {
      call_id,
      command: command ?? 'noop',
      exit_code: 0,
      duration_ms: 1,
      stdout: 'noop\n',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false
    };
  }
}

// --- Scenario ---
//
// E: execute              (stuck)
// E: send_help            -> C
// C: execute              (reads files)
// C: send_help_response   -> E
// E: execute              (applies fix)
// E: send_all_done        -> C
// C: execute              (verifies)
// C: finalize
//
// We simulate the natural flow. The exact number of execute calls on
// each side does not matter — what matters is that HELP and
// HELP_RESPONSE travel through the orchestrator's routing table.

const fakeApiE = new FakeApi('executor', [
  'execute',
  'send_help',
  'execute',
  'send_all_done'
]);

const fakeApiC = new FakeApi('critic', [
  'execute',              // reads files after HELP
  'send_help_response',   // replies HELP_RESPONSE
  'execute',              // verifies after ALL DONE
  'finalize'
]);

async function main() {
  const orch = new Orchestrator(
    fakeApiE as unknown as ApiClient,
    fakeApiC as unknown as ApiClient,
    new FakeExecutor() as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd: TMP,
      name: 'probe-help',
      task: 'Stub task for HELP protocol test.',
      timeoutMs: 60_000,
      executorPrompt: 'EXECUTOR_PROMPT',
      criticPrompt: 'CRITIC_PROMPT'
    }
  );

  await orch.run();
  log.close();

  const logPath = path.join(TMP, '.pingis', 'session.log');
  const text = await readLogWhenReady(logPath);
  const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l));

  const helpRoute = lines.find(
    e => e.event === 'route'
      && e.from === 'executor'
      && e.to === 'critic'
      && String(e.message ?? '').startsWith('HELP:')
  );
  const helpResponseRoute = lines.find(
    e => e.event === 'route'
      && e.from === 'critic'
      && e.to === 'executor'
      && String(e.message ?? '').startsWith('HELP_RESPONSE:')
  );
  const stopEvent = lines.find(e => e.event === 'stop');
  const helpEvent = lines.find(
    e => e.event === 'help' && e.kind === 'request'
  );
  const helpResponseEvent = lines.find(
    e => e.event === 'help' && e.kind === 'response'
  );

  console.log();
  console.log('--- CHECKS ---');
  console.log('HELP route found:', !!helpRoute);
  console.log('HELP_RESPONSE route found:', !!helpResponseRoute);
  console.log('help event (request):', !!helpEvent);
  console.log('help event (response):', !!helpResponseEvent);
  console.log('stop reason:', stopEvent?.reason);

  let failures = 0;
  if (!helpRoute)         { console.error('FAIL: no HELP route'); failures++; }
  if (!helpResponseRoute) { console.error('FAIL: no HELP_RESPONSE route'); failures++; }
  if (!helpEvent)         { console.error('FAIL: no help (request) event'); failures++; }
  if (!helpResponseEvent) { console.error('FAIL: no help (response) event'); failures++; }
  if (!stopEvent || stopEvent.reason !== 'done') {
    console.error(`FAIL: stop reason = ${stopEvent?.reason}, expected done`);
    failures++;
  }

  if (failures === 0) {
    console.log();
    console.log('=== SUCCESS: HELP protocol works ===');
    process.exit(0);
  } else {
    console.log();
    console.log(`=== FAILURE: ${failures} checks failed ===`);
    process.exit(1);
  }
}

async function readLogWhenReady(logPath: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath)) {
      const text = fs.readFileSync(logPath, 'utf-8');
      if (text.includes('"event":"stop"')) return text;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
}

main().catch(e => {
  console.error('CRASH:', e);
  process.exit(2);
});