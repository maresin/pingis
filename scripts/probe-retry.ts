/**
 * Unit test for step 34 — runWithRetry().
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-retry.ts
 */

import { runWithRetry } from '../src/retry';
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

function freshRunWithRetry(
  script: StopReason[],
  opts: {
    maxRetries?: number;
    backoffMs?: number[];
    totalTimeoutMs?: number;
    taskStartedAtOffset?: number;
  } = {}
): Promise<{ result: OrchestratorResult; attempts: number; retries: number; logs: any[] }> {
  let attempts = 0;
  let retries = 0;
  const logs: any[] = [];
  const scriptCopy = [...script];

  return runWithRetry({
    taskStartedAt: Date.now() - (opts.taskStartedAtOffset ?? 0),
    totalTimeoutMs: opts.totalTimeoutMs ?? 60_000,
    maxRetries: opts.maxRetries ?? 3,
    backoffMs: opts.backoffMs ?? [1, 1, 1],
    minRemainingMs: 100,
    isRetryable: (r) =>
      r === 'network_error' || r === 'bad_gateway' || r === 'server_error',
    runOnce: async () => {
      attempts++;
      const r = scriptCopy.shift() ?? 'done';
      return { reason: r };
    },
    onRetry: async () => {
      retries++;
    },
    log: (event, payload) => logs.push({ event, ...payload })
  }).then(result => ({ result, attempts, retries, logs }));
}

async function t1_retry_then_success(): Promise<void> {
  console.log('\nT1: network_error, then done');
  const { result, attempts, retries } = await freshRunWithRetry([
    'network_error', 'done'
  ]);
  check(result.reason === 'done', `result = ${result.reason} (expected done)`);
  check(attempts === 2, `attempts = ${attempts} (expected 2)`);
  check(retries === 1, `retries = ${retries} (expected 1)`);
}

async function t2_retries_exhausted(): Promise<void> {
  console.log('\nT2: four network_errors, budget exhausted');
  const { result, attempts, retries } = await freshRunWithRetry(
    ['network_error', 'network_error', 'network_error', 'network_error']
  );
  check(result.reason === 'network_error',
    `result = ${result.reason} (expected network_error)`);
  check(attempts === 4, `attempts = ${attempts} (expected 4)`);
  check(retries === 3, `retries = ${retries} (expected 3)`);
}

async function t3_non_retryable(): Promise<void> {
  console.log('\nT3: server_busy — not retryable');
  const { result, attempts, retries } = await freshRunWithRetry([
    'server_busy', 'done'
  ]);
  check(result.reason === 'server_busy',
    `result = ${result.reason} (expected server_busy)`);
  check(attempts === 1, `attempts = ${attempts} (expected 1)`);
  check(retries === 0, `retries = ${retries} (expected 0)`);
}

async function t4_done_immediate(): Promise<void> {
  console.log('\nT4: done on first attempt');
  const { result, attempts, retries } = await freshRunWithRetry(['done']);
  check(result.reason === 'done', `result = ${result.reason}`);
  check(attempts === 1, `attempts = ${attempts}`);
  check(retries === 0, `retries = ${retries}`);
}

async function t5_time_budget_exhausted(): Promise<void> {
  console.log('\nT5: no attempts — budget already gone');
  const { result, attempts, retries, logs } = await freshRunWithRetry(
    ['done'],
    { totalTimeoutMs: 60_000, taskStartedAtOffset: 100_000 }
  );
  check(result.reason === 'crash',
    `result = ${result.reason} (expected crash — the default)`);
  check(attempts === 0, `attempts = ${attempts} (expected 0)`);
  check(retries === 0, `retries = ${retries}`);
  const abort = logs.find(l => l.event === 'retry_abort');
  check(!!abort, 'retry_abort logged');
  check(abort?.reason === 'time_budget_exhausted',
    `abort reason = ${abort?.reason}`);
}

async function main(): Promise<void> {
  await t1_retry_then_success();
  await t2_retries_exhausted();
  await t3_non_retryable();
  await t4_done_immediate();
  await t5_time_budget_exhausted();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: retry loop works ===');
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
