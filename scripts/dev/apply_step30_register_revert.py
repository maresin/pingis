#!/usr/bin/env python3
"""
Fix: remove the registerSession call from api-process.ts.

/v1/register is for login with credentials, not for picking up
existing cookies. When credentials are empty it wipes the state
file and goes into manual login mode, which then times out.

The API reads shared-state.json at startup. If cookies are valid
it registers itself. If not, it says "No session" and waits.

Run from pingis/:
    python scripts/dev/apply_step30_register_revert.py
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


def main() -> int:
    p = ROOT / 'src' / 'api-process.ts'
    if not p.exists():
        print('ERROR: src/api-process.ts not found.')
        return 1

    backup('src/api-process.ts')
    text = p.read_text(encoding='utf-8')

    OLD = (
        "    await this.spawnProcess();\n"
        "    await this.waitReady();\n"
        "    await this.registerSession();\n"
        "  }"
    )
    NEW = (
        "    await this.spawnProcess();\n"
        "    await this.waitReady();\n"
        "  }"
    )

    if OLD in text:
        text = text.replace(OLD, NEW, 1)
        print('  api-process.ts: registerSession call removed')
    else:
        print('  api-process.ts: call site not found (already clean?)')

    # Also drop the method itself if present.
    import re
    new_text, n = re.subn(
        r"  private async registerSession\(\): Promise<void> \{[\s\S]*?\n  \}\n\n",
        "",
        text,
    )
    if n > 0:
        text = new_text
        print(f'  api-process.ts: registerSession method removed ({n})')

    p.write_text(text, encoding='utf-8')

    if (ROOT / '.git').exists():
        try:
            subprocess.run(['git', 'add', 'src/api-process.ts'],
                           cwd=ROOT, check=True, capture_output=True)
            subprocess.run(['git', 'commit', '-m',
                            'fix: do not call /v1/register; let API read shared cookies'],
                           cwd=ROOT, check=True, capture_output=True)
            print('  git: committed')
        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode('utf-8', errors='replace').strip()
            print(f'  git: skipped ({stderr.splitlines()[0] if stderr else "no changes"})')

    print()
    print('Next:')
    print('  npm run compile')
    print('  grep -c "registerSession" src/api-process.ts   # должно быть 0')
    return 0


if __name__ == '__main__':
    sys.exit(main())