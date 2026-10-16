# Pingis — algorithms and rationale

This document describes how the extension is put together: roles, state
machines, protocols, artifacts, timeouts, and the numeric constants that
bound them. It is meant as a single source of truth for future work — so
that questions of the form "why does the orchestrator do X here?" can be
answered without re-reading thirteen files.

**How this document was built.** Its content is derived strictly from
`src/`, the doc-comments in that code, and the docstrings of
`scripts/dev/apply_stepN_*.py`. Where the reasoning behind a decision is
not recorded anywhere in the repository, the section carries a
`(rationale not recorded)` marker instead of an invented explanation.
Fill those in as you remember or decide.

---

## Table of contents

1. [Roles](#1-roles)
2. [Lifecycle of a task](#2-lifecycle-of-a-task)
3. [Orchestrator state machine](#3-orchestrator-state-machine)
4. [Protocols](#4-protocols)
5. [Artifacts](#5-artifacts)
6. [Context tracking](#6-context-tracking)
7. [Timeouts and deadlines](#7-timeouts-and-deadlines)
8. [Retry on transient errors](#8-retry-on-transient-errors)
9. [Format-restart in Panel](#9-format-restart-in-panel)
10. [Agent phases](#10-agent-phases)
11. [Nudges](#11-nudges)
12. [Stop reasons](#12-stop-reasons)
13. [Invariants](#13-invariants)
14. [Numeric constants](#14-numeric-constants)
15. [Logs](#15-logs)
16. [Rollout checklist for a new task](#16-rollout-checklist-for-a-new-task)

---

## 1. Roles

Pingis runs **two independent agents** in a loop. Each has its own
DeepSeek Automation API server, its own Chromium, its own chat session,
and its own API key.

### 1.1 Executor

- Writes and runs code via `execute(script, command?)`.
- The wrapper is always Python. Target code can be in any language — the
  wrapper calls `npm`, `go`, `cargo`, etc.
- Explores the working directory at start. Determines whether it is
  empty, an existing project, or a pile of loose files.
- Cannot call `finalize`. Only the Critic can end a task.
- Can send messages to the Critic via `send_message(to="critic", ...)`.

### 1.2 Critic

- Reads files **itself** via `execute` — never trusts the Executor's
  message text.
- Evaluates on substance: critical errors → `IMPROVE`; working code →
  `APPROVED`, even with stylistic notes.
- Rejects only on critical violations. Stylistic notes are not grounds
  for `IMPROVE`.
- The only role allowed to call `finalize(comment)`.

### 1.3 Orchestrator

Sits between the two agents. It is **not** a third LLM. It is a
deterministic state machine that:

- routes messages between Executor and Critic;
- injects context markers into tool results;
- enforces deadlines, retry budgets, and format escalation;
- manages artifacts (`plan.md`, `summary.md`, `.last-project`);
- writes a fallback summary when the Critic does not.

The orchestrator never decides on the substance of the task. It only
decides when to hand off, when to nudge, when to escalate, and when to
stop.

---

## 2. Lifecycle of a task

```
 user clicks Start
        │
        ▼
 [ Panel.onStart ]
        │
        ├─ save attachments to .pingis/attachments/
        ├─ AgentsProcess.ensureRunning()
        │      ├─ build deployment if missing
        │      └─ start-all.sh, wait for readiness
        │
        ├─ Orchestrator.run() ── one attempt
        │      │
        │      ├─ decide resume vs fresh (plan.md + .last-project)
        │      ├─ loop: E turns and C turns
        │      ├─ stop on done / deadlock / timeout / ...
        │      └─ artifacts: delete plan.md on clean done
        │
        ▼
 runWithRetry (outer)
   ├─ on transient (network_error / bad_gateway / server_error)
   │   └─ backoff 5s / 10s / 20s, up to 3 retries
   └─ on protocol_violation
       └─ up to 2 format-restarts (agents restart + newChat)
        │
        ▼
 [ Panel.done(reason, summary) ]
```

The **task budget** (`pingis.taskTimeoutMinutes`, default 120) is
measured once, from the first Start click, and is shared across all
retries and format-restarts. See §7.

---

## 3. Orchestrator state machine

The orchestrator keeps **two queues**, one per agent:

- `queueE` — pending requests for the Executor.
- `queueC` — pending requests for the Critic.

Each iteration of the main loop checks the queues in this order:

```
if queueE not empty and not deadE:  step('executor')
elif queueC not empty and not deadC: step('critic')
elif deadE and not deadC:           stop('context_exhausted')
elif deadC:                         stop('context_exhausted')
else:                               stop('deadlock')
```

`deadE` / `deadC` are set when the agent receives a 409 from the API. A
dead agent's queue is no longer consumed.

**Priority rule.** The Executor is served first. This is why the
soft-deadline handler explicitly drops `queueE` before queueing the
`TIME_LIMIT:` message for the Critic — without that, a non-empty
Executor queue would keep priority and the Critic would never receive
its turn.

`step(who, session)` performs one request / response cycle:

1. Set the agent phase to `working`.
2. Snapshot the current request into `originalE` / `originalC` (used
   later by HELP round-trips, see §4.2).
3. Optionally prepend a nudge — `[CHECKPOINT]` (§11.1) or
   `[CONTINUATION]` (§11.2).
4. `api.chat(session, msg, { files })`.
5. Log the response, its `tool_calls`, `context_status`, and `usage`.
6. If no `tool_calls`: salvage / retry / escalate (§4.3).
7. If any `tool_call` is malformed: one hint, then HELP (§4.2, §4.3).
8. Otherwise, dispatch tool calls.

---

## 4. Protocols

### 4.1 PLAN → STAGE → DONE

For non-trivial tasks, the Executor and Critic agree on a plan before
work begins.

```
Executor → Critic:  PLAN:
                    1. <stage>
                    ...
                    Requirements mapping: ...
                    Risks: ...

Critic   → Executor: APPROVE_PLAN | IMPROVE_PLAN: <issues>

...Executor writes .pingis/plan.md after APPROVE_PLAN...

Executor → Critic:  STAGE N/M DONE:
                    Done / Files / Verified / Next

Critic   → Executor: APPROVE_STAGE | IMPROVE: <specifics>

...

Executor → Critic:  ALL DONE: <final summary>

Critic reads files, runs checks, calls finalize(comment).
```

Simple tasks (one file, one command) skip the protocol — the Executor
works immediately and goes straight to `ALL DONE`.

**Stage checkboxes.** `plan.md` stages are marked with one of three
states:

- `[ ]` — not started.
- `[~]` — attempted but not resolved. A resume reader continues from
  the first stage that is not `[x]`, so `[~]` stages are revisited.
- `[x]` — complete, goal achieved.

The three-state model was introduced because a live run marked a failed
exploratory stage as `[x]`, which hid from a later reader that the track
needed follow-up.

### 4.2 HELP loop

When an agent is stuck, it sends the other agent a structured request
instead of continuing to hammer at the problem alone.

```
Executor (stuck) → Critic:  HELP:
                            Problem: <one sentence>
                            Error: <exact error, or n/a>
                            Tried: <bullets>
                            Files: <paths>
                            Question: <what you need decided>

Critic → Executor:  HELP_RESPONSE: <concrete fix or new direction>
                  | IMPOSSIBLE: <why it cannot be solved>
                  | QUESTION: <clarifying question>

Executor → Critic:  SOLVED: <one line about what worked>
                  | HELP: <updated Tried: list>
```

**Markers** recognised by the orchestrator (prefixes on `send_message`):

- `HELP:`
- `HELP_RESPONSE:`
- `SOLVED:`
- `IMPOSSIBLE:` — **terminal**: stops the task with `stop('gave_up', …)`.
  Plan is preserved.
- `QUESTION:` / `ANSWER:` — informational, no special control flow.

**Enrichment.** When `HELP:` is routed, the orchestrator appends the
sender's last broken (unparseable) `tool_calls` response, if any, as
`--- last broken attempt ---`. This saves the recipient from having to
ask.

**Return-to-original wrapper.** When `HELP_RESPONSE:` is routed, the
orchestrator wraps it:

```
Return to your original task.

Original request:
<recipient's originalE / originalC — the request it was working from
 when it sent HELP:>

Suggestion from <who>:
<the HELP_RESPONSE text>

Resume with the original request. If the suggestion does not help, say
so in one line and continue on your own.
```

Rationale: without this wrapper the recipient's "current request"
becomes another layer of HELP chatter, and over several rounds the
original task drifts out of focus.

**No iteration counter.** The HELP loop is symmetric and unbounded. The
task timeout is the only hard bound.

### 4.3 Format-problem escalation

DeepSeek Web occasionally truncates long tool-call JSON or wraps it in
DSML tags. The orchestrator handles this in three salvage / escalation
steps:

1. **Salvage A — full tool_calls as text.** Parse the whole response as
   JSON; if it contains a valid `tool_calls` array, reconstruct the
   calls and continue.
2. **Salvage B — extract `message` field.** Regex the broken JSON for
   `"message": "..."` and reconstruct a single `send_message` to the
   other agent. The dialog continues.
3. **Format-HELP escalation** (when neither salvage applies):
   - **L1a** — retry with a short hint. Attached to the current request;
     not queued as a separate message.
   - **L1b** — retry with a preview of the broken output (first 800 and
     last 400 chars, so the boundary is visible).
   - **L3** — orchestrator sends `HELP:` to the other agent on the
     broken agent's behalf, with the last broken attempt attached. The
     broken agent's queue is replaced (not appended), so there is never
     more than one pending message per agent.

Each full round (L1a → L1b → L3) increments `formatRoundsE` /
`formatRoundsC`. Before starting a new L1a, the orchestrator checks
`MAX_FORMAT_ROUNDS`. On exhaustion it stops with `protocol_violation`.

`MAX_FORMAT_ROUNDS = 5` — 15 total nudges per agent (3 per round).
*(rationale not recorded for the specific number 5.)* The comment in
`orchestrator.ts` says the intent is to distinguish "stuck on a specific
format problem" from "cannot produce valid output at all".

Malformed-tool-call HELP uses a **separate** counter (`malformedRetryE` /
`malformedRetryC`), which is 0 → 1 → HELP, and is not merged into the
format limit.

### 4.4 QUESTION / ANSWER

Non-control-flow messages. `QUESTION:` is routed normally; the recipient
is expected to reply `ANSWER: <text>`. Nothing in the orchestrator
enforces this — it is a prompt-level convention.

### 4.5 CONTEXT_LIMIT / TIME_LIMIT

Two hand-off messages that turn a running Executor into a
finalize-only Critic.

- `CONTEXT_LIMIT: ...` — sent by the orchestrator when the Executor hits
  a 409 (`context_exhausted`). The Executor is marked dead; the Critic is
  asked to finalize. Sets `pendingGracefulShutdown = true` so `plan.md`
  survives.
- `TIME_LIMIT: ...` — sent by the orchestrator when the soft deadline
  fires. The Executor queue is dropped first. The Critic receives a
  strict three-turn instruction:
  1. one execute that gathers plan.md + recent logs,
  2. one execute that writes `summary.md`,
  3. one `finalize`.
  No open-ended investigation.

Both set `pendingGracefulShutdown`, which affects only the artifact
lifecycle (§5.1): `plan.md` is preserved rather than deleted.

### 4.6 IMPOSSIBLE

Either agent may declare the task impossible. This is terminal:

```
stop('gave_up', `IMPOSSIBLE from ${who}: ...`)
```

`gave_up` is distinct from `deadlock`. `deadlock` means the orchestrator
ran out of work (both queues empty) — an internal error. `gave_up` means
a conscious decision by an agent.

Plan is preserved (`pendingGracefulShutdown = true`). Fallback
`summary.md` is written if the Critic did not write one.

Prompt-level guidance: agents are told that after several honest HELP /
HELP_RESPONSE rounds without a new direction, declaring the task
impossible is valid and better than circling until the timeout.

---

## 5. Artifacts

### 5.1 `.pingis/plan.md` — continuation marker

- **Written by** the Executor after `APPROVE_PLAN`.
- **Presence is the signal** that the current task is a continuation.
  The orchestrator leaves the API chats alone; the Executor is expected
  to send `RESUME: continuing from stage N/M`.
- **Absence is the signal** that this is a fresh task. The orchestrator
  calls `POST /v1/chat/new { restore: false }` on both agents.
- **Deleted** on clean `done`. **Preserved** on graceful shutdown
  (`CONTEXT_LIMIT:`, `TIME_LIMIT:`, `IMPOSSIBLE`, network failure,
  format-restart).

Two conditions gate resume:

1. `plan.md` exists.
2. `.last-project` markers in both agent dirs equal `cwd`.

If either fails, chats are reset and markers rewritten. Without the
marker check, a `plan.md` left over from one project could cause a
different project's task to reuse the same chat.

### 5.2 `.pingis/summary.md` — persistent report

- **Written by** the Critic before calling `finalize`.
- **Fallback** written by the orchestrator in `finally` whenever the
  Critic did not — unconditionally on stop reason.
- **Cleared at task start**, like `plan.md`. Without this, a failed
  Critic in a new task would leave the user reading a report about the
  previous task (the fallback writer skips when the file exists).

The Critic is instructed to copy `plan.md` into `summary.md`, because
`plan.md` is removed after a clean done.

### 5.3 `.last-project` markers

Placed in each agent's state dir
(`~/.pingis/deepseek-agents/agents/agent-N/.last-project`). Content: the
absolute path of the project the current chat belongs to.

Written whenever chats are reset. Compared on every task start.

### 5.4 Agent state

Under `~/.pingis/deepseek-agents/agents/agent-N/`:

- `agent.env` — port, feature flags, paths.
- `.api-key` — API key.
- `chat_state.json` — DeepSeek chat id, counters, snapshot flags.
- `uploads/` — uploaded files, snapshots, RAG context.
- `rag_data/` — RAG index (if enabled).
- `agent.log` — stdout/stderr of that agent.
- `agent.pid` — PID while running.

Under `~/.pingis/deepseek-agents/`:

- `shared-state.json` — DeepSeek cookies, shared by both agents.
- `api-path.txt` — absolute path to the API clone.
- `scripts/` — lifecycle scripts.

Cookies are shared on purpose: independent logins from the same host
trigger Cloudflare Turnstile captcha loops.

---

## 6. Context tracking

### 6.1 `percent_used` thresholds

The API returns `context_status` in every response with `percent_used`,
`chars_used`, `chars_limit`, `warning`, `recommendation`. The
orchestrator:

- logs `percent_used` for each agent (event `context` in
  `session.log`);
- at `percent_used >= 85` (or on API `warning`) — injects
  `[CONTEXT WARNING]` into the agent's next tool result;
- at `percent_used >= 92` — injects `[CONTEXT CRITICAL]` with the
  instruction to save progress and stop;
- on API `deepseek_length_limit.detected` — injects a warning about
  truncated messages.

The two thresholds are fallbacks: they only fire when the API is silent.
The API's own `warning` / `recommendation` strings are always respected
first.

### 6.2 Context markers

The markers are documented in both system prompts. The agent is told
what they mean and what to do, so the marker is not an unfamiliar
prefix.

### 6.3 Context-transition detector

A sharp drop in `percent_used` between two consecutive responses from
the **same agent** is logged as `context_transition`. This is what a
snapshot-and-RAG handoff to a new chat looks like from the client's
side. Observability only — no control flow reads it.

Threshold: drop ≥ `TRANSITION_DROP_POINTS = 50`.

### 6.4 409 handling

A 409 from the API means the server-side session is exhausted. The
orchestrator's response depends on which agent hit it:

- **Executor** — `deadE = true`. Critic is asked to finalize
  (`CONTEXT_LIMIT:`). `pendingGracefulShutdown = true`.
- **Critic** — `deadC = true`. Task stops immediately with
  `context_exhausted`.

If the Critic sends a message to a dead Executor, the orchestrator does
not forward it — it asks the Critic to finalize, up to
`MAX_FINALIZE_REMINDERS = 3` times. After that, `deadlock`.

---

## 7. Timeouts and deadlines

### 7.1 Task budget

`pingis.taskTimeoutMinutes` (default 120). Translated into an **absolute
wall-clock deadline** at Start:

```
deadlineAt = taskStartedAt + timeoutMin * 60_000
```

The absolute deadline is threaded through the retry loop and the
orchestrator. Every retry and format-restart shares the same
`deadlineAt`; a retry cannot extend the budget. This fixed a bug where a
120-second grace period was being added on every retry.

### 7.2 Soft vs hard deadline

- **Soft deadline** = `deadlineAt`. On fire: the Executor queue is
  dropped; a `TIME_LIMIT:` message is queued for the Critic;
  `pendingGracefulShutdown = true`.
- **Hard deadline** = `softDeadline + GRACE_MS`. On fire: immediate
  `stop('timeout', ...)`.

`GRACE_MS` default = `1_800_000` (30 minutes). Probes override via
`OrchestratorOptions.graceMs`.

Rationale for 30 minutes: live runs showed the Critic's first LLM turn
after soft deadline can take 89+ seconds, and finalize requires 2–3 more
turns. 300 seconds left no room for a slow DeepSeek Web.

### 7.3 `TIME_LIMIT:` handler

See §4.5. Three turns, no deep investigation. A short honest summary
beats a thorough one that misses the deadline.

---

## 8. Retry on transient errors

### 8.1 Decision table

The Panel wraps `Orchestrator.run()` in `runWithRetry`:

```
isRetryable(reason) := reason ∈ { network_error, bad_gateway, server_error }
```

Everything else — `crash`, `timeout`, `protocol_violation`, `deadlock`,
`gave_up`, `server_busy`, `context_exhausted`, `user_stopped` — is not
retryable and returns immediately.

### 8.2 Backoff and budget

- `MAX_RETRIES = 3`.
- Backoff: 5 s / 10 s / 20 s.
- `MIN_REMAINING_MS = 60_000` — do not start a new attempt if less than
  60 seconds remain on the task budget.

### 8.3 Restart vs no restart

`shouldRestartAgentsOnRetry(reason)`:

- `server_error` / `bad_gateway` — **restart** the API agents. The
  process is unhealthy; restart clears state and gives a fresh Chromium.
- `network_error` — **do not restart**. The agents are healthy; the
  connection between extension host and API dropped. Restart costs
  30–60 s and, if the network is still flaky, may itself hang.

The distinction was introduced after a live run hung for minutes on a
transient `ECONNRESET`.

### 8.4 Abort

`runWithRetry` accepts an `AbortSignal`. The Panel creates one per task,
aborts it on the Stop button, and the loop exits at its nearest
checkpoint (before / after `runOnce`, before / after the backoff sleep).
Backoff sleep is abort-aware, so Stop is immediate.

If `signal.aborted` after the loop, Panel reports `user_stopped` instead
of the underlying failure reason.

### 8.5 Interaction with artifacts

`plan.md` survives a retry. The next attempt starts with the same chats
(no `newChat`), and the Executor's continuation nudge (§11.2) reminds it
to send `RESUME:`. This is why retries resume rather than start over.

---

## 9. Format-restart in Panel

A separate mechanism from retry. Fires only when the format-HELP budget
inside a single run is exhausted (`stop('protocol_violation')`):

1. Stop and restart the API agents.
2. `POST /v1/chat/new { restore: false }` on both — fresh chat, no
   history.
3. Re-run the whole task with `plan.md` still on disk.
4. Up to `MAX_FORMAT_RESTARTS = 2` such restarts.

Rationale: five format rounds without a valid `tool_calls` in one chat
often means the accumulated history has become hostile to clean
generation. A fresh chat gives the Executor a clean slate.

Time budget is not extended: restarts share the same `deadlineAt`.

---

## 10. Agent phases

Coarse per-agent state, logged as `agent_phase`. Observability only — no
orchestrator decision reads these fields (yet).

### 10.1 Phase set

```
idle           — nothing in flight; waiting for the next step
working        — request sent; awaiting a response
format_retry   — previous response unparsable; retrying
awaiting_help  — sent HELP:; waiting for HELP_RESPONSE:
helping        — received HELP:; working on the response
```

`setPhase` is a no-op when the phase does not change, so `idle → idle`
does not spam the log.

### 10.2 Transitions

- `idle → working` — start of `step()`.
- `working → idle` — end of `step()` when no HELP is involved.
- `working → format_retry` — L1a or L1b hint attached.
- `working → awaiting_help` — HELP sent (either by the agent, or
  synthesized by the orchestrator at L3).
- `idle → helping` — HELP arrived while the agent was idle.
- `helping → working` — the helping agent starts its own step.
- `helping → idle` / `awaiting_help → idle` — HELP_RESPONSE or SOLVED
  finished the round.

### 10.3 Relation to HELP

The phase set is deliberately coarser than the HELP marker set (`HELP` /
`HELP_RESPONSE` / `SOLVED` / `IMPOSSIBLE`). Phase tells you "the agent
is somewhere in the HELP loop"; the `help` event in `session.log` tells
you which marker was sent.

*(rationale not recorded for the exact split; the current split was
introduced in step50 as a foundation for a HELP-budget check that is not
implemented yet.)*

---

## 11. Nudges

Soft reminders prepended to the next request. Neither is a hard limit —
both are cues, and the agent decides whether they apply.

### 11.1 Checkpoint nudge

- Fires after `CHECKPOINT_NUDGE_AFTER = 15` consecutive `execute` calls
  without an intervening `send_message`.
- Prepends `[CHECKPOINT] You have made N consecutive execute calls
  without a send_message to the other agent.` to the next request.
- Streak resets to 0 at the nudge; a persistent ignore re-triggers after
  another 15 executes.
- Rationale: an ASDI run made 53 turns without a single STAGE report,
  and the Critic had nothing to do for over an hour.

### 11.2 Continuation nudge

- Fires on Executor steps when the task started with `plan.md` present
  (`hasPlanAtStart`), and the Executor has not yet sent any message to
  the Critic.
- Prepends `[CONTINUATION] .pingis/plan.md exists from a prior run.` to
  the next request, with the RESUME protocol text.
- Fires up to `MAX_CONTINUATION_NUDGES = 3` times, stopping early as
  soon as the Executor sends any message.
- Rationale: a live run showed the Executor silently skipping the RESUME
  protocol even though the plan was there. A single one-shot hint was
  too easy to miss.

Satisfaction is set on the first successful `send_message` from the
Executor, regardless of what the message says — any check-in counts.

---

## 12. Stop reasons

Full list from `src/types.ts`. Table shows when each fires and what
happens to `plan.md` / `summary.md`.

| Reason | Fires when | plan.md | Retryable |
|---|---|---|---|
| `done` | Critic calls `finalize` | deleted (unless graceful) | no |
| `timeout` | Hard deadline | preserved | no |
| `context_exhausted` | 409, and handoff failed | preserved | no |
| `gave_up` | Any agent sends `IMPOSSIBLE:` | preserved | no |
| `deadlock` | Both queues empty (internal) | preserved | no |
| `protocol_violation` | Format budget exhausted (5 rounds) | preserved | format-restart |
| `malformed_tool_call` | (legacy; no longer emitted) | preserved | no |
| `unknown_tool` | Executor calls `finalize`, or unknown tool | preserved | no |
| `user_stopped` | Stop button (or abort before/after attempt) | preserved | no |
| `network_error` | fetch threw, or 408/504 exhausted | preserved | yes |
| `bad_gateway` | HTTP 502 | preserved | yes |
| `server_error` | HTTP 500 | preserved | yes |
| `server_busy` | HTTP 503 exhausted (3 × 5 s) | preserved | no |
| `unauthorized` | HTTP 401 | preserved | no |
| `forbidden` | HTTP 403 | preserved | no |
| `not_found` | HTTP 404 | preserved | no |
| `bad_request` | HTTP 400 | preserved | no |
| `no_workspace` | Start without an open folder | — | no |
| `crash` | Uncaught exception | preserved | no |

Fallback `summary.md` is written whenever the Critic did not write one,
regardless of stop reason.

---

## 13. Invariants

Properties the orchestrator tries to maintain. Not enforced by types;
enforced by construction and by probes.

1. **Only the Critic can finalize.** `finalize` from the Executor is
   `unknown_tool`.
2. **One `plan.md` per project, one task at a time.** A second Start
   restarts the orchestrator.
3. **`plan.md` presence ⇔ same chats.** If the file exists and
   `.last-project` matches, chats are reused. Otherwise both are reset
   via `POST /v1/chat/new`.
4. **`plan.md` survives a non-clean stop.** Deleted only on clean `done`
   without `pendingGracefulShutdown`.
5. **`summary.md` is present after every task.** Critic writes it, or
   the orchestrator writes a fallback.
6. **At most one pending message per agent when HELP is synthesized.**
   The recipient's queue is replaced, not appended.
7. **The HELP loop has no numeric cap.** The only budget is time.
8. **The task budget is a single deadline.** Retries and format-restarts
   share it.
9. **The Executor is served first in the main loop.** Timeout handling
   compensates by dropping its queue.
10. **IMPOSSIBLE is terminal for both agents.** No fallback loop retries
    after it.
11. **A dead agent's queue is not consumed.** 409 means the session is
    gone; there is nothing to send.
12. **The orchestrator never decides on task substance.** It only routes
    and enforces protocols.

---

## 14. Numeric constants

Every numeric bound in the orchestrator, with location and meaning.

| Name | Value | Location | Meaning |
|---|---|---|---|
| `MAX_FINALIZE_REMINDERS` | 3 | orchestrator.ts | "Please finalize" reminders after Executor death |
| `MAX_FORMAT_ROUNDS` | 5 | orchestrator.ts | L1a+L1b+L3 rounds before `protocol_violation` |
| `TRANSITION_DROP_POINTS` | 50 | orchestrator.ts | Minimum drop for `context_transition` event |
| `CHECKPOINT_NUDGE_AFTER` | 15 | orchestrator.ts | Executes in a row before `[CHECKPOINT]` |
| `MAX_CONTINUATION_NUDGES` | 3 | orchestrator.ts | `[CONTINUATION]` attempts per run |
| `GRACE_MS` | 1 800 000 | orchestrator.ts | Grace after soft deadline (30 min) |
| `MAX_RETRIES` | 3 | panel.ts | Transient-error retries |
| `RETRY_BACKOFF_MS` | 5 000 / 10 000 / 20 000 | panel.ts | Backoff between retries |
| `MIN_REMAINING_MS` | 60 000 | panel.ts | Do not retry with less than this |
| `MAX_FORMAT_RESTARTS` | 2 | panel.ts | Format-restart rounds |
| `MAX_ATTACHMENT_BYTES` | 262 144 | panel.ts | Per-file attachment cap |
| Attachment total warn | 1 000 000 | panel.ts | Soft warning on total attachment size |
| `MAX_STREAM_BYTES` | 65 536 | executor.ts | Truncate stdout/stderr per stream |
| `DEFAULT_TIMEOUT_MS` | 120 000 | executor.ts | Default execute timeout |
| `DEFAULT_CONTEXT_CHARS` | 1 000 000 | config.ts | Fallback context budget |
| `MAX_CONTEXT_CHARS` | 2 400 000 | panel.ts | Actually used (Russian-language budget) |

For the last: DeepSeek Web's session context limit is language-dependent
(Russian ~2.4 M chars, English ~3 M, Chinese ~1 M). The smallest value
is used so prompt wording is stable across languages.

---

## 15. Logs

### 15.1 `session.log`

JSONL, one event per line. Each event:

```
{ seq, ts, who, event, ...payload }
```

`who` ∈ { `executor`, `critic`, `orchestrator` }. Full list of `event`
values in `src/types.ts` (`LogEvent`). Highlights:

- `task_start` — task name, task, cwd, `deadline_at`, attachments,
  `api_config_executor`, `api_config_critic`.
- `system_prompt` — text of the system prompt (for audit).
- `request` / `response` — every API round trip.
- `exec` — every `execute` call result.
- `route` — every message routed between agents.
- `context` — `percent_used` at every response.
- `context_transition` — sharp drop in `percent_used`.
- `help` — HELP-loop markers.
- `agent_phase` — phase transitions.
- `checkpoint_nudge` / `continuation_nudge` — nudges.
- `artifact` — plan.md / summary.md lifecycle.
- `api_spawn` / `api_ready` / `api_exit` — deployment lifecycle.
- `error` — non-fatal or fatal errors, with `stage` / `code`.
- `stop` — final stop with reason, summary, turn counters, help cycles,
  duration.

Common queries:

```bash
# Last 20 events
tail -20 .pingis/session.log

# All errors
grep '"event":"error"' .pingis/session.log

# Context usage over time for the Executor
grep '"who":"executor","event":"context"' .pingis/session.log \
  | python3 -c "
import sys, json
for line in sys.stdin:
    d = json.loads(line)
    warn = '  [WARN]' if d.get('warning_present') else ''
    print(f\"{d['ts'][11:19]}  {d['percent_used']}%  ({d['chars_used']}/{d['chars_limit']}){warn}\")
"
```

### 15.2 Output channel

`Output → Pingis`. Short real-time summary plus stdout/stderr of the two
API processes, prefixed `[api-e]` / `[api-c]`. Internal API noise is
filtered — see `NOISE_PATTERNS` in `src/panel.ts`.

The channel is created per task and disposed in
`PanelProvider.dispose()`.

---

## 16. Rollout checklist for a new task

1. `pingis.apiDir` points to the API clone. `state.json` exists there
   (login was done at least once).
2. `~/.pingis/deepseek-agents/` either exists or will be built on first
   Start.
3. Ports 3098 / 3099 are free. Pingis kills occupants.
4. Open the project folder in VS Code.
5. Fill in name + task (or attach description files ≤ 256 KB).
6. Start. Watch `Output → Pingis`.
7. On clean done: `.pingis/summary.md` present, `.pingis/plan.md`
   deleted.
8. On interrupted done (timeout / network / gave_up): `.pingis/plan.md`
   preserved. To resume, start the same task in the same folder with the
   same description — the Executor reads `plan.md` and sends `RESUME:`.