#!/usr/bin/env python3
"""
Step 33: HELP protocol for joint debugging.

Executor:
  - when stuck (3+ identical failures), instead of hammering alone,
    sends HELP: to Critic with structured context.
Critic:
  - on HELP: reads files, reproduces the error, replies HELP_RESPONSE
    or IMPOSSIBLE.
  - on TIME_LIMIT: finalizes with an honest summary (used by a future
    soft-timeout step).

Run from pingis/:
    python scripts/dev/apply_step33_help.py
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


def patch_executor(text: str) -> tuple:
    anchor = """4. AS YOU GO — report after each significant stage:
   send_message(to="critic", message="STAGE N/M DONE:
   Done: <brief>
   Files: <exact paths>
   Verified: <what you ran, what you got>
   Next: <name of next stage>")
   Wait for APPROVE_STAGE before the next stage."""

    addition = """4. AS YOU GO — report after each significant stage:
   send_message(to="critic", message="STAGE N/M DONE:
   Done: <brief>
   Files: <exact paths>
   Verified: <what you ran, what you got>
   Next: <name of next stage>")
   Wait for APPROVE_STAGE before the next stage.

4b. WHEN YOU GET STUCK — HELP protocol:
   You are considered STUCK if any of these is true:
     • three or more consecutive execute calls failed with the same
       class of error, OR
     • your edits do not change the outcome, OR
     • you no longer understand what to try next.

   At that moment, DO NOT keep hammering alone. Do not wait for a
   5th or 10th attempt. Send the Critic a structured request:

     send_message(to="critic", message="HELP:
     Problem: <one sentence, what is broken>
     Error: <exact error message, 10-20 lines maximum>
     Tried: <bulleted list of approaches you already tried>
     Files: <absolute paths to relevant files>
     Question: <the specific question you need answered>")

   The Critic will read your files, reproduce the error, and reply
   with one of:
     • HELP_RESPONSE: <concrete fix or different approach>
     • IMPOSSIBLE: <why the current approach cannot work>
     • QUESTION: <clarifying question>

   Iterate with the Critic until either the problem is solved or
   time runs out. Do not fall back to solo debugging after a HELP
   exchange — keep the Critic in the loop."""

    if addition in text:
        return text, False
    if anchor not in text:
        print('  ! Executor anchor (stage 4) not found')
        return text, False
    text = text.replace(anchor, addition, 1)
    return text, True


def patch_critic(text: str) -> tuple:
    anchor = """"ALL DONE: ...":
  1. Final check of key files, run tests.
  2. If all good — finalize with an honest summary.
  3. If not — "IMPROVE: <what exactly is not done>"."""

    addition = """"ALL DONE: ...":
  1. Final check of key files, run tests.
  2. If all good — finalize with an honest summary.
  3. If not — "IMPROVE: <what exactly is not done>".

"HELP: ...":
  The Executor is stuck and needs your help. This is joint debugging,
  not review.
  1. Read the files it mentioned via execute.
  2. Reproduce the error yourself: run the failing command.
  3. Diagnose: is the approach wrong, or the implementation buggy?
     Read the "Tried:" section carefully — do NOT propose anything
     the Executor already tried.
  4. Reply with one of:
     • "HELP_RESPONSE: <concrete fix or different approach, with reasoning>"
     • "IMPOSSIBLE: <why the current approach cannot work>"
     • "QUESTION: <clarifying question>"
  Keep HELP_RESPONSE short and concrete. Do not write a long essay.
  If you can point at a specific line and say "change X to Y because
  Z", do that.

"TIME_LIMIT: ...":
  The overall task time has expired. Read .pingis/plan.md (if present)
  and key files. Assess what's done and what's not. Call finalize
  with an honest summary: what's done, what's not, what the user
  should do when restarting the task. Do not try to keep working —
  finalize immediately."""

    if addition in text:
        return text, False
    if anchor not in text:
        print('  ! Critic anchor (ALL DONE) not found')
        return text, False
    text = text.replace(anchor, addition, 1)
    return text, True


def main() -> int:
    p = ROOT / 'src' / 'prompts.ts'
    if not p.exists():
        print('ERROR: src/prompts.ts not found. Run from pingis/ root.')
        return 1

    backup('src/prompts.ts')
    text = p.read_text(encoding='utf-8')

    text, ok_e = patch_executor(text)
    if ok_e:
        print('  Executor: HELP section added')
    else:
        print('  Executor: not patched')

    text, ok_c = patch_critic(text)
    if ok_c:
        print('  Critic: HELP and TIME_LIMIT handlers added')
    else:
        print('  Critic: not patched')

    if not (ok_e or ok_c):
        print()
        print('Ничего не изменено. Возможно, шаг уже применён.')
        return 0

    p.write_text(text, encoding='utf-8')

    if (ROOT / '.git').exists():
        try:
            subprocess.run(['git', 'add', 'src/prompts.ts'],
                           cwd=ROOT, check=True, capture_output=True)
            subprocess.run(['git', 'commit', '-m',
                            'feat: HELP protocol for joint debugging'],
                           cwd=ROOT, check=True, capture_output=True)
            print('  git: committed')
        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode('utf-8', errors='replace').strip()
            print(f'  git: skipped ({stderr.splitlines()[0] if stderr else "no changes"})')

    print()
    print('Done. Next:')
    print('  npm run compile')
    print('  grep -c "HELP:" src/prompts.ts        # >= 3')
    print('  grep -c "HELP_RESPONSE" src/prompts.ts  # >= 2')
    print('  grep -c "TIME_LIMIT" src/prompts.ts   # >= 1')
    return 0


if __name__ == '__main__':
    sys.exit(main())