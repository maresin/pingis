// src/retry.ts
/**
 * @file src/retry.ts
 * Retry loop for transient errors.
 *
 * The loop is a pure function: it takes a `runOnce` callback and drives
 * the orchestration around it. Panel supplies the callback (create an
 * Orchestrator, await run()), the retryability predicate, and an
 * `onRetry` hook (restart agents, update ports).
 *
 * The task timeout is measured ONCE, from `taskStartedAt`. Each
 * attempt gets `remainingMs = totalTimeoutMs - (now - taskStartedAt)`
 * as its own orchestrator timeout. When `remainingMs` falls below
 * `minRemainingMs`, the loop aborts — starting a fresh orchestrator
 * on an empty budget would be pointless.
 */

import { OrchestratorResult, StopReason } from './types';

/**
 * Decide whether a retry attempt should restart the API agents.
 *
 *   server_error / bad_gateway — the API process itself is unhealthy.
 *     Restarting clears state and gives a fresh Chromium.
 *
 *   network_error — the connection between the extension host and the
 *     API dropped mid-request. The agents are usually healthy; a
 *     restart costs 30-60s and, if the underlying network is still
 *     flaky, may itself hang waiting for Chromium init. Skip the
 *     restart, let the backoff sleep and the next attempt decide.
 */
export function shouldRestartAgentsOnRetry(reason: StopReason): boolean {
  return reason === 'server_error' || reason === 'bad_gateway';
}

export interface RetryOptions {
  /** Wall-clock start of the whole task (ms since epoch). */
  taskStartedAt: number;
  /** Total budget for the task across all attempts. */
  totalTimeoutMs: number;
  /** Maximum number of retries after the first attempt. */
  maxRetries: number;
  /** Backoff before each retry, indexed by attempt number - 1. */
  backoffMs: number[];
  /** Do not start a new attempt if less than this remains. */
  minRemainingMs: number;

  isRetryable: (reason: StopReason) => boolean;
  /**
   * Execute one attempt. Receives the absolute deadline for the whole
   * task (ms since epoch) — the same value every attempt, so retries
   * cannot extend the budget.
   */
  runOnce: (deadlineAt: number) => Promise<OrchestratorResult>;
  onRetry: (
    attempt: number,
    max: number,
    reason: StopReason
  ) => Promise<void>;

  log: (event: string, payload: object) => void;
}

/**
 * Drive a retryable task to completion.
 *
 * @returns The last OrchestratorResult, whether it came from a
 *          successful attempt, a non-retryable failure, or an
 *          exhausted retry budget.
 */
export async function runWithRetry(
  opts: RetryOptions
): Promise<OrchestratorResult> {
  let attempt = 0;
  let lastResult: OrchestratorResult = { reason: 'crash' };

  const deadlineAt = opts.taskStartedAt + opts.totalTimeoutMs;

  while (true) {
    const remainingMs = deadlineAt - Date.now();

    if (remainingMs < opts.minRemainingMs) {
      opts.log('retry_abort', {
        reason: 'time_budget_exhausted',
        remaining_ms: remainingMs,
        attempt
      });
      break;
    }

    lastResult = await opts.runOnce(deadlineAt);

    if (!opts.isRetryable(lastResult.reason)) {
      break;
    }

    if (attempt >= opts.maxRetries) {
      opts.log('retry_abort', {
        reason: 'max_retries',
        attempt,
        max: opts.maxRetries
      });
      break;
    }

    attempt++;
    const waitMs =
      opts.backoffMs[attempt - 1] ??
      opts.backoffMs[opts.backoffMs.length - 1];

    opts.log('retry_scheduled', {
      attempt,
      max: opts.maxRetries,
      wait_ms: waitMs,
      reason: lastResult.reason
    });

    await opts.onRetry(attempt, opts.maxRetries, lastResult.reason);
    await sleep(waitMs);
  }

  return lastResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
