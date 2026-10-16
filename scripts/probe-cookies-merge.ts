/**
 * Unit test for step 68/70 — AgentSession.absorbCookies.
 *
 * Two behaviors are checked:
 *
 *   - Parser: getSetCookie() values are parsed into name=value pairs,
 *     one per Set-Cookie entry (step70 replaced a comma-regex that
 *     collapsed multi-cookie responses into a single pair).
 *
 *   - Merger: absorbCookies merges by cookie name, preserving
 *     previously seen cookies and overwriting values on conflict
 *     (step68).
 *
 * Run:
 *   npx ts-node --project scripts/tsconfig.json scripts/probe-cookies-merge.ts
 */

import { AgentSession } from '../src/api';

let failures = 0;

function check(cond: boolean, label: string): void {
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${label}`);
  if (!cond) failures++;
}

// Real Headers.getSetCookie() returns an array of individual values,
// and Headers.get('set-cookie') returns them joined with ", ". The
// fake mirrors both, so probes exercise the same shape the extension
// sees against a live API.
function fakeHeaders(cookies: string[]): Headers {
  return {
    get: (name: string) =>
      name.toLowerCase() === 'set-cookie'
        ? (cookies.length > 0 ? cookies.join(', ') : null)
        : null,
    getSetCookie: () => cookies
  } as unknown as Headers;
}

function parts(h: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const kv of h.split('; ')) {
    const eq = kv.indexOf('=');
    if (eq > 0) m.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return m;
}

function t1_empty_initial(): void {
  console.log('\nT1: empty initial → stores parsed pairs');

  const s = new AgentSession('executor', 'p');
  s.absorbCookies(fakeHeaders([
    'a=1; Path=/',
    'b=2; HttpOnly'
  ]));

  const m = parts(s.cookieHeader);
  check(m.get('a') === '1', `a=1 stored (got ${m.get('a')})`);
  check(m.get('b') === '2', `b=2 stored (got ${m.get('b')})`);
  check(m.size === 2, `exactly two cookies (got ${m.size})`);
}

function t2_merge_preserves(): void {
  console.log('\nT2: merge preserves untouched keys');

  const s = new AgentSession('executor', 'p');
  s.cookieHeader = 'a=1; b=2';
  s.absorbCookies(fakeHeaders(['c=3']));

  const m = parts(s.cookieHeader);
  check(m.get('a') === '1', `a=1 preserved`);
  check(m.get('b') === '2', `b=2 preserved`);
  check(m.get('c') === '3', `c=3 added`);
  check(m.size === 3, `exactly three cookies (got ${m.size})`);
}

function t3_overwrite_by_name(): void {
  console.log('\nT3: same name overwrites value, no duplicates');

  const s = new AgentSession('executor', 'p');
  s.cookieHeader = 'a=1; b=2';
  s.absorbCookies(fakeHeaders(['b=20']));

  const m = parts(s.cookieHeader);
  check(m.get('b') === '20', `b updated to 20 (got ${m.get('b')})`);
  check(m.get('a') === '1', `a=1 preserved`);
  check(m.size === 2, `exactly two cookies (got ${m.size})`);

  const bCount = s.cookieHeader.split('; ')
    .filter(kv => kv.startsWith('b=')).length;
  check(bCount === 1, `single b= entry (got ${bCount})`);
}

function t4_empty_noop(): void {
  console.log('\nT4: empty getSetCookie → header unchanged');

  const s = new AgentSession('executor', 'p');
  s.cookieHeader = 'a=1';
  s.absorbCookies(fakeHeaders([]));
  check(s.cookieHeader === 'a=1',
    `unchanged (got ${s.cookieHeader})`);
}

function t5_three_headers(): void {
  console.log('\nT5: three consecutive responses accumulate');

  const s = new AgentSession('executor', 'p');
  s.absorbCookies(fakeHeaders(['a=1']));
  s.absorbCookies(fakeHeaders(['b=2']));
  s.absorbCookies(fakeHeaders(['c=3']));

  const m = parts(s.cookieHeader);
  check(m.get('a') === '1', 'a');
  check(m.get('b') === '2', 'b');
  check(m.get('c') === '3', 'c');
  check(m.size === 3, `exactly three (got ${m.size})`);
}

function t6_expires_comma_not_split(): void {
  console.log('\nT6: Expires=Thu, 01 Jan ... does not split the cookie');

  // The old regex split on commas NOT followed by a space, which
  // happened to be the wrong direction. getSetCookie() has no such
  // problem: each entry is a separate array element.
  const s = new AgentSession('executor', 'p');
  s.absorbCookies(fakeHeaders([
    'session=abc; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT; HttpOnly'
  ]));

  const m = parts(s.cookieHeader);
  check(m.get('session') === 'abc',
    `session=abc stored (got ${m.get('session')})`);
  check(m.size === 1, `exactly one cookie (got ${m.size})`);
}

function main(): void {
  t1_empty_initial();
  t2_merge_preserves();
  t3_overwrite_by_name();
  t4_empty_noop();
  t5_three_headers();
  t6_expires_comma_not_split();

  console.log();
  if (failures === 0) {
    console.log('=== SUCCESS: absorbCookies merge works ===');
    process.exit(0);
  } else {
    console.log(`=== FAILURE: ${failures} check(s) failed ===`);
    process.exit(1);
  }
}

main();
