/**
 * Unit test for 409 context_exhausted handling.
 *
 * Mocks ApiClient and Executor. No real API servers needed.
 * Checks:
 *   1. deadE = true after 409 on the Executor side.
 *   2. Critic receives CONTEXT_LIMIT and calls finalize.
 *   3. stop reason=done (not context_exhausted).
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-409.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiClient } from '../src/api';
import { Executor } from '../src/executor';
import { Logger } from '../src/log';
import { NullPanel, Orchestrator } from '../src/orchestrator';
import { AssistantResponse, ExecResult, StopError } from '../src/types';

const TMP = path.join(os.tmpdir(), 'probe-409-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
console.log('TMP:', TMP);

const log = new Logger(TMP, {
  appendLine: (s: string) => console.log(s)
});

type Step = 'execute' | 'send_message' | 'finalize' | '409';

class FakeApi {
  private count = 0;
  constructor(
    private who: string,
    private script: Step[]
  ) {}

  async newChat(): Promise<void> {
    /* no-op */
  }

  async chat(): Promise<AssistantResponse> {
    const step = this.script[this.count++];
    console.log(`[fake-${this.who}] step #${this.count}: ${step}`);

    if (step === '409') {
      throw new StopError('context_exhausted', `fake ${this.who}`);
    }

    if (step === 'execute') {
      return {
        text: '',
        tool_calls: [{
          id: `call_${this.count}`,
          name: 'execute',
          args: { script: 'print("noop")' }
        } as any],
        raw: {}
      };
    }

    if (step === 'send_message') {
      return {
        text: '',
        tool_calls: [{
          id: `call_${this.count}`,
          name: 'send_message',
          args: this.who === 'executor'
            ? { to: 'critic', message: 'STAGE 1/1 DONE: done' }
            : { to: 'executor', message: 'APPROVE_STAGE' }
        } as any],
        raw: {}
      };
    }

    if (step === 'finalize') {
      return {
        text: '',
        tool_calls: [{
          id: `call_${this.count}`,
          name: 'finalize',
          args: { comment: 'Executor context exhausted. Saved 1/1.' }
        } as any],
        raw: {}
      };
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

// E: execute -> send_message -> 409
// C: send_message (APPROVE_STAGE) -> finalize
const fakeApiE = new FakeApi('executor', ['execute', 'send_message', '409']);
const fakeApiC = new FakeApi('critic', ['send_message', 'finalize']);

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

async function main() {
  const orch = new Orchestrator(
    fakeApiE as unknown as ApiClient,
    fakeApiC as unknown as ApiClient,
    new FakeExecutor() as unknown as Executor,
    new NullPanel(),
    log,
    {
      cwd: TMP,
      name: 'probe-409',
      task: 'Stub task for 409 handling test.',
      timeoutMs: 60_000,
      executorPrompt: 'EXECUTOR_PROMPT',
      criticPrompt: 'CRITIC_PROMPT'
    }
  );

  await orch.run();
  log.close();

  const logPath = path.join(TMP, '.pingis', 'session.log');
  const logText = await readLogWhenReady(logPath);
  const lines = logText
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));

  const stopEvent = lines.find(e => e.event === 'stop');
  const exhaustedEvent = lines.find(
    e => e.event === 'error' && e.code === 'executor_exhausted'
  );
  const criticFinalize = lines.find(
    e => e.who === 'critic'
      && e.event === 'response'
      && Array.isArray(e.tool_calls)
      && (e.tool_calls as any[]).some(tc => tc?.name === 'finalize')
  );

  console.log();
  console.log('--- CHECKS ---');
  console.log('executor_exhausted event:', !!exhaustedEvent);
  console.log('critic finalized:', !!criticFinalize);
  console.log('stop reason:', stopEvent?.reason);

  let failures = 0;
  if (!exhaustedEvent) {
    console.error('FAIL: no executor_exhausted event');
    failures++;
  }
  if (!criticFinalize) {
    console.error('FAIL: Critic did not finalize (didn't receive CONTEXT_LIMIT?)');
    failures++;
  }
  if (!stopEvent || stopEvent.reason !== 'done') {
    console.error(`FAIL: stop reason = ${stopEvent?.reason}, expected done`);
    failures++;
  }

  if (failures === 0) {
    console.log();
    console.log('=== SUCCESS: 409 per-agent handled correctly ===');
    process.exit(0);
  } else {
    console.log();
    console.log(`=== FAILURE: ${failures} checks failed ===`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('CRASH:', e);
  process.exit(2);
});
