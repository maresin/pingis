/**
 * Unit test for step 61 — three-state plan markers in prompts.
 *
 * The prompts are strings; this probe asserts the required
 * substrings are present. It does not exercise LLM behavior.
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-plan-markers.ts
 */

import { buildSystemPrompts } from '../src/prompts';

let failures = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

const prompts = buildSystemPrompts({
  cwd: '/tmp/probe-plan-markers',
  name: 'probe',
  task: 'stub',
  diskFree: '10 GB',
  ramFree: '4 GB',
  contextLimitChars: 2_400_000
});

const E = prompts.executorPrompt;
const C = prompts.criticPrompt;

// --- Executor ---
check(E.includes('[~]'), 'Executor mentions [~]');
check(E.includes('attempted but not resolved'),
  'Executor explains what [~] means');
check(E.includes('not marked [x]'),
  'Executor resume logic looks for non-[x] items');
check(E.includes('"- [~] N."') || E.includes("'- [~] N.'"),
  'Executor code sample shows [~] assignment');
check(E.includes('the action is the goal'),
  'Executor has stage-wording guidance');

// --- Critic ---
check(C.includes('[~]'), 'Critic mentions [~]');
check(C.includes('attempted, not resolved'),
  'Critic explains [~]');
check(C.includes('actually revisits it') || C.includes('revisits it'),
  'Critic instructed to verify [~] is revisited');
check(C.includes('at most THREE turns'),
  'Critic TIME_LIMIT handler is three-turn bounded');
check(C.includes('Do NOT go deep'),
  'Critic TIME_LIMIT handler forbids deep investigation');

console.log();
if (failures === 0) {
  console.log('=== SUCCESS: plan markers present in prompts ===');
  process.exit(0);
} else {
  console.log(`=== FAILURE: ${failures} check(s) failed ===`);
  process.exit(1);
}
