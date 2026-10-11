#!/usr/bin/env python3
"""
Fix step 30: call POST /v1/register after the API is ready.

Problem:
  The API, started with DEEPSEEK_EMAIL='' and DEEPSEEK_PASSWORD='',
  does NOT auto-register. It waits for a manual POST /v1/register,
  which our extension never sent. So no .api-key file was written,
  and waitForKeyFile timed out.

Fix (per DeepSeek Automation API multi-agent README):
  After /health responds, POST /v1/register with an empty body.
  The API uses the cookies from shared-state.json, creates a session,
  writes the key to DEEPSEEK_API_KEY_PATH, and returns 200.

Run from pingis/:
    python scripts/dev/apply_step30_register.py
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

    if 'registerSession' in text:
        print('  api-process.ts: already patched')
        return

    # 1. Call registerSession after waitReady in ensureRunning.
    OLD = (
        "    await this.spawnProcess();\n"
        "    await this.waitReady();\n"
        "  }"
    )

    NEW = (
        "    await this.spawnProcess();\n"
        "    await this.waitReady();\n"
        "    await this.registerSession();\n"
        "  }"
    )

    if OLD not in text:
        print('  ! ensureRunning tail anchor not found')
        return
    text = text.replace(OLD, NEW, 1)
    print('  api-process.ts: registerSession wired into ensureRunning')

    # 2. Insert registerSession method right before waitReady.
    ANCHOR = "  private async waitReady("

    METHOD = '''  private async registerSession(): Promise<void> {
    // With credentials empty (as Pingis sets them), the API does not
    // auto-register. It waits for a manual POST /v1/register. This
    // call uses the cookies from shared-state.json — no login, no
    // captcha. On success, the API writes DEEPSEEK_API_KEY_PATH.
    const url = `${this.baseUrl}/v1/register`;
    this.opts.logger.raw(`[api] POST ${url} (cookie-based registration)`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal
      });

      if (!r.ok) {
        const detail = await safeText(r);
        this.opts.logger.raw(
          `[api] register FAILED: HTTP ${r.status} ${detail}`
        );
        throw new Error(
          `Cookie-based registration failed (HTTP ${r.status}). ` +
          `The shared-state.json cookies may be stale. ` +
          `Re-export them from a normal browser.`
        );
      }

      const text = await r.text();
      this.opts.logger.raw(
        `[api] register OK: ${text.slice(0, 200)}`
      );
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        throw new Error('Registration timed out after 180s.');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

'''

    if 'private async registerSession' not in text:
        if ANCHOR not in text:
            print('  ! waitReady anchor not found')
            return
        text = text.replace(ANCHOR, METHOD + ANCHOR, 1)
        print('  api-process.ts: registerSession method added')

    # 3. Ensure `safeText` helper exists at module bottom.
    if 'async function safeText' not in text:
        SAFE = '''

async function safeText(r: Response): Promise<string> {
  try { return (await r.text()).slice(0, 300); }
  catch { return ''; }
}
'''
        text = text.rstrip() + '\n' + SAFE
        print('  api-process.ts: safeText helper appended')

    p.write_text(text, encoding='utf-8')


def git_commit(message: str) -> None:
    if not (ROOT / '.git').exists():
        print('  git: no repo, skipping commit')
        return
    try:
        subprocess.run(['git', 'add', 'src/api-process.ts'],
                       cwd=ROOT, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-m', message],
                       cwd=ROOT, check=True, capture_output=True)
        print(f'  git: committed "{message}"')
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode('utf-8', errors='replace').strip()
        print(f'  git: skipped ({stderr.splitlines()[0] if stderr else "no changes"})')


def main() -> int:
    if not (ROOT / 'package.json').exists():
        print('ERROR: run from the pingis/ extension root.')
        return 1
    BACKUP.mkdir(exist_ok=True)

    print('Patching src/api-process.ts:')
    patch_api_process()

    print('Git:')
    git_commit('fix: call /v1/register after API is ready (cookie-based)')

    print()
    print('Done. Next:')
    print('  npm run compile')
    print('  grep -c "registerSession" src/api-process.ts   # >= 3')
    return 0


if __name__ == '__main__':
    sys.exit(main())