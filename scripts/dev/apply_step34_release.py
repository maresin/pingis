#!/usr/bin/env python3
"""
Step 34: release v0.3.1.

- package.json: version -> 0.3.1
- CHANGELOG.md: add [0.3.1] entry
- commits, doesn't push. Push manually after a successful build.

Run from pingis/:
    python scripts/dev/apply_step34_release.py
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BACKUP = ROOT / '.backup'


CHANGELOG_ENTRY = """## [0.3.1] - 2026-10-11

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

"""


def backup(rel: str) -> None:
    src = ROOT / rel
    if not src.exists():
        return
    dst = BACKUP / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def bump_version() -> None:
    p = ROOT / 'package.json'
    backup('package.json')
    data = json.loads(p.read_text(encoding='utf-8'))
    data['version'] = '0.3.1'
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('  package.json: version -> 0.3.1')


def update_changelog() -> None:
    p = ROOT / 'CHANGELOG.md'
    if not p.exists():
        print('  ! CHANGELOG.md not found, skipping')
        return
    backup('CHANGELOG.md')
    text = p.read_text(encoding='utf-8')

    if '## [0.3.1]' in text:
        print('  CHANGELOG.md: already has [0.3.1]')
        return

    # Вставить перед первой записью [0.3.0].
    anchor = '## [0.3.0]'
    if anchor not in text:
        print('  ! CHANGELOG.md: [0.3.0] anchor not found')
        return

    text = text.replace(anchor, CHANGELOG_ENTRY + anchor, 1)
    p.write_text(text, encoding='utf-8')
    print('  CHANGELOG.md: [0.3.1] added')


def git_commit() -> None:
    if not (ROOT / '.git').exists():
        print('  git: no repo, skipping commit')
        return
    try:
        subprocess.run(['git', 'add', 'package.json', 'CHANGELOG.md'],
                       cwd=ROOT, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-m', 'release: v0.3.1'],
                       cwd=ROOT, check=True, capture_output=True)
        print('  git: committed "release: v0.3.1"')
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode('utf-8', errors='replace').strip()
        print(f'  git: skipped ({stderr.splitlines()[0] if stderr else "no changes"})')


def main() -> int:
    if not (ROOT / 'package.json').exists():
        print('ERROR: run from the pingis/ extension root.')
        return 1
    BACKUP.mkdir(exist_ok=True)

    print('Bumping version:')
    bump_version()

    print('Updating CHANGELOG:')
    update_changelog()

    print('Git:')
    git_commit()

    print()
    print('Done. Next:')
    print('  rm -f pingis-0.3.0.vsix pingis-0.3.1.vsix')
    print('  npx @vscode/vsce package')
    print('  ls -la pingis-0.3.1.vsix')
    return 0


if __name__ == '__main__':
    sys.exit(main())