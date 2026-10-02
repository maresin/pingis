<p align="center">
  <img src="media/icon-marketplace.png" alt="Pingis logo" width="128" height="128">
</p>

<h1 align="center">Pingis</h1>

> Two AI agents. One writes code, the other reviews it. Back and forth, like a ping-pong rally.

**Pingis** is a VS Code extension that turns your editor into a two-agent development environment. An **Executor** writes and runs code. A **Critic** reads the files, checks the work, and either approves or asks for improvements. They work iteratively, in stages, until the task is done.

Powered by [DeepSeek Automation API](https://github.com/maresin/deepseek-automation-api) — a local server that drives the DeepSeek web UI via Playwright.

---

## Why two agents?

A single LLM assistant has a known failure mode: it does the work, then declares victory. It rarely catches its own mistakes. Pingis puts a second, independent agent in the loop whose *only* job is to verify — read the files, run the tests, look for what's missing.

The result is not "faster code". It's **code that has already been reviewed by the time it lands on disk**.

## How it works

When you start a task, Pingis:

1. Spins up **two independent DeepSeek Automation API servers** — one for the Executor (port 3000), one for the Critic (port 3001). Each has its own Chromium, its own chat session, its own API key.
2. Hands the task to the Executor, who explores the working directory and (for non-trivial tasks) proposes a plan.
3. The Critic reviews the plan, then reviews each stage as the Executor completes it.
4. When the Executor is done, the Critic does a final check and either approves or sends the work back.

Everything happens **inside your open project folder**. No files are created outside of it — except for local service files, see [Files and paths](#files-and-paths).

## Requirements

- **VS Code 1.85+** or **VSCodium**
- **Node.js 18+**
- **[uv](https://docs.astral.sh/uv/)** — for isolated Python environments
- **DeepSeek Automation API** — cloned and logged in at least once (Chromium is downloaded via `npx playwright install chromium`)

## Installation

1. **Install `uv`:**

   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. **Set up DeepSeek Automation API** per its own README. On first run, a browser window opens for login to the DeepSeek web app.

3. **Install the extension** in VS Code or VSCodium.

4. **Configure:** open Settings (`Ctrl+,`), search `Pingis`, set **Api Dir** to the path of your DeepSeek Automation API clone.

## Settings

| Setting | Default | Description |
|---|---|---|
| `pingis.apiDir` | `""` | Path to the DeepSeek Automation API directory. **Required.** Pingis reads `.env` from there and launches `npm start` in it. No files are created or modified in that directory. |
| `pingis.apiPortExecutor` | `3000` | Port for the Executor's API server. |
| `pingis.apiPortCritic` | `3001` | Port for the Critic's API server. |
| `pingis.taskTimeoutMinutes` | `120` | Maximum task duration in minutes. On expiry, the task stops and all files are preserved. |
| `pingis.execTimeoutSeconds` | `120` | Timeout for a single `execute` script. Increase for tasks with `npm install` or `cargo build`. |
| `pingis.saveRawResponses` | `false` | Save raw JSON API responses to `.pingis/raw/`. Debug only — files accumulate fast. |

The fallback settings `pingis.apiBaseUrl` and `pingis.apiKey` are used only when `apiDir` is empty.

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
- Bounded to 3 improvement iterations per fragment. Doesn't hunt for things to nitpick.
- On `IMPOSSIBLE:` — verifies the reasoning and either confirms via `finalize` or asks the Executor to try a different approach.
- On `CONTEXT_LIMIT:` — reads `plan.md` and calls `finalize` with an honest summary.

## The PLAN → STAGE → DONE protocol

For non-trivial tasks, agents don't just dive in. They work in stages:

1. **Executor explores** the directory, then sends a **PLAN** — a list of stages plus a mapping to the task's requirements. Critic replies `APPROVE_PLAN` or `IMPROVE_PLAN`.
2. **After each stage**, Executor sends `STAGE N/M DONE` (what's done, which files, what was verified). Critic replies `APPROVE_STAGE` or `IMPROVE`.
3. **When everything is ready**, Executor sends `ALL DONE`. Critic does a final check and calls `finalize`.

For simple tasks (hello-world), the protocol is skipped — the Executor works immediately and goes straight to `ALL DONE`.

## The `plan.md` file

After `APPROVE_PLAN`, the Executor creates `.pingis/plan.md`:

```markdown
# Task Plan

## Goal
<short formulation from the task>

## Stages
- [x] 1. Project initialization
- [x] 2. Data model
- [ ] 3. CLI
- [ ] 4. Tests

## Key Decisions
- DataFrame as a wrapper over numpy.ndarray
- gen uses random.Random(seed)
```

Stages are marked off as they're approved. The **Key Decisions** section holds short architectural notes.

If the task is long and the context runs out, `plan.md` is what makes it possible to continue after a restart.

## Context tracking and restart

The API returns a `context_status` field in every response with the exact `percent_used` for the current session. Pingis:

- logs `percent_used` for each agent into `session.log`;
- at `percent_used >= 85%` or on a `warning` from the API — appends `[CONTEXT WARNING]` to the agent's tool result;
- at `percent_used >= 92%` — appends `[CONTEXT CRITICAL]` with an instruction to save progress and stop;
- on 409 (context exhausted) — if it happened on the Executor side, the Critic receives `CONTEXT_LIMIT: ...`, reads `plan.md`, and calls `finalize` with an honest summary: *"done X of Y, restart the task to continue"*.

**To continue after a 409:** just **start the task again in the same folder with the same description**. The Executor sees `plan.md`, reads `## Goal`, finds the first `[ ]`, sends `RESUME: continuing from stage N/M` to the Critic, and picks up where it left off.

## Files and paths

### In the project folder

- `.pingis/patch.py` — the last executed Python script.
- `.pingis/session.log` — JSONL, full task timeline.
- `.pingis/plan.md` — the plan (for multi-stage tasks).
- `.pingis/attachments/` — files attached via the panel form.
- `.pingis/raw/` — raw API responses (only if `saveRawResponses = true`).
- `chapters/`, `src/`, `tests/`, `README.md`, etc. — the task's own files. The Executor creates them.

### In your home directory

- `~/.pingis/executor/` — state of the Executor's API process:
  - `state.json` — Chromium cookies and origins;
  - `chat_state.json` — DeepSeek chat state;
  - `.api-key` — API key;
  - `uploads/` — uploaded files;
  - `rag_data/` — RAG index (if enabled).
- `~/.pingis/critic/` — same for the Critic's API process.

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
   curl http://127.0.0.1:3000/health
   # expect: {"status":"ok",...}
   ```

2. **Look at the API logs** in `Output → Pingis` — they show exactly where it failed (login, selector lookup, response extraction).

3. **Update the API.** If DeepSeek recently changed its UI, a compatible release may be available: `git pull && npm install`.

4. **Restart API processes** — Playwright state can occasionally get stuck:

   ```bash
   pkill -f "deepseek-automation-api"
   pkill -f Chromium
   # then restart the task in VS Code
   ```

5. **If nothing helps** — contact the DeepSeek Automation API author with the logs.

## Limitations

- **Works only in an open folder.** Without a workspace, Start is disabled.
- **One task at a time.** A second Start restarts the orchestrator.
- **Only the Critic can finish a task.** The Executor has no `finalize` tool.
- **Logs go to Output, not to the UI.** The sidebar shows only status.
- **Ports 3000 and 3001 must be free.** Pingis kills whatever is listening on them, including a manually started API.
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
# Check the API (requires running API processes)
npx ts-node --project scripts/tsconfig.json scripts/probe-api.ts <api-dir>

# Check Python script execution
npm run probe:exec

# Full E ↔ C cycle without UI
npx ts-node --project scripts/tsconfig.json scripts/probe-cycle.ts <api-dir>

# Unit test for 409 handling (no API needed)
npx ts-node --project scripts/tsconfig.json scripts/probe-409.ts
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