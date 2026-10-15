<p align="center">
  <img src="media/icon-marketplace.png" alt="Pingis logo" width="128" height="128">
</p>

<h1 align="center">Pingis</h1>

> Two AI agents. One writes code, the other reviews it. Back and forth, like a ping-pong rally.

**Pingis** is a VS Code extension that turns your editor into a two-agent development environment. An **Executor** writes and runs code. A **Critic** reads the files, checks the work, and either approves or asks for improvements. They work iteratively, in stages, until the task is done.

Powered by [DeepSeek Automation API](https://github.com/maresin/deepseek-automation-api) — a local server that drives the DeepSeek web UI via Playwright.

---

## ⚠️ Upgrade notice

**Pingis before 0.3.3 reused the same DeepSeek chat across tasks.** If
you have ever noticed two unrelated projects sharing the same
conversation history, or a new task continuing the previous task's
chat instead of starting fresh, this was the cause.

Fixed in **0.3.3**. When `.pingis/plan.md` is absent, Pingis calls
`POST /v1/chat/new` on both agents before the first request, so each
new task starts in a fresh chat. Continuation of an unfinished task
(where `.pingis/plan.md` still exists) reuses the same chat — that is
intentional, and the resume mechanism depends on it.

**Before starting a task, make sure both components are up to date:**

- **Pingis** — `Extensions → Pingis` for updates.
- **DeepSeek Automation API** — `cd <api-dir> && git pull && npm install`.

Older combinations may still reproduce the bug.

---

## Why two agents?

A single LLM assistant has a known failure mode: it does the work, then declares victory. It rarely catches its own mistakes. Pingis puts a second, independent agent in the loop whose *only* job is to verify — read the files, run the tests, look for what's missing.

The result is not "faster code". It's **code that has already been reviewed by the time it lands on disk**.

## How it works

When you start a task, Pingis:

1. Spins up **two independent DeepSeek Automation API servers** — one for the Executor (port 3098), one for the Critic (port 3099). Each has its own Chromium, its own chat session, its own API key.
2. Hands the task to the Executor, who explores the working directory and (for non-trivial tasks) proposes a plan.
3. The Critic reviews the plan, then reviews each stage as the Executor completes it.
4. When the Executor is done, the Critic does a final check and either approves or sends the work back.

Everything the agents **create or modify** stays inside your open project folder. The extension's own state — deployment, cookies, logs, per-agent chat state — lives under `~/.pingis/`; see [Files and paths](#files-and-paths) for the exact layout.

## Requirements

- **VS Code 1.85+** or **VSCodium**
- **Node.js 18+**
- **[uv](https://docs.astral.sh/uv/)** — for isolated Python environments
- **DeepSeek Automation API** — cloned and logged in at least once. Chromium is downloaded automatically by `npm install` in the API clone.

## Installation

1. **Install `uv`:**

   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. **Set up DeepSeek Automation API** per its own README. On first run, a browser window opens for login to the DeepSeek web app.

3. **Install the extension** in VS Code or VSCodium.

4. **Configure:** open Settings (`Ctrl+,`), search `Pingis`, set **Api Dir** to the path of your DeepSeek Automation API clone.

## First-time setup

Both agents share one DeepSeek login. This is deliberate: independent
logins from the same machine would trigger Cloudflare Turnstile's
captcha loop, and Cloudflare does not distinguish between two automated
browsers. One login, shared cookies, no captcha.

The login happens **once**, in the API directory, before Pingis runs its
first task.

### One-time login

1. **Clone and install the API** per its own README:

   ```bash
   git clone https://github.com/maresin/deepseek-automation-api.git
   cd deepseek-automation-api

   npm install
   npm run build

   mkdir -p browsers
   PLAYWRIGHT_BROWSERS_PATH=./browsers npx playwright install chromium
   ```

   (`npm install` runs a `postinstall` hook that downloads Chromium
   into `./browsers`. The explicit command above is a fallback for
   environments where `postinstall` was skipped.)

2. **Run the API once and log in:**

   ```bash
   npm start
   # A browser window opens. Log in to DeepSeek.
   # Wait until the chat UI is fully loaded, then press Ctrl+C.
   ```

   This produces `state.json` in the API directory — the file with the
   cookies that the automation uses.

3. **Install Pingis** in VS Code and set `pingis.apiDir` in Settings to
   the path of your API clone.

On the first task, Pingis:

- builds a multi-agent deployment under `~/.pingis/deepseek-agents/`
  using `tools/make-multi-agent.sh` from the API repo,
- copies `state.json` into the deployment as `shared-state.json`,
- starts two agents sharing those cookies.

You do not need to touch cookies, ports, or scripts manually.

### When cookies expire

DeepSeek cookies last 1–3 months. Symptoms: agents fail to start, or
`Failed to start API` appears in `Output → Pingis`.

Fix:

1. `cd <api-dir> && npm start`, log in again, press Ctrl+C.
2. Refresh the deployment's shared state:

   ```bash
   ~/.pingis/deepseek-agents/scripts/stop-all.sh
   ~/.pingis/deepseek-agents/scripts/refresh-state.sh
   ```

3. Start a task in VS Code. Pingis will launch the agents with the
   refreshed cookies.

Chat history and RAG indexes are not affected.

Full guide:
[Building applications — Multi-agent](https://github.com/maresin/deepseek-automation-api/blob/main/docs/guides/building-applications.md).

## Settings

| Setting | Default | Description |
|---|---|---|
| `pingis.apiDir` | `""` | Path to the DeepSeek Automation API directory. **Required.** Pingis builds the multi-agent deployment under `~/.pingis/deepseek-agents/` from this clone and manages both agents itself. No files are created or modified in the API directory. |
| `pingis.taskTimeoutMinutes` | `120` | Maximum task duration in minutes. On expiry, the task stops and all files are preserved. |
| `pingis.execTimeoutSeconds` | `120` | Timeout for a single `execute` script. Increase for tasks with `npm install` or `cargo build`. |
| `pingis.saveRawResponses` | `false` | Save raw JSON API responses to `.pingis/raw/`. Debug only — files accumulate fast. |

Ports (3098 for the Executor, 3099 for the Critic) come from the
generated deployment and are not configurable via settings.

## Usage

1. **Open a project folder** in VS Code (`File → Open Folder`). Without a folder open, Start is disabled.
2. **Click the Pingis icon** in the Activity Bar.
3. **Fill in the form:**
   - **Project name** — for logs.
   - **Task description** — what you want done. Can be left empty if the description is in attached files.
   - **Attach files** — **only for task descriptions**. `.txt`, `.md`, `.json`, `.yaml`, `.yml`, `.rst`, `.log`, up to 256 KB. For data files (datasets, archives, large sources), place them in the project directory and **reference the path** in the description — the agents will read them.
4. **Start.**

Watch progress in the sidebar. Full logs go to `Output → Pingis` (including the output of both API processes, prefixed `[api-e]` and `[api-c]`).

## What the Executor does

- Explores the working directory. Determines whether it's empty, an existing project, or a pile of loose files. Never recreates what already exists.
- Writes code via a single Python script (`execute`). The script itself creates and edits files, installs dependencies, runs commands. The wrapper is always Python; the target code can be in any language (Node.js, Go, Rust, etc.).
- Respects resource limits: does not create files larger than 50% of free disk, does not process files larger than 80% of available RAM.
- Tracks the context limit and does not read files blindly.
- If the task is **impossible in principle**, calls `send_message(to="critic", message="IMPOSSIBLE: ...")` and stops — instead of producing a fake solution.

## What the Critic does

- Reads files **itself** via `execute` — never trusts the Executor's summary.
- Evaluates on substance: critical errors → `IMPROVE`, working code → `APPROVED`, even with stylistic notes.
- Rejects only on critical violations. Stylistic notes are not grounds for `IMPROVE`. Doesn't hunt for things to nitpick.
- On `IMPOSSIBLE:` — verifies the reasoning and either confirms via `finalize` or asks the Executor to try a different approach.
- On `CONTEXT_LIMIT:` — reads `plan.md` and calls `finalize` with an honest summary.

## The PLAN → STAGE → DONE protocol

For non-trivial tasks, agents don't just dive in. They work in stages:

1. **Executor explores** the directory, then sends a **PLAN** — a list of stages plus a mapping to the task's requirements. Critic replies `APPROVE_PLAN` or `IMPROVE_PLAN`.
2. **After each stage**, Executor sends `STAGE N/M DONE` (what's done, which files, what was verified). Critic replies `APPROVE_STAGE` or `IMPROVE`.
3. **When everything is ready**, Executor sends `ALL DONE`. Critic does a final check and calls `finalize`.

For simple tasks (hello-world), the protocol is skipped — the Executor works immediately and goes straight to `ALL DONE`.

## Context tracking and restart

The API returns a `context_status` field in every response with the exact `percent_used` for the current session. Pingis:

- logs `percent_used` for each agent into `session.log`;
- at `percent_used >= 85%` or on a `warning` from the API — appends `[CONTEXT WARNING]` to the agent's tool result;
- at `percent_used >= 92%` — appends `[CONTEXT CRITICAL]` with an instruction to save progress and stop;
- on 409 (context exhausted) — if it happened on the Executor side, the Critic receives `CONTEXT_LIMIT: ...`, reads `plan.md`, and calls `finalize` with an honest summary: *"done X of Y, restart the task to continue"*.

**To continue after a 409:** just **start the task again in the same folder with the same description**. The Executor sees `plan.md`, reads `## Goal`, finds the first `[ ]`, sends `RESUME: continuing from stage N/M` to the Critic, and picks up where it left off.

## The HELP protocol

When an agent gets stuck, it does not silently retry forever. It sends
the other agent a structured `HELP:` request, and the two work the
problem jointly until it is solved or both conclude it cannot be.

The protocol is a loop:

    Executor (stuck) → Critic:  HELP: <problem>
    Critic (investigates) → Executor:  HELP_RESPONSE: <fix or new direction>
    Executor (applies) → Critic:  SOLVED: <what worked>
    ... or, if the hint did not help:
    Executor → Critic:  HELP: <problem, updated Tried: list>

`IMPOSSIBLE:` from either agent stops the whole task immediately. The
stop reason is `deadlock`; `plan.md` is preserved so the task can be
resumed later.

### Format-problem escalation

DeepSeek Web occasionally truncates long tool-call JSON. When an agent's
reply cannot be parsed as `tool_calls`, the orchestrator escalates in
three stages before giving up:

- **L1a** — retry with a short hint (check brackets, shorter reply).
- **L1b** — retry with a preview of the broken output (first 800 and
  last 400 characters, so the boundary is visible).
- **L3** — the orchestrator sends a `HELP:` request to the other agent
  on the broken agent's behalf, with the last broken attempt attached.

If all three fail, the task stops with `protocol_violation`.

`HELP:` from an agent is always routed as-is; if the sender has a broken
attempt in its recent history, the orchestrator enriches the message
with it before routing.

## Automatic retry on transient errors

Not every failure is a task failure. When the automation API becomes
unavailable — a stray `ECONNREFUSED`, a `502 Bad Gateway`, a `500` from
the API layer — Pingis retries the whole task instead of stopping.

- **Retryable reasons**: `network_error`, `bad_gateway`, `server_error`.
- **Not retryable**: `crash`, `timeout`, `protocol_violation`,
  `deadlock`, `server_busy`, `context_exhausted`, `user_stopped`.
- **Budget**: up to 3 retries with a 5s / 10s / 20s backoff. The task
  timeout is measured once from the first attempt; a retry cannot
  extend the total budget.
- **Agents** are stopped and restarted between attempts. Because
  `.pingis/plan.md` survives, the Executor resumes with `RESUME:`
  instead of starting over.
- **Sidebar** shows `Restarting after error — attempt N/3...` while a
  retry is in progress.

A retry that succeeds continues the same task; a retry that exhausts
the budget returns the last failure reason as the final stop reason.

## Files and paths

### In the project folder

- `.pingis/patch.py` — the last executed Python script.
- `.pingis/session.log` — JSONL, full task timeline.
- `.pingis/plan.md` — the active plan; deleted on clean `done`.
- `.pingis/summary.md` — report of the last completed task; overwritten each run.
- `.pingis/attachments/` — files attached via the panel form.
- `.pingis/raw/` — raw API responses (only if `saveRawResponses = true`).
- `chapters/`, `src/`, `tests/`, `README.md`, etc. — the task's own files. The Executor creates them.

### In your home directory

Everything outside the project lives under `~/.pingis/deepseek-agents/`:

- `shared-state.json` — DeepSeek cookies, shared by both agents.
- `api-path.txt` — absolute path to the API clone.
- `scripts/start-all.sh`, `stop-all.sh`, `status.sh`, `refresh-state.sh`
  — the deployment's own lifecycle scripts.
- `agents/agent-1/` — state of the Executor's API process:
  - `agent.env` — port, feature flags, paths;
  - `.api-key` — API key;
  - `chat_state.json` — DeepSeek chat state (last chat id, counters, snapshot flags);
  - `uploads/` — uploaded files, snapshots, RAG context;
  - `rag_data/` — RAG index (if enabled);
  - `agent.log` — full stdout/stderr of this agent;
  - `agent.pid` — PID when running.
- `agents/agent-2/` — same for the Critic.

These files are **not deleted** when a task stops. They are reused on the next run (faster login, chat preserved).

### In the system temp directory

- `$TMPDIR/pingis/tool-result-*.json` — results of `execute`, passed to the API as multipart attachments. Deleted when a task finishes.

### The API directory

Pingis **does not create** files in the DeepSeek Automation API directory. It reads only `.env` from there and launches `npm start`.

## Logs and debugging

- **`Output → Pingis`** — short real-time summary plus the full output of both API processes (`[api-e]` / `[api-c]`). Internal API noise (context updates, state saves) is filtered — only meaningful milestones appear.
- **`<project>/.pingis/session.log`** — JSONL, full timeline. Each line is one event with fields `seq`, `ts`, `who`, `event`.

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

## Artifacts and task continuity

Pingis uses two files in `.pingis/` to make long tasks resumable
across crashes and restarts.

### `plan.md` — continuation marker

- Written by the Executor after `APPROVE_PLAN`, using `execute`.
- **Presence is the signal**: while `.pingis/plan.md` exists, Pingis
  treats the task as a continuation and does **not** reset the API
  chats. The Executor reads the file, finds the first incomplete
  item (`- [ ]`), and sends `RESUME: continuing from stage N/M`.
- **Absence is the signal too**: when `.pingis/plan.md` does not
  exist, Pingis calls `POST /v1/chat/new` on both agents before the
  first request — a fresh chat, so nothing leaks from the previous
  task.
- On clean `done` the orchestrator deletes the file. On
  `CONTEXT_LIMIT:`, `TIME_LIMIT:`, `IMPOSSIBLE`, or a network
  failure, the file is preserved.

### `summary.md` — persistent report

- Written by the Critic before calling `finalize`. The Critic copies
  the plan into it, because `plan.md` is removed after a clean done.
- Overwritten on every task — one file, always the latest report.
- If the Critic does not write a summary, the orchestrator writes a
  fallback before `stop()`.

### Why this split

`plan.md` is state (working document, deleted when the work is
finished). `summary.md` is history (permanent record). Mixing them
would force a trade-off between "keep the plan" and "keep the
report"; separating them keeps both.

### Sequence on a fresh task

    1. Pingis reads <cwd>/.pingis/plan.md
    2. File missing  -> POST /v1/chat/new (both agents)
    3. Executor explores the directory, sends PLAN:
    4. Critic replies APPROVE_PLAN
    5. Executor writes .pingis/plan.md
    ...
    N. Critic writes .pingis/summary.md, calls finalize
    N+1. Orchestrator deletes .pingis/plan.md
    N+2. stop(reason=done)

### Sequence on a continuation

    1. Pingis reads <cwd>/.pingis/plan.md  -> exists
    2. Chats left untouched; ENABLE_RESTORE reopens the last chat
    3. Executor reads plan.md, finds first "- [ ]"
    4. Executor sends RESUME: continuing from stage N/M
    5. Critic replies APPROVE_PLAN
    6. Work continues from stage N

## About DeepSeek Automation API

**Pingis does not work without DeepSeek Automation API.** It must be cloned and logged in at least once manually. Pingis **launches** the API processes on task start and **stops** them when the task finishes.

> **Pingis does not work with the official DeepSeek API** (`api.deepseek.com`). It works only with the local Playwright-based server that automates the DeepSeek web UI.

### Known limitations and risks

DeepSeek Automation API drives a real browser, not a server API. This means:

- **A redesign of the DeepSeek web app can break the API.** If DeepSeek changes the page layout, buttons, or selectors, the API will stop extracting responses and attaching files. Pingis will then stop working too (all requests will fail with `server_error`).
- **Captcha, authentication changes, new rate limits** may require an API update.
- **Rate limits from DeepSeek** may cause the API to respond slowly or return errors.

### Troubleshooting

1. **Check the API manually:**

   ```bash
   curl http://127.0.0.1:3098/health
   # expect: {"status":"ok",...}
   ```

2. **Look at the API logs** in `Output → Pingis` — they show exactly where it failed (login, selector lookup, response extraction).

3. **Update the API.** If DeepSeek recently changed its UI, a compatible release may be available: `git pull && npm install`.

4. **Restart API processes** — Playwright state can occasionally get stuck:

   ```bash
   ~/.pingis/deepseek-agents/scripts/stop-all.sh
   # then restart the task in VS Code
   ```

   If the deployment is missing, kill by port:

   ```bash
   npx kill-port 3098 3099
   ```

5. **If nothing helps** — contact the DeepSeek Automation API author with the logs.

## Limitations

- **Works only in an open folder.** Without a workspace, Start is disabled.
- **One task at a time.** A second Start restarts the orchestrator.
- **Only the Critic can finish a task.** The Executor has no `finalize` tool.
- **Logs go to Output, not to the sidebar.** The sidebar shows agent status, turn counters, elapsed time, and a "Restarting after error…" indicator during retries; everything else is in `Output → Pingis`.
- **Ports 3098 and 3099 must be free.** Pingis kills whatever is listening on them, including a manually started API.
- **Not suited for:** GUI apps, mobile apps, long-running services, ML training, frontend SPAs, games. Anything that can't be verified from the terminal is out of scope.
- **Best for:** CLI tools, data-processing scripts, REST APIs, parsers, algorithmic problems, tests for existing code.

## Development

```bash
npm install
npm run compile
```

### Launching the extension

```bash
code --extensionDevelopmentPath="$PWD" /path/to/test-workspace
```

### Probe scripts

Do not require VS Code, run from a terminal:

```bash
# Python script execution (no API needed)
npm run probe:exec

# 409 context_exhausted handling (no API needed)
npm run probe:409

# HELP routing between agents (no API needed)
npm run probe:help

# Unified HELP protocol + format escalation (no API needed)
npm run probe:help-protocol

# plan.md / summary.md lifecycle (no API needed)
npm run probe:artifacts

# Retry loop: backoff, budget exhaustion, non-retryable reasons
npm run probe:retry
```

### Project structure

```
pingis/
├── src/
│   ├── extension.ts       entry point
│   ├── panel.ts           webview + orchestration
│   ├── orchestrator.ts    E ↔ C loop
│   ├── api.ts             HTTP client for DeepSeek Automation API
│   ├── api-process.ts     spawn/stop the two API servers
│   ├── executor.ts        Python script execution
│   ├── prompts.ts         system prompts
│   ├── tools.ts           tool JSON schemas
│   ├── config.ts          reads .env and .api-key
│   ├── resources.ts       disk and RAM probing
│   ├── format.ts          tool-result packaging
│   ├── log.ts             JSONL log + OutputChannel
│   ├── retry.ts           retry loop for transient errors
│   └── types.ts           shared types
├── scripts/
│   └── probe-*.ts         probe scripts
├── media/                 panel HTML/CSS/JS
└── package.json
```

## License

MIT

## Credits

Icon from [Flaticon](https://www.flaticon.com/)