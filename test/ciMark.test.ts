import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CiCheck, PullRequest } from '../web/src/types.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the component is loaded after this so it sees the same
// global the rest of the cockpit tests install.
(globalThis as { React?: typeof React }).React = React;

const { CiMark } = await import('../web/src/components/CiMark.js');

/**
 * The checks mark's fold, which is the whole of it.
 *
 * The mark says what the harness decided, and every arm below is a rendering of
 * `ciVerdict` and `ciChecks` — the server's own classification off the same
 * `config.ci` rules the dispatcher reads. What is asserted here is that the mark
 * **quotes** it: a red check the policy muted must not read as work waiting on
 * anybody, and a pull request whose provider reported nothing must not grow a mark
 * claiming it reported something.
 *
 * **The reading is a tone, a count and a sentence**, since the mark stopped being
 * a chip of words. So each arm is pinned on all three where it has them: the `t-*`
 * tone, the badge where a number is the reading, and the `aria-label` — which is
 * the accessible name *and* the tooltip's heading, and is now the only place the
 * distinction between two arms of one hue is written down.
 * → `docs/spec/17-cockpit.md#the-checks-mark`
 */

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr-1',
    number: 412,
    title: 'Reap the process subtree before signalling the child',
    branch: 'fix/reap',
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

function check(name: string, status: CiCheck['status'], over: Partial<CiCheck> = {}): CiCheck {
  return { name, status, ...over };
}

function verdict(over: Partial<NonNullable<PullRequest['ciVerdict']>> = {}): PullRequest['ciVerdict'] {
  return { actionable: false, dispatch: [], escalate: [], ignored: [], urgent: false, ...over };
}

const draw = (subject: PullRequest): string => renderToStaticMarkup(createElement(CiMark, { pr: subject }));

test('a green pull request is green, and wears no count', () => {
  const html = draw(pr({ ciChecks: [check('build / test', 'passing'), check('build / lint', 'passing')] }));
  assert.match(html, /class="ck t-green"/, 'a green pull request is not drawn green');
  // No badge: the count on the shoulder is *how much trouble*, so a number on a
  // green mark would be a figure an eye stops at for nothing. The tone is the
  // whole reading, and how many passed is in the name.
  assert.doesNotMatch(html, /ck-badge/, 'a clean pull request wears a count');
  assert.match(html, /aria-label="Checks: All 2 checks passed"/);
});

test('a failing check the fleet will fix reads red, and says how many', () => {
  const html = draw(
    pr({
      ciStatus: 'failing',
      ciChecks: [check('build / typecheck', 'failing'), check('build / test', 'passing')],
      ciVerdict: verdict({ actionable: true, dispatch: [{ name: 'build / typecheck', rule: null }] }),
    }),
  );
  assert.match(html, /class="ck t-red"/);
  assert.match(html, /class="ck-badge">1</);
  assert.match(html, /aria-label="Checks: 1 of 2 checks failed"/);
});

/**
 * The two arms that must not read as the fleet's work. `escalate` is the policy
 * saying the harness must **not** touch this one, and `ignored` is the operator
 * saying nobody should. Neither is red, and the sentence says which it is: the
 * mark's words went when it became a mark, so the `aria-label` is what a reader
 * who cannot separate the hues has, and it is not optional.
 */
test('a check the policy hands to the operator is not the fleet’s red', () => {
  const html = draw(
    pr({
      ciStatus: 'failing',
      ciChecks: [check('deploy / staging', 'failing')],
      ciVerdict: verdict({ escalate: [{ name: 'deploy / staging', rule: null }] }),
    }),
  );
  assert.match(html, /class="ck t-amber"/);
  assert.match(html, /class="ck-badge">1</);
  assert.match(html, /aria-label="Checks: 1 of 1 check failed, for you to fix"/);
});

test('a failure the operator muted is drawn as no verdict at all', () => {
  const html = draw(
    pr({
      ciStatus: 'failing',
      ciChecks: [check('codeql', 'failing')],
      ciVerdict: verdict({ ignored: [{ name: 'codeql', rule: null }] }),
    }),
  );
  assert.match(html, /class="ck t-grey"/, 'a muted failure is drawn as somebody’s move');
  assert.match(html, /class="ck-badge">1</);
  assert.match(html, /aria-label="Checks: 1 of 1 check failed, and muted by the CI policy"/);
});

test('checks still running are counted, and a stalled one is told apart from them', () => {
  const running = draw(
    pr({ ciStatus: 'pending', ciChecks: [check('build / test', 'pending'), check('build / lint', 'passing')] }),
  );
  assert.match(running, /class="ck t-blue"/);
  // Blue is the whole reading: a count of what is *in flight* is not trouble, and
  // a number on it would read as one.
  assert.doesNotMatch(running, /ck-badge/, 'a running mark wears a count');
  assert.match(running, /aria-label="Checks: 1 of 2 checks still running"/);

  // Pending with nothing in flight: the run is stale against the branch and
  // resolves only when somebody queues another — a different thing to wait for,
  // and the reading the dots could never carry.
  const stalled = draw(pr({ ciStatus: 'pending', ciChecks: [check('policy / build', 'pending', { expired: true })] }));
  assert.match(stalled, /class="ck t-amber"/);
  assert.match(stalled, /class="ck-badge">1</);
  assert.match(stalled, /aria-label="Checks: 1 check waiting on a run nobody has started"/);
});

/**
 * The one distinction the mark spends, pinned where it now lives.
 *
 * `1 for you` and `1 stalled` were two words and are one shape: amber, with a `1`
 * on the shoulder. Both are the same call — nothing will happen to this on its own
 * — so the hue is not lying, but *which* of the two it is exists only in the
 * accessible name and the tooltip it heads. That makes the name load-bearing in a
 * way it was not while the mark carried words, and a change that drops or blurs it
 * takes the distinction off the product altogether.
 */
test('amber’s two arms are told apart in the name, since the mark no longer says it', () => {
  const yours = draw(
    pr({
      ciStatus: 'failing',
      ciChecks: [check('deploy / staging', 'failing')],
      ciVerdict: verdict({ escalate: [{ name: 'deploy / staging', rule: null }] }),
    }),
  );
  const stalled = draw(pr({ ciStatus: 'pending', ciChecks: [check('policy / build', 'pending', { expired: true })] }));
  const name = (html: string): string => /aria-label="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.match(yours, /class="ck t-amber"/);
  assert.match(stalled, /class="ck t-amber"/);
  assert.notEqual(name(yours), name(stalled), 'the two amber arms read identically to a screen reader');
});

/**
 * Missing detail is not a clean bill of health — the aggregate speaks under its
 * own name rather than drawing nothing, which is the one thing `CiLadder` got
 * right that a chip could easily lose.
 */
test('the aggregate speaks where the provider named no check', () => {
  const red = draw(pr({ ciStatus: 'failing' }));
  assert.match(red, /class="ck t-red"/);
  assert.match(red, /aria-label="Checks: A check failed, and the provider named none of them"/);
  const green = draw(pr({ ciStatus: 'passing' }));
  assert.match(green, /class="ck t-green"/);
  assert.match(green, /aria-label="Checks: The checks passed"/);
});

test('a pull request nobody reported a check for draws nothing', () => {
  assert.equal(draw(pr({ ciStatus: 'unknown' })), '', 'an unreported pull request grew a mark');
});

/**
 * Advisory checks are reported for visibility and nothing counts them — not
 * `ciNeedsAttention`, not the policy, and so not the chip either. Counted here,
 * a comment policy would put a pull request's checks at `3/4` forever.
 */
test('an advisory check is in no count', () => {
  const html = draw(
    pr({ ciChecks: [check('build / test', 'passing'), check('comments', 'pending', { advisory: true })] }),
  );
  // `All 1 checks passed`, not `All 2`: the total the name quotes is the counted
  // list, and the advisory one is not on it. Read off the name because that is
  // where the mark's numbers live now — a count on the glass only appears where
  // something is wrong.
  assert.match(html, /aria-label="Checks: All 1 checks passed"/);
});

/**
 * The mark is a control where there is somewhere to go and a plain span where
 * there is not — never a span with a click handler, which no keyboard reaches.
 */
test('the mark is a button only where it opens something', () => {
  const subject = pr({ ciChecks: [check('build / test', 'passing')] });
  assert.match(renderToStaticMarkup(createElement(CiMark, { pr: subject, onOpen: () => {} })), /^<button/);
  assert.match(draw(subject), /^<span/);
});
