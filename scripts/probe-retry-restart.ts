/**
 * Unit test for step 63 — restart decision.
 *
 * T1. shouldRestartAgentsOnRetry returns the expected values.
 * T2. runWithRetry passes the reason to onRetry as the third arg.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-retry-restart.ts
 */

import { runWithRetry, shouldRestartAgentsOnRetry } from '../src/retry';
import { OrchestratorResult, StopReason } from '../src/types';

let failures = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

function t1_decision_table(): void {
  console.log('\nT1: shouldRestartAgentsOnRetry decision table');

  check(shouldRestartAgentsOnRetry('network_error') === false,
    'network_error → no restart');
  check(shouldRestartAgentsOnRetry('server_error') === true,
    'server_error → restart');
  check(shouldRestartAgentsOnRetry('bad_gateway') === true,
    'bad_gateway → restart');
  check(shouldRestartAgentsOnRetry('timeout') === false,
    'timeout → no restart (and not retryable anyway)');
  check(shouldRestartAgentsOnRetry('crash') === false,
    'crash → no restart');
}

async function t2_onRetry_receives_reason(): Promise<void> {
  console.log('\nT2: onRetry receives the reason as third argument');

  const reasons: StopReason[] = [];
  const script: StopReason[] = ['network_error', 'server_error', 'done'];

  const result = await runWithRetry({
    taskStartedAt: Date.now(),
    totalTimeoutMs: 60_000,
    maxRetries: 3,
    backoffMs: [1, 1, 1],
    minRemainingMs: 100,
    isRetryable: (r) =>
      r === 'network_error' || r === 'server_error' || r === 'bad_gateway',
    runOnce: async (): Promise<OrchestratorResult> => {
      const r = script.shift() ?? 'done';
      return { reason: r };
    },
    onRetry: async (_attempt, _max, reason) => {
      reasons.push(reason);
    },
    log: () => { /* silent */ }
  });

  check(result.reason === 'done',
    `result = ${result.reason} (expected done)`);
  check(reasons.length === 2,
    `onRetry called twice (got ${reasons.length})`);
  check(reasons[0] === 'network_error',
    `reasons[0] = ${reasons[0]} (expected network_error)`);
  check(reasons[1] === 'server_error',
    `reasons[1] = ${reasons[1]} (expected server_error)`);
}

async function t3_abort_before_first_attempt(): Promise<void> {
  console.log('\nT3: abort before first attempt → runOnce never called');

  const controller = new AbortController();
  controller.abort();

  let calls = 0;
  const result = await runWithRetry({
    taskStartedAt: Date.now(),
    totalTimeoutMs: 60_000,
    maxRetries: 3,
    backoffMs: [1, 1, 1],
    minRemainingMs: 100,
    signal: controller.signal,
    isRetryable: (r) => r === 'network_error',
    runOnce: async () => {
      calls++;
      return { reason: 'done' };
    },
    onRetry: async () => { /* no-op */ },
    log: () => { /* silent */ }
  });

  check(calls === 0, `runOnce never called (got ${calls})`);
  check(result.reason === 'crash',
    `result.reason = ${result.reason} (default crash)`);
}

async function t4_abort_during_backoff(): Promise<void> {
  console.log('\nT4: abort during backoff → loop exits promptly');

  const controller = new AbortController();
  let calls = 0;

  // Long backoff (10s) but we abort after 20ms. If abort works,
  // the loop finishes well before the backoff would have.
  const started = Date.now();
  const resultPromise = runWithRetry({
    taskStartedAt: Date.now(),
    totalTimeoutMs: 60_000,
    maxRetries: 3,
    backoffMs: [10_000, 10_000, 10_000],
    minRemainingMs: 100,
    signal: controller.signal,
    isRetryable: (r) => r === 'network_error',
    runOnce: async () => {
      calls++;
      return { reason: 'network_error' };
    },
    onRetry: async () => { /* no-op */ },
    log: () => { /* silent */ }
  });

  setTimeout(() => controller.abort(), 20);
  const result = await resultPromise;
  const elapsed = Date.now() - started;

  check(calls === 1, `runOnce called once (got ${calls})`);
  check(elapsed < 1000,
    `finished in ${elapsed}ms (well under the 10s backoff)`);
  check(result.reason === 'network_error',
    `result.reason = ${result.reason} (last attempt)`);
}

async function main(): Promise<void> {
  t1_decision_table();
  await t2_onRetry_receives_reason();
  await t3_abort_before_first_attempt();
  await t4_abort_during_backoff();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: retry restart decision works ===');
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
