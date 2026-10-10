#!/usr/bin/env python3
"""
Step 29: change default ports from 3000/3001 to 3098/3099.

Причины:
  - 3000 — стандартный порт для целевых проектов (Express, FastAPI, Rails)
    и для самого DeepSeek Automation API. Конфликт с целевым проектом
    приводит к тому, что Pingis убивает чужой процесс при старте задачи.
  - 3098/3099 — необычные порты, запоминаются и не конфликтуют.

Что меняется:
  - package.json: defaults apiPortExecutor=3098, apiPortCritic=3099
  - src/panel.ts: fallback-значения при чтении настроек
  - src/config.ts: fallback baseUrl
  - scripts/probe-api.ts, scripts/probe-cycle.ts: дефолты
  - README.md: все упоминания 3000/3001

Run from pingis/:
    python scripts/dev/apply_step29_ports.py
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BACKUP = ROOT / '.backup'

PORT_E_OLD = 3000
PORT_C_OLD = 3001
PORT_E_NEW = 3098
PORT_C_NEW = 3099


def backup(rel: str) -> None:
    src = ROOT / rel
    if not src.exists():
        return
    dst = BACKUP / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def patch_package_json() -> None:
    p = ROOT / 'package.json'
    if not p.exists():
        print('  ! package.json not found')
        return
    backup('package.json')
    data = json.loads(p.read_text(encoding='utf-8'))
    props = data['contributes']['configuration']['properties']

    if 'pingis.apiPortExecutor' in props:
        props['pingis.apiPortExecutor']['default'] = PORT_E_NEW
        print(f'  package.json: apiPortExecutor -> {PORT_E_NEW}')
    if 'pingis.apiPortCritic' in props:
        props['pingis.apiPortCritic']['default'] = PORT_C_NEW
        print(f'  package.json: apiPortCritic -> {PORT_C_NEW}')

    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def patch_text(rel: str, pairs: list, required: bool = True) -> int:
    p = ROOT / rel
    if not p.exists():
        print(f'  ! {rel} not found')
        return 0
    backup(rel)
    text = p.read_text(encoding='utf-8')
    total = 0
    for old, new in pairs:
        n = text.count(old)
        if n > 0:
            text = text.replace(old, new)
            total += n
            print(f'  {rel}: {n} x {old[:60]!r}')
    if total > 0:
        p.write_text(text, encoding='utf-8')
    return total


def patch_panel() -> None:
    patch_text('src/panel.ts', [
        ("cfg.get<number>('apiPortExecutor') ?? 3000",
         "cfg.get<number>('apiPortExecutor') ?? 3098"),
        ("cfg.get<number>('apiPortCritic') ?? 3001",
         "cfg.get<number>('apiPortCritic') ?? 3099"),
    ])


def patch_config() -> None:
    patch_text('src/config.ts', [
        ("'http://127.0.0.1:3000'", "'http://127.0.0.1:3098'"),
    ])


def patch_probes() -> None:
    # probe-api.ts использует один URL по умолчанию.
    patch_text('scripts/probe-api.ts', [
        ("'http://127.0.0.1:3000'", "'http://127.0.0.1:3098'"),
        ("process.env.DS_API_BASE ?? 'http://127.0.0.1:3098'",
         "process.env.DS_API_BASE ?? 'http://127.0.0.1:3098'"),
    ], required=False)

    # probe-cycle.ts использует два URL.
    patch_text('scripts/probe-cycle.ts', [
        ("loadApiConfig(API_DIR, 'http://127.0.0.1:3000', '', 'executor')",
         "loadApiConfig(API_DIR, 'http://127.0.0.1:3098', '', 'executor')"),
        ("loadApiConfig(API_DIR, 'http://127.0.0.1:3001', '', 'critic')",
         "loadApiConfig(API_DIR, 'http://127.0.0.1:3099', '', 'critic')"),
    ])


def patch_readme() -> None:
    p = ROOT / 'README.md'
    if not p.exists():
        print('  ! README.md not found')
        return
    backup('README.md')
    text = p.read_text(encoding='utf-8')

    # Заменяем все упоминания портов в тексте и в командах.
    pairs = [
        ('(port 3000)', '(port 3098)'),
        ('(port 3001)', '(port 3099)'),
        ('`3000`', '`3098`'),
        ('`3001`', '`3099`'),
        ('Ports 3000 and 3001', 'Ports 3098 and 3099'),
        ('http://127.0.0.1:3000/health', 'http://127.0.0.1:3098/health'),
    ]
    total = 0
    for old, new in pairs:
        n = text.count(old)
        if n > 0:
            text = text.replace(old, new)
            total += n
            print(f'  README.md: {n} x {old[:50]!r}')

    if total > 0:
        p.write_text(text, encoding='utf-8')


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

    print('Patching package.json:')
    patch_package_json()

    print('Patching src/panel.ts:')
    patch_panel()

    print('Patching src/config.ts:')
    patch_config()

    print('Patching probe scripts:')
    patch_probes()

    print('Patching README.md:')
    patch_readme()

    print('Git:')
    git_commit('fix: change default ports to 3098/3099 to avoid conflicts')

    print()
    print('Done. Next:')
    print('  npm run compile')
    print('  grep -n "3098\\|3099" package.json src/panel.ts src/config.ts README.md')
    print()
    print('Проверить:')
    print('  - в настройках VS Code новые порты видны (Settings → Pingis)')
    print('  - при старте задачи в session.log будет port=3098 и port=3099')
    print('  - DeepSeek API по-прежнему стартует (не конфликтует с чем-то ещё)')
    return 0


if __name__ == '__main__':
    sys.exit(main())