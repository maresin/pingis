#!/usr/bin/env python3
"""
Fix cosmetic log summaries after the AgentsProcess refactor.

Old shortSummary for api_spawn / api_ready / api_exit assumed a single
agent with `agent` and `port` fields. Now they take `agents_dir`,
`script`, and `reason` — so the old pattern prints "undefined".

Run from pingis/:
    python scripts/dev/apply_step32_log_fix.py
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


def patch_log() -> None:
    p = ROOT / 'src' / 'log.ts'
    if not p.exists():
        print('  ! src/log.ts not found')
        return
    backup('src/log.ts')
    text = p.read_text(encoding='utf-8')

    OLD = """    case 'api_spawn':
      return `spawn ${r.agent} on port ${r.port}`;
    case 'api_ready':
      return `${r.agent} ready on ${r.port}`;
    case 'api_exit':
      return `${r.agent} exit code=${r.code} (${r.reason ?? '?'})`;"""

    NEW = """    case 'api_spawn':
      return `build/start at ${r.agents_dir ?? r.script ?? '?'}`;
    case 'api_ready':
      return `agents ready at ${r.agents_dir ?? '?'}${r.reused ? ' (reused)' : ''}`;
    case 'api_exit':
      return `agents stopped (${r.reason ?? '?'})`;"""

    if NEW in text:
        print('  log.ts: already patched')
        return
    if OLD not in text:
        print('  ! log.ts: summary block not found')
        print('  Показываю блок "case \'api_spawn\'" если он есть:')
        for i, line in enumerate(text.splitlines(), 1):
            if 'api_spawn' in line or 'api_ready' in line or 'api_exit' in line:
                print(f'  {i:4}| {line}')
        return

    text = text.replace(OLD, NEW, 1)
    p.write_text(text, encoding='utf-8')
    print('  patched src/log.ts')


def git_commit(message: str) -> None:
    if not (ROOT / '.git').exists():
        print('  git: no repo, skipping commit')
        return
    try:
        subprocess.run(['git', 'add', 'src/log.ts'],
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

    print('Patching src/log.ts:')
    patch_log()

    print('Git:')
    git_commit('fix: log summaries for multi-agent api_spawn/ready/exit')

    print()
    print('Done. Next:')
    print('  npm run compile')
    return 0


if __name__ == '__main__':
    sys.exit(main())