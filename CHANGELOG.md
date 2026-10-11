# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
