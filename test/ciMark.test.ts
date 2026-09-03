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
 * The chip says what the harness decided, and every arm below is a rendering of
 * `ciVerdict` and `ciChecks` — the server's own classification off the same
 * `config.ci` rules the dispatcher reads. What is asserted here is that the chip
 * **quotes** it: a red check the policy muted must not read as work waiting on
 * anybody, and a pull request whose provider reported nothing must not grow a chip
 * claiming it reported something.
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

test('the chip names itself and counts the checks that passed', () => {
  const html = draw(pr({ ciChecks: [check('build / test', 'passing'), check('build / lint', 'passing')] }));
  assert.match(html, /class="ck t-green"/, 'a green pull request is not drawn green');
  assert.match(html, />CI</, 'the chip does not say what reading it is');
  assert.match(html, />2\/2</, 'the chip does not say how many checks it folded');
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
  assert.match(html, />1 failed</);
  assert.match(html, /aria-label="Checks: 1 of 2 checks failed"/);
});

/**
 * The two arms that must not read as the fleet's work. `escalate` is the policy
 * saying the harness must **not** touch this one, and `ignored` is the operator
 * saying nobody should — drawn in words rather than in hue alone, because a reader
 * who cannot separate red from amber would otherwise get "1 failed" for both and
 * two different obligations.
 */
test('a check the policy hands to the operator says so in words', () => {
  const html = draw(
    pr({
      ciStatus: 'failing',
      ciChecks: [check('deploy / staging', 'failing')],
      ciVerdict: verdict({ escalate: [{ name: 'deploy / staging', rule: null }] }),
    }),
  );
  assert.match(html, /class="ck t-amber"/);
  assert.match(html, />1 for you</);
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
  assert.match(html, />1 muted</);
});

test('checks still running are counted, and a stalled one is told apart from them', () => {
  const running = draw(
    pr({ ciStatus: 'pending', ciChecks: [check('build / test', 'pending'), check('build / lint', 'passing')] }),
  );
  assert.match(running, /class="ck t-blue"/);
  assert.match(running, />1 running</);

  // Pending with nothing in flight: the run is stale against the branch and
  // resolves only when somebody queues another — a different thing to wait for,
  // and the reading the dots could never carry.
  const stalled = draw(pr({ ciStatus: 'pending', ciChecks: [check('policy / build', 'pending', { expired: true })] }));
  assert.match(stalled, /class="ck t-amber"/);
  assert.match(stalled, />1 stalled</);
});

/**
 * Missing detail is not a clean bill of health — the aggregate speaks under its
 * own name rather than drawing nothing, which is the one thing `CiLadder` got
 * right that a chip could easily lose.
 */
test('the aggregate speaks where the provider named no check', () => {
  assert.match(draw(pr({ ciStatus: 'failing' })), />red</);
  assert.match(draw(pr({ ciStatus: 'passing' })), />green</);
});

test('a pull request nobody reported a check for draws nothing', () => {
  assert.equal(draw(pr({ ciStatus: 'unknown' })), '', 'an unreported pull request grew a chip');
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
  assert.match(html, />1\/1</);
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
