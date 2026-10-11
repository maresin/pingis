#!/usr/bin/env python3
"""
Fix step 30: logSharedStateInstructions method was not added.

Предыдущий патч искал anchor `private async spawnProcess(): Promise<void> {`,
но в текущем файле его нет (сигнатура изменилась в ранних шагах).
Привязываемся к `private async waitReady`, который точно есть.

Run from pingis/:
    python scripts/dev/apply_step30_shared_state_fix.py
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


HELPER = '''  private logSharedStateInstructions(): void {
    const log = this.opts.logger;
    log.raw('');
    log.raw('==================================================');
    log.raw('  SHARED COOKIE FILE NOT FOUND');
    log.raw('==================================================');
    log.raw('');
    log.raw(`Expected at: ${this.sharedStatePath}`);
    log.raw('');
    log.raw('Pingis runs two agents (Executor and Critic) that share');
    log.raw('a single DeepSeek login. If each agent logs in independently,');
    log.raw('Cloudflare Turnstile locks both automated browsers into an');
    log.raw('infinite captcha loop.');
    log.raw('');
    log.raw('Prepare the shared cookie file ONCE, before the first run:');
    log.raw('');
    log.raw('  1. Log in to https://chat.deepseek.com in Firefox.');
    log.raw('     (Not Chrome, not the automated browser.)');
    log.raw('  2. Install the Cookie-Editor extension.');
    log.raw('  3. On chat.deepseek.com: Cookie-Editor -> Export -> JSON.');
    log.raw('     Save the result to /tmp/cookies.json.');
    log.raw('  4. Convert to Playwright storageState:');
    log.raw('');
    log.raw('       mkdir -p ~/.pingis');
    log.raw('       python3 cookies-to-state.py /tmp/cookies.json ' +
            this.sharedStatePath);
    log.raw(`       chmod 600 ${this.sharedStatePath}`);
    log.raw('');
    log.raw('Full guide:');
    log.raw('  https://github.com/maresin/deepseek-automation-api/');
    log.raw('    blob/main/examples/multi-agent/README.md');
    log.raw('');
  }

'''


def main() -> int:
    p = ROOT / 'src' / 'api-process.ts'
    if not p.exists():
        print('ERROR: src/api-process.ts not found.')
        return 1

    backup('src/api-process.ts')
    text = p.read_text(encoding='utf-8')

    if 'private logSharedStateInstructions' in text:
        print('  Method already present, nothing to do.')
        return 0

    # Ищем первый из нескольких возможных якорей.
    anchors = [
        '  private async waitReady(',
        '  private async spawnProcess(',
        '  private async ping(',
    ]

    found = None
    for a in anchors:
        if a in text:
            found = a
            break

    if not found:
        print('  ! Ни один из якорей не найден.')
        print('  Показываю имена методов, которые есть в файле:')
        import re
        for m in re.finditer(r'^\s+(private|public|async)\s+(\w+)', text, re.M):
            print(f'    {m.group(0).strip()}')
        return 1

    print(f'  Anchor found: {found.strip()}')

    # Вставляем helper прямо перед якорем.
    text = text.replace(found, HELPER + found, 1)
    p.write_text(text, encoding='utf-8')
    print('  logSharedStateInstructions inserted')

    if (ROOT / '.git').exists():
        try:
            subprocess.run(['git', 'add', 'src/api-process.ts'],
                           cwd=ROOT, check=True, capture_output=True)
            subprocess.run(['git', 'commit', '-m',
                            'fix: insert logSharedStateInstructions method'],
                           cwd=ROOT, check=True, capture_output=True)
            print('  git: committed')
        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode('utf-8', errors='replace').strip()
            print(f'  git: skipped ({stderr.splitlines()[0] if stderr else "no changes"})')

    print()
    print('Next:')
    print('  npm run compile')
    print('  grep -c "logSharedStateInstructions" src/api-process.ts   # >= 2')
    return 0


if __name__ == '__main__':
    sys.exit(main())