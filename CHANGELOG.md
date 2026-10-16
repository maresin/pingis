# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Changed

- **Grace period 300s → 30 minutes.** Live runs6 showed the Critic's
  first LLM turn after soft deadline can take 89+ seconds, and
  finalizing needs 2-3 more turns. 5 minutes was not enough for a
  slow DeepSeek Web. The task budget still caps the run; only the
  window after the soft deadline grew.

- **`TIME_LIMIT:` handler rewritten as a strict three-turn flow.**
  The Critic now: (1) one execute to gather plan.md + 2-3 recent run
  logs, (2) one execute to write summary.md, (3) one finalize. No
  open-ended investigation. A short honest summary beats a thorough
  one that misses the deadline.

### Fixed

- **Stale `summary.md` cleared at task start.** A new task now
  removes any `summary.md` left from a previous run before work
  begins. Previously the file persisted, the step-65 fallback saw
  it and skipped its own write, and a failed Critic could leave the
  user reading a report about a different task. The file is state
  for THIS task; it should not survive into the next one.

### Fixed

- **Fallback summary on any stop reason.** Previously `summary.md`
  was written only for `done`, `deadlock`, `gave_up`, and `timeout`.
  A live run stopped with `network_error` and left the user without
  a report. Now the orchestrator writes a fallback summary whenever
  the Critic did not, regardless of the stop reason. The Critic's
  own summary is never overwritten.

### Fixed

- **Stop button aborts the retry loop.** Previously Stop only stopped
  the current Orchestrator; if the Orchestrator had already returned
  a retryable failure, the retry loop continued, sleeping backoff,
  restarting agents, and would have retried the task. The UI appeared
  frozen for minutes. Now the Panel owns an AbortController per task;
  Stop calls abort(), and the retry loop exits at its nearest
  checkpoint (before/after runOnce, before/after the backoff sleep).
  The stop reason is reported as `user_stopped`, not the underlying
  failure.

### Fixed

- **No agent restart on `network_error` retry.** A transient
  `ECONNRESET` between the extension host and the API used to trigger
  a full stop-all + start-all cycle (30-60s per retry), which could
  hang for minutes if the network was still flaky. Restart is now
  reserved for `server_error` / `bad_gateway`, where the API process
  is actually unhealthy. For `network_error` the retry loop waits
  the backoff and retries with the same agents.

### Changed

- **Continuation nudge now repeats up to 3 times.** If the Executor
  ignores the first `[CONTINUATION]` hint and starts work without
  sending any message to the Critic, the nudge fires again on the
  next Executor step, up to `MAX_CONTINUATION_NUDGES = 3`. It stops
  early as soon as the Executor sends any message (RESUME, STAGE,
  QUESTION — anything that counts as a check-in). Live runs showed
  the Executor sometimes acknowledges and sometimes silently skips;
  a single one-shot nudge was too fragile.

### Changed

- **Three-state plan markers in both prompts.** `plan.md` stages can
  now be marked `[ ]` (not started), `[~]` (attempted, not resolved),
  or `[x]` (complete). Resume logic continues from the first stage
  that is not `[x]`, so `[~]` stages are revisited. Previously a
  binary `[ ]` / `[x]` lost the "attempted but not resolved" state —
  a live ASDI run marked a failed exploratory stage as `[x]`, which
  hid from a later reader that the track needed follow-up.

### Added

- **Continuation nudge.** When a task starts in a folder with
  `.pingis/plan.md` present, the orchestrator prepends a one-shot
  `[CONTINUATION]` hint to the Executor's first request: read the
  plan, find the first unchecked stage, send `RESUME:` to the Critic.
  Fires only once; if the Executor ignores it, the orchestrator does
  not loop. Purpose: a live run showed Executor silently skipping the
  resume protocol even though the plan was there. Observable as
  `event: 'continuation_nudge'`.

### Fixed

- Default grace period raised from 120s to 300s. On long tasks the
  Critic's first LLM turn alone can take ~55s, and finalizing
  requires at least three turns. 120s left no room for the graceful
  shutdown to complete before the hard deadline.

## [0.4.0] - 2026-10-16

### Added

- **Soft checkpoint nudge.** When an agent makes 15 consecutive
  `execute` calls without an intervening `send_message`, the
  orchestrator prepends a short `[CHECKPOINT]` reminder to the next
  request. It is not a stop: the agent decides whether to check in
  with `STAGE N/M DONE` or keep going. The counter resets at the
  nudge. Purpose: keep the PLAN → STAGE protocol from silently
  disappearing during long implementation phases. Observable as
  `event: 'checkpoint_nudge'` in `.pingis/session.log`.

### Fixed

- **Graceful shutdown on timeout.** When the soft deadline fires, the
  orchestrator now drops the Executor's pending queue before queuing
  the `TIME_LIMIT:` message for the Critic. Previously the Executor's
  non-empty queue kept taking priority in the main loop, and the
  Critic never received the message — the task ran all the way to the
  hard deadline instead of finalizing. The user saw a bare `timeout`
  stop with no summary.
- **Fallback summary on `timeout`.** `timeout` is now included in the
  condition that writes `summary.md` when the Critic did not. After a
  graceful shutdown the user finds both `plan.md` (preserved) and
  `summary.md` (fallback) on disk.

### Added

- **API configuration recorded in the task log.** `ENABLE_RAG`,
  `ENABLE_SNAPSHOT` and `ENABLE_RESTORE` are now read from each
  agent's `agent.env` and written into the `task_start` event of
  `.pingis/session.log`. Purely observational — no orchestrator
  decision depends on them.

- **Chat-transition detection in the log.** When `percent_used` drops
  by 50+ points between two consecutive responses from the same agent,
  the orchestrator logs a `context_transition` event with the before
  and after values. This is what a snapshot-and-RAG handoff to a new
  chat looks like from the client's side. Observability only — no
  control flow reads this event.

- **Context markers documented in both prompts.** The `[CONTEXT WARNING]`
  and `[CONTEXT CRITICAL]` prefixes that the orchestrator injects into
  tool results are now explained in both system prompts, together with
  a short proactive note to keep responses lean. Previously the agent
  had to infer the meaning of these markers from their names alone.

- **Format-restart in Panel.** When the format-HELP budget inside a
  single run is exhausted (`protocol_violation`), Panel now restarts
  the agents, resets both chats via `POST /v1/chat/new`, and re-runs
  the same task with `plan.md` still on disk. Up to two such restarts.
  The task time budget is unchanged — restarts share the same deadline.

- **Bounded format-HELP.** The loop that recovers from unparseable
  `tool_calls` (L1a hint → L1b preview → L3 orchestrator-synthesized
  HELP) now stops after 5 full rounds with `protocol_violation`.
  Each round is up to 3 nudges, so the agent has 15 attempts before
  the task is declared failed. This replaces the previous unbounded
  loop, which could consume the whole task budget without producing
  a valid tool_calls.

- `HELP_RESPONSE` messages now carry a "Return to your original task"
  preamble: the orchestrator restores the recipient's original framing
  of the task (captured when it sent `HELP:`) instead of forwarding the
  suggestion as the next request. Over several HELP rounds, this keeps
  the agent focused on the task rather than on the HELP exchange.

### Changed

- `StopReason` split: an agent's `IMPOSSIBLE` now stops the task with
  reason `gave_up`, distinct from `deadlock` (which still means "the
  orchestrator ran out of work — an internal error"). The user-facing
  reason text in the sidebar reflects the difference.

### Added

- **Per-agent phase tracking.** The orchestrator now records what each
  agent is doing (`idle` / `working` / `format_retry` / `awaiting_help` /
  `helping`) and logs every transition as `agent_phase` in
  `.pingis/session.log`. This is observability only — no decision in
  the orchestrator reads these fields yet. It is the foundation for the
  upcoming HELP-budget check (step 54) and for a clearer sidebar state.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-10-15

### Fixed

- Malformed tool calls now retry up to two times with a hint instead
  of stopping the task immediately. Applies to `execute` without a
  script, `send_message` without a message, and `send_message` with
  an invalid addressee. This mirrors the L1a retry path already in
  place for responses with unparseable `tool_calls`.
- Before this release, the first malformed call stopped the task
  with `stop reason=malformed_tool_call`, even when the agent was
  one short hint away from producing a valid call.

## [0.3.4] - 2026-10-15

### Fixed

- Malformed tool calls (`execute` without a script, `send_message`
  without a message, invalid addressee, self-message) now retry once
  with a hint instead of stopping the task immediately. If the retry
  also fails, the orchestrator hands off to the other agent via HELP.
- The help-loop hints (L1a and L1b) are now attached to the current
  request instead of being queued as separate messages. Previously
  the agent never saw them — the loop kept re-asking the same
  question while a stack of unused hints accumulated in its queue.
  This was the root cause of runs where Executor made 80+ attempts
  and Critic never got a turn.
- The L4 stop (`protocol_violation` after repeated failed attempts)
  is removed. The HELP loop is now closed only by IMPOSSIBLE from
  either agent or by the task timeout — matching the design of the
  HELP protocol.
- When HELP is synthesized, the recipient's queue is replaced rather
  than appended to, so there is never more than one pending message
  per agent.

### Changed

- Executor and Critic prompts: IMPOSSIBLE is now documented as a
  valid outcome after several honest HELP / HELP_RESPONSE rounds
  without a new concrete direction, rather than only for external
  impossibility.

## [0.3.3] - 2026-10-15

### Added

- **Artifact lifecycle for long tasks.**
  - `.pingis/plan.md` is now a continuation marker, not a scratch
    file. While it exists, Pingis treats the task as resumable and
    leaves the API chats alone (no `POST /v1/chat/new`). When it is
    missing, Pingis resets both chats before the first request, so
    no history leaks from the previous task into a new one.
  - `.pingis/summary.md` is the persistent report of the last task.
    The Critic writes it before calling `finalize`; if the Critic
    does not, the orchestrator writes a fallback. The file is
    overwritten on every task.
  - On clean `done` the orchestrator deletes `plan.md`. On graceful
    shutdown (`CONTEXT_LIMIT:`, `TIME_LIMIT:`, `IMPOSSIBLE`, network
    failure) the plan is preserved so the task can be resumed later.

- **Unified HELP protocol** (logic + format).
  - `HELP:` / `HELP_RESPONSE:` / `SOLVED:` / `IMPOSSIBLE:` markers
    are recognised by the orchestrator.
  - `HELP:` from either agent is routed as-is and enriched with the
    sender's last broken `tool_calls` response, if any.
  - Format problems (unparseable `tool_calls`) escalate through
    three steps: L1a (hint), L1b (preview of the broken output),
    L3 (orchestrator-initiated HELP to the other agent). Time is
    the only budget — no numeric iteration counters anywhere.
  - `IMPOSSIBLE:` from either agent terminates the task with stop
    reason `deadlock`. The plan is preserved.

- `scripts/probe-help-protocol.ts` — unit coverage for HELP /
  HELP_RESPONSE / SOLVED / IMPOSSIBLE / broken-JSON salvage /
  L1a → L1b → L3 escalation.

- Fallback `summary.md` on `done` or `deadlock` when the Critic
  did not write one.

### Changed

- Executor prompt: mark stages `[x]` in `plan.md` **immediately**
  after `APPROVE_STAGE`, not at the end of the task. The checkboxes
  are the only reliable resume signal after a crash.
- Executor and Critic prompts: no numeric iteration limits. HELP is
  the signal for "stuck"; IMPOSSIBLE for "cannot be solved".
- `probe:help-protocol` added to `package.json` scripts.

### Fixed

- `src/log.ts`: `case 'help'` reads `r.phase` and shows enrichment /
  initiator flags.
- `scripts/probe-409.ts`: string literal containing an apostrophe
  switched to double quotes.

- **Automatic retry on transient errors.**
  - Retryable reasons: `network_error`, `bad_gateway`, `server_error`.
    Up to 3 retries, backoff 5s / 10s / 20s. The task timeout is
    measured once from the first attempt — a retry cannot extend the
    total budget.
  - On retry, the orchestrator stops and restarts the agents, then
    runs again with a fresh `ApiClient` / `Executor`. Because
    `plan.md` survives, the Executor resumes with `RESUME:` instead
    of starting over.
  - `crash`, `timeout`, `protocol_violation`, `deadlock`,
    `server_busy`, `context_exhausted`, and `user_stopped` do NOT
    retry.
  - `src/retry.ts` extracts the retry loop into a pure helper;
    `scripts/probe-retry.ts` covers attempt exhaustion, time-budget
    exhaustion, and non-retryable reasons.

### Notes

- Three end-to-end runs confirmed the pipeline: `taskdb-v2`
  (multi-stage), `fancy-lib-v2` (IMPOSSIBLE → deadlock, plan
  preserved), `is_valid_time` (single-shot). HELP itself is
  designed for rare stuck states; only IMPOSSIBLE and RESUME were
  exercised end-to-end. All HELP branches are covered by
  `probe-help-protocol.ts`.
- Crash recovery: on `network_error` after an interrupted run,
  a subsequent task with the same description in the same folder
  triggered `RESUME:` — the Executor read `plan.md`, recognized
  progress from disk, and continued from stage 4/6.

## [0.3.2] - 2026-10-11

### Added

- Soft timeout in the orchestrator. On task timeout, the Critic is
  asked to finalize first (`TIME_LIMIT:` message); a hard stop
  follows only after a 120-second grace period. The user gets a
  meaningful summary instead of a silent `timeout` stop.
- Log summaries distinguish between building the multi-agent
  deployment and starting it.

## [0.3.1] - 2026-10-11

### Added

- HELP protocol for joint debugging. When the Executor gets stuck
  (three or more identical failures, or no progress), it sends a
  structured `HELP:` message to the Critic with the problem, the exact
  error, what it has already tried, and the relevant file paths. The
  Critic reads the files, reproduces the error, and replies with a
  concrete fix, a different approach, or `IMPOSSIBLE`. This replaces
  the previous 5-attempt limit; the loop runs until the problem is
  solved or the task times out.
- `TIME_LIMIT:` handler in the Critic: on task timeout, finalizes with
  an honest summary instead of a hard stop.

### Fixed

- Multi-agent deployment is now driven by `make-multi-agent.sh` from
  DeepSeek Automation API. Pingis builds and manages the deployment
  under `~/.pingis/deepseek-agents/` itself; the user no longer touches
  cookies, ports, keys, or scripts.
- Ports moved from 3000/3001 to 3098/3099 to avoid collisions with the
  user's own project and with a manually started DeepSeek API.
- Log summaries for `api_spawn` / `api_ready` / `api_exit` no longer
  print `undefined` after the multi-agent refactor.

### Changed

- Settings surface reduced to `pingis.apiDir` (plus timeouts). All
  port/key/URL settings are gone; values come from the generated
  deployment.

## [0.3.0] - 2026-10-02

### Added

- Two-agent architecture: **Executor** and **Critic**, each with its own
  DeepSeek Automation API server, its own chat session, and its own API key.
- **PLAN → STAGE → DONE** protocol for multi-stage tasks: the Executor
  proposes a plan, the Critic approves it, and each stage is reviewed
  before the next begins.
- `.pingis/plan.md` for persisting task progress across restarts. On a
  restart, the Executor reads the plan and resumes from the first
  unfinished stage.
- Context tracking via `context_status` returned by the API:
  warnings at 85%, critical at 92%, and clean recovery on 409
  (Critic finalizes if the Executor runs out of context).
- Per-agent 409 handling with `CONTEXT_LIMIT:` handoff.
- Unit test for 409 handling (`scripts/probe-409.ts`) — no real API needed.
- Cross-platform process management: Linux, macOS, Windows
  (`taskkill /F /T` on Windows, `kill(-pid, SIGKILL)` on Unix).
- `pingis.saveRawResponses` setting for saving raw API responses
  (debug only).
- Structured JSONL log at `.pingis/session.log` with per-agent `context`
  events, `usage` token counts, and full tool-call traces.
- Attachment form support for task descriptions (up to 256 KB per file,
  multiple files allowed).

### Fixed

- Single-word interpreter commands (`python3`, `node`, `bash`) no longer
  hang waiting for stdin — the path to the patch script is appended
  automatically.
- Stale `.api-key` files are removed before each API spawn, preventing
  401 errors from keys left over from manual API runs.
- Temporary `tool-result-*.json` files are cleaned up when a task stops.
- `503` responses are retried up to three times, in case the API is still
  finishing Chromium initialization.
- Textual `tool_calls` returned by DeepSeek Web (broken JSON, DSML tags)
  are salvaged or retried automatically instead of crashing the task.
- Port occupants (leftover API processes, orphaned Chromium) are killed
  before starting the two API servers.
- API state is fully isolated under `~/.pingis/executor/` and
  `~/.pingis/critic/` — no interference between agents.

### Changed

- Project renamed from `deepseek-agent` to `pingis`.
- Settings prefix changed from `deepseekAgent.*` to `pingis.*`.
- Project-local state moved from `.deepseek-agent/` to `.pingis/`.
- All prompts, UI strings, and code comments are in English.
- Output channel filtered: only meaningful API milestones appear,
  not the internal Chromium chatter.
