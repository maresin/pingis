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
 * Abort-aware sleep. Resolves when either the timer expires or the
 * signal fires. Used for backoff between retry attempts so a user
 * Stop is not delayed by up to 20s of pending backoff.
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise(r => setTimeout(r, ms));
  }
  if (signal.aborted) return Promise.resolve();

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

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

  /**
   * Optional abort signal. When it fires, the retry loop exits
   * before the next runOnce and at the start/end of the backoff
   * sleep. Used to make the UI Stop button actually stop the loop —
   * previously it could only stop the current Orchestrator, which is
   * already gone by the time a retry is scheduled.
   */
  signal?: AbortSignal;
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
    if (opts.signal?.aborted) {
      opts.log('retry_abort', { reason: 'user_stopped', attempt });
      break;
    }

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

    // Even if the attempt just finished, prefer reporting
    // user_stopped over the underlying reason: the user asked to
    // stop, and the next block would have sent the request anyway.
    if (opts.signal?.aborted) {
      opts.log('retry_abort', { reason: 'user_stopped', attempt });
      break;
    }

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

    if (opts.signal?.aborted) {
      opts.log('retry_abort', { reason: 'user_stopped', attempt });
      break;
    }

    await sleepWithAbort(waitMs, opts.signal);
  }

  return lastResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
