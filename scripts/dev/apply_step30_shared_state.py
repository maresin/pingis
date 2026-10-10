#!/usr/bin/env python3
"""
Step 30: shared DeepSeek cookie state for both agents.

Root cause of the captcha loop:
  Each agent had its own state.json and logged in independently.
  Two simultaneous automated logins from the same IP trigger
  Cloudflare Turnstile → both browsers get locked into an infinite
  challenge loop → both time out on waitForSelector.

Fix (per DeepSeek Automation API docs, "Multi-agent deployments"):
  - One SHARED cookie file: ~/.pingis/shared-state.json
  - Login happens once, in a normal browser, not in the automated one.
  - Per-agent: chat_state, api-key, uploads, rag_data.
  - Credentials forced empty so login never happens inside Pingis.

Run from pingis/:
    python scripts/dev/apply_step30_shared_state.py
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BACKUP = ROOT / '.backup'


def backup(rel: str) -> None:
    src = ROOT / rel
    if not src.exists():
        return
    dst = BACKUP / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def patch_api_process() -> None:
    p = ROOT / 'src' / 'api-process.ts'
    if not p.exists():
        print('  ! src/api-process.ts not found')
        return
    backup('src/api-process.ts')
    text = p.read_text(encoding='utf-8')

    if 'sharedStatePath' in text:
        print('  api-process.ts: already patched')
        return

    # 1. Add sharedStatePath getter after keyPath getter.
    OLD_KEYPATH = "  get keyPath(): string { return path.join(this.stateDir, '.api-key'); }"
    NEW_KEYPATH = (
        "  get keyPath(): string { return path.join(this.stateDir, '.api-key'); }\n"
        "\n"
        "  // SHARED cookie file used by both agents (Executor and Critic).\n"
        "  // Prepared once, manually, from a normal browser session.\n"
        "  // See README, \"First-time setup: shared cookie state\".\n"
        "  private get sharedStatePath(): string {\n"
        "    return path.join(os.homedir(), '.pingis', 'shared-state.json');\n"
        "  }"
    )
    if OLD_KEYPATH not in text:
        print('  ! keyPath anchor not found')
        return
    text = text.replace(OLD_KEYPATH, NEW_KEYPATH, 1)
    print('  api-process.ts: sharedStatePath getter added')

    # 2. Add existence check in ensureRunning.
    OLD_ENSURE_TAIL = (
        "    if (!fs.existsSync(path.join(this.opts.apiDir, '.env'))) {\n"
        "      throw new Error(\n"
        "        `File not found: ${path.join(this.opts.apiDir, '.env')}. ` +\n"
        "        `Set a valid pingis.apiDir in settings.`\n"
        "      );\n"
        "    }"
    )

    NEW_ENSURE_TAIL = (
        "    if (!fs.existsSync(path.join(this.opts.apiDir, '.env'))) {\n"
        "      throw new Error(\n"
        "        `File not found: ${path.join(this.opts.apiDir, '.env')}. ` +\n"
        "        `Set a valid pingis.apiDir in settings.`\n"
        "      );\n"
        "    }\n"
        "\n"
        "    if (!fs.existsSync(this.sharedStatePath)) {\n"
        "      this.logSharedStateInstructions();\n"
        "      throw new Error(\n"
        "        `Shared cookie file not found at ${this.sharedStatePath}. ` +\n"
        "        `See Output -> Pingis for setup instructions.`\n"
        "      );\n"
        "    }"
    )

    if OLD_ENSURE_TAIL not in text:
        print('  ! ensureRunning anchor not found')
        return
    text = text.replace(OLD_ENSURE_TAIL, NEW_ENSURE_TAIL, 1)
    print('  api-process.ts: shared-state check added')

    # 3. Modify overrides.
    OLD_OVR = (
        "    const overrides: Record<string, string> = {\n"
        "      PORT: String(this.opts.port),\n"
        "      DEEPSEEK_STATE_PATH: path.join(this.stateDir, 'state.json'),\n"
        "      DEEPSEEK_CHAT_STATE_PATH: path.join(this.stateDir, 'chat_state.json'),\n"
        "      DEEPSEEK_API_KEY_PATH: path.join(this.stateDir, '.api-key'),\n"
        "      DEEPSEEK_UPLOAD_DIR: path.join(this.stateDir, 'uploads'),\n"
        "      RAG_DATA_DIR: path.join(this.stateDir, 'rag_data')\n"
        "    };"
    )

    NEW_OVR = (
        "    const overrides: Record<string, string> = {\n"
        "      PORT: String(this.opts.port),\n"
        "      // SHARED cookie file — same for both agents.\n"
        "      // Login happens once, in a normal browser; both agents reuse it.\n"
        "      DEEPSEEK_STATE_PATH: this.sharedStatePath,\n"
        "      // Per-agent state — must be unique per process.\n"
        "      DEEPSEEK_CHAT_STATE_PATH: path.join(this.stateDir, 'chat_state.json'),\n"
        "      DEEPSEEK_API_KEY_PATH: path.join(this.stateDir, '.api-key'),\n"
        "      DEEPSEEK_UPLOAD_DIR: path.join(this.stateDir, 'uploads'),\n"
        "      RAG_DATA_DIR: path.join(this.stateDir, 'rag_data'),\n"
        "      // Force empty credentials. The automated browser must never\n"
        "      // attempt login — that path leads into the Cloudflare captcha\n"
        "      // loop. If cookies expire, we want a clean failure.\n"
        "      DEEPSEEK_EMAIL: '',\n"
        "      DEEPSEEK_PASSWORD: ''\n"
        "    };"
    )

    if OLD_OVR not in text:
        print('  ! overrides anchor not found')
        return
    text = text.replace(OLD_OVR, NEW_OVR, 1)
    print('  api-process.ts: overrides updated')

    # 4. Add logSharedStateInstructions method.
    # Insert right before the closing brace of the class.
    # Find a stable anchor: `private async spawnProcess()` method.
    ANCHOR = "  private async spawnProcess(): Promise<void> {"

    HELPER = (
        "  private logSharedStateInstructions(): void {\n"
        "    const log = this.opts.logger;\n"
        "    log.raw('');\n"
        "    log.raw('==================================================');\n"
        "    log.raw('  SHARED COOKIE FILE NOT FOUND');\n"
        "    log.raw('==================================================');\n"
        "    log.raw('');\n"
        "    log.raw(`Expected at: ${this.sharedStatePath}`);\n"
        "    log.raw('');\n"
        "    log.raw('Pingis runs two agents (Executor and Critic) that share');\n"
        "    log.raw('a single DeepSeek login. If each agent logs in independently,');\n"
        "    log.raw('Cloudflare Turnstile locks both automated browsers into an');\n"
        "    log.raw('infinite captcha loop.');\n"
        "    log.raw('');\n"
        "    log.raw('Prepare the shared cookie file ONCE, before the first run:');\n"
        "    log.raw('');\n"
        "    log.raw('  1. Log in to https://chat.deepseek.com in Firefox.');\n"
        "    log.raw('     (Not Chrome, not the automated browser.)');\n"
        "    log.raw('  2. Install the Cookie-Editor extension.');\n"
        "    log.raw('  3. On chat.deepseek.com: Cookie-Editor -> Export -> JSON.');\n"
        "    log.raw('     Save the result to /tmp/cookies.json.');\n"
        "    log.raw('  4. Convert to Playwright storageState:');\n"
        "    log.raw('');\n"
        "    log.raw('       mkdir -p ~/.pingis');\n"
        "    log.raw('       python3 cookies-to-state.py /tmp/cookies.json ' +\n"
        "            this.sharedStatePath);\n"
        "    log.raw(`       chmod 600 ${this.sharedStatePath}`);\n"
        "    log.raw('');\n"
        "    log.raw('Full guide:');\n"
        "    log.raw('  https://github.com/maresin/deepseek-automation-api/');\n"
        "    log.raw('    blob/main/examples/multi-agent/README.md');\n"
        "    log.raw('');\n"
        "  }\n"
        "\n"
    )

    if 'logSharedStateInstructions' not in text:
        if ANCHOR not in text:
            print('  ! spawnProcess anchor not found')
            return
        text = text.replace(ANCHOR, HELPER + ANCHOR, 1)
        print('  api-process.ts: instruction logger added')

    p.write_text(text, encoding='utf-8')


def patch_readme() -> None:
    p = ROOT / 'README.md'
    if not p.exists():
        print('  ! README.md not found')
        return
    backup('README.md')
    text = p.read_text(encoding='utf-8')

    if 'First-time setup: shared cookie state' in text:
        print('  README.md: already patched')
        return

    SECTION = '''## First-time setup: shared cookie state

Pingis runs two agents (Executor and Critic) that share a single DeepSeek
login. This is deliberate. If each agent logs in independently, DeepSeek's
Cloudflare Turnstile protection can lock both automated browsers into an
infinite captcha loop — correct answers rejected because the browser's
aggregate trust score is below threshold. Two simultaneous logins from one
IP make this worse.

The fix is to log in **once**, in a normal browser, and share the
resulting cookie file. The automated browsers never visit the login page.

### One-time setup

1. **Log in** to <https://chat.deepseek.com> in Firefox. (Not Chrome, not
   the automated browser — Firefox is currently more trusted by
   Cloudflare's heuristics.)

2. **Install** the Cookie-Editor extension (available for Firefox and
   Chrome).

3. On `chat.deepseek.com`, click Cookie-Editor → **Export → JSON**. Save
   the result to `/tmp/cookies.json`.

4. **Convert** to Playwright's `storageState` format. The converter ships
   with DeepSeek Automation API:

   ```bash
   mkdir -p ~/.pingis
   python3 /path/to/deepseek-automation-api/examples/multi-agent/cookies-to-state.py \\
     /tmp/cookies.json ~/.pingis/shared-state.json
   chmod 600 ~/.pingis/shared-state.json
   ```

5. **Verify** the Cloudflare pass token is present:

   ```bash
   jq '.cookies[].name' ~/.pingis/shared-state.json | grep cf_clearance
   ```

   If `cf_clearance` is missing, the export was taken before Cloudflare's
   challenge completed. Re-login, wait for the chat UI to fully load, then
   re-export.

### What happens on first run

Pingis reads `~/.pingis/shared-state.json`, starts both API processes with
the same cookies, and each process registers its own API key **without
logging in**. Startup takes 10–30 seconds.

### When cookies expire

DeepSeek cookies live 1–3 months. When they expire, Pingis shows
`Failed to start API`, and the log contains
`📌 On login page, attempting auto-login...`. Fix: repeat steps 1–4. Chat
history and RAG indexes are not affected.

Full guide:
[Building applications — Multi-agent](https://github.com/maresin/deepseek-automation-api/blob/main/docs/guides/building-applications.md).

## Settings

| Setting | Default | Description |'''

    OLD = '''## Settings

| Setting | Default | Description |'''

    if OLD not in text:
        print('  ! README: "## Settings" anchor not found')
        return
    text = text.replace(OLD, SECTION, 1)
    p.write_text(text, encoding='utf-8')
    print('  README.md: first-time setup section added')


def git_commit(message: str) -> None:
    if not (ROOT / '.git').exists():
        print('  git: no repo, skipping commit')
        return
    try:
        subprocess.run(['git', 'add', '-A'], cwd=ROOT, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-m', message], cwd=ROOT, check=True, capture_output=True)
        print(f'  git: committed "{message}"')
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode('utf-8', errors='replace').strip()
        print(f'  git: skipped ({stderr.splitlines()[0] if stderr else "no changes"})')


def main() -> int:
    if not (ROOT / 'package.json').exists() or not (ROOT / 'src').exists():
        print('ERROR: run from the pingis/ extension root.')
        return 1
    BACKUP.mkdir(exist_ok=True)

    print('Patching src/api-process.ts:')
    patch_api_process()

    print('Patching README.md:')
    patch_readme()

    print('Git:')
    git_commit('fix: shared cookie state for both agents (avoids captcha loop)')

    print()
    print('Done. Next:')
    print('  npm run compile')
    print('  grep -c "sharedStatePath" src/api-process.ts   # >= 3')
    print('  grep -c "SHARED COOKIE FILE NOT FOUND" src/api-process.ts   # 1')
    print('  grep -c "First-time setup" README.md   # 1')
    return 0


if __name__ == '__main__':
    sys.exit(main())
