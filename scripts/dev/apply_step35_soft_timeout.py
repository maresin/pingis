#!/usr/bin/env python3
"""
Step 35: soft timeout + log cosmetics + release v0.3.2.

- orchestrator.ts: soft deadline -> inject TIME_LIMIT into Critic's
  queue; hard deadline (+120s) -> hard stop.
- log.ts: api_spawn summary distinguishes build vs start.
- package.json: version -> 0.3.2
- CHANGELOG.md: [0.3.2] entry.

Run from pingis/:
    python scripts/dev/apply_step35_soft_timeout.py
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BACKUP = ROOT / '.backup'


CHANGELOG_ENTRY = """## [0.3.2] - 2026-10-11

### Added

- Soft timeout in the orchestrator. On task timeout, the Critic is
  asked to finalize first (`TIME_LIMIT:` message); a hard stop
  follows only after a 120-second grace period. The user gets a
  meaningful summary instead of a silent `timeout` stop.
- Log summaries distinguish between building the multi-agent
  deployment and starting it.

"""


def backup(rel: str) -> None:
    src = ROOT / rel
    if not src.exists():
        return
    dst = BACKUP / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


# ============ orchestrator.ts ============

def patch_orchestrator() -> None:
    p = ROOT / 'src' / 'orchestrator.ts'
    if not p.exists():
        print('  ! src/orchestrator.ts not found')
        return
    backup('src/orchestrator.ts')
    text = p.read_text(encoding='utf-8')

    if 'softDeadline' in text:
        print('  orchestrator.ts: already patched')
        return

    # Ищем начало while-цикла с проверкой таймаута. Возможные варианты
    # после step26 (перевод на английский).
    candidates = [
        (
            "    while (!this.stopped) {\n"
            "      if (Date.now() - start > this.opts.timeoutMs) {\n"
            "        this.stop('timeout', 'Task timeout exceeded.');\n"
            "        break;\n"
            "      }",
            "task_timeout_en"
        ),
        (
            "    while (!this.stopped) {\n"
            "      if (Date.now() - start > this.opts.timeoutMs) {\n"
            "        this.stop('timeout', 'Превышено максимальное время задачи.');\n"
            "        break;\n"
            "      }",
            "task_timeout_ru"
        ),
    ]

    found_key = None
    for old, key in candidates:
        if old in text:
            found_key = key
            break

    if not found_key:
        print('  ! orchestrator.ts: while/timeout block not found')
        print('  Показываю строки вокруг "while (!this.stopped)":')
        lines = text.splitlines()
        for i, line in enumerate(lines, 1):
            if 'while (!this.stopped)' in line:
                for j in range(max(0, i - 2), min(len(lines), i + 8)):
                    print(f'  {j + 1:4}| {lines[j]}')
                print('  ---')
        return

    NEW_BLOCK = """    const softDeadline = start + this.opts.timeoutMs;
    const hardDeadline = softDeadline + 120_000;
    let softFired = false;

    while (!this.stopped) {
      const now = Date.now();

      if (!softFired && now > softDeadline) {
        softFired = true;
        if (!this.deadC) {
          this.log.event('orchestrator', 'error', {
            stage: 'timeout',
            code: 'soft_deadline',
            detail: 'Asking Critic to finalize.'
          });
          this.queueC.push({
            msg: {
              role: 'user',
              content:
                'TIME_LIMIT: The overall task time has expired. Read ' +
                '.pingis/plan.md (if present) and key files. Assess what ' +
                'is done and what is not. Call finalize with an honest ' +
                'summary: what is done, what is not, and what the user ' +
                'should do when restarting the task. Do not keep working.'
            }
          });
        }
      }

      if (now > hardDeadline) {
        this.log.event('orchestrator', 'error', {
          stage: 'timeout',
          code: 'hard_deadline',
          detail: 'Grace period exhausted.'
        });
        this.stop('timeout', 'Task timeout exceeded.');
        break;
      }"""

    for old, key in candidates:
        if key == found_key:
            text = text.replace(old, NEW_BLOCK, 1)
            break

    p.write_text(text, encoding='utf-8')
    print('  orchestrator.ts: soft+hard deadlines added')


# ============ log.ts ============

def patch_log() -> None:
    p = ROOT / 'src' / 'log.ts'
    if not p.exists():
        print('  ! src/log.ts not found')
        return
    backup('src/log.ts')
    text = p.read_text(encoding='utf-8')

    if "r.reason === 'build_deployment'" in text:
        print('  log.ts: already patched')
        return

    OLD = """    case 'api_spawn':
      return `build/start at ${r.agents_dir ?? r.script ?? '?'}`;"""

    NEW = """    case 'api_spawn':
      if (r.reason === 'build_deployment') {
        return `build deployment at ${r.target ?? r.script ?? '?'}`;
      }
      return `start agents at ${r.agents_dir ?? '?'}`;"""

    if NEW in text:
        print('  log.ts: already patched')
        return
    if OLD not in text:
        print('  ! log.ts: api_spawn summary not found')
        return

    text = text.replace(OLD, NEW, 1)
    p.write_text(text, encoding='utf-8')
    print('  log.ts: api_spawn summary improved')


# ============ version + CHANGELOG ============

def bump_version() -> None:
    p = ROOT / 'package.json'
    backup('package.json')
    data = json.loads(p.read_text(encoding='utf-8'))
    data['version'] = '0.3.2'
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('  package.json: version -> 0.3.2')


def update_changelog() -> None:
    p = ROOT / 'CHANGELOG.md'
    if not p.exists():
        print('  ! CHANGELOG.md not found')
        return
    backup('CHANGELOG.md')
    text = p.read_text(encoding='utf-8')

    if '## [0.3.2]' in text:
        print('  CHANGELOG.md: already has [0.3.2]')
        return

    anchor = '## [0.3.1]'
    if anchor not in text:
        print('  ! CHANGELOG.md: [0.3.1] anchor not found')
        return

    text = text.replace(anchor, CHANGELOG_ENTRY + anchor, 1)
    p.write_text(text, encoding='utf-8')
    print('  CHANGELOG.md: [0.3.2] added')


def git_commit(message: str) -> None:
    if not (ROOT / '.git').exists():
        print('  git: no repo, skipping')
        return
    try:
        subprocess.run(['git', 'add', '-A'], cwd=ROOT, check=True, capture_output=True)
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

    print('Patching orchestrator.ts:')
    patch_orchestrator()

    print('Patching log.ts:')
    patch_log()

    print('Bumping version:')
    bump_version()

    print('Updating CHANGELOG:')
    update_changelog()

    print('Git:')
    git_commit('release: v0.3.2 — soft timeout, log cosmetics')

    print()
    print('Done. Next:')
    print('  npm run compile')
    print('  grep -c "softDeadline" src/orchestrator.ts      # >= 2')
    print('  grep -c "hardDeadline" src/orchestrator.ts      # >= 2')
    print('  grep -c "TIME_LIMIT:" src/orchestrator.ts       # 1')
    print('  grep \'"version"\' package.json | head -1       # 0.3.2')
    print()
    print('Затем:')
    print('  rm -f pingis-0.3.1.vsix')
    print('  npx @vscode/vsce package')
    return 0


if __name__ == '__main__':
    sys.exit(main())