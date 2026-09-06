import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CiCheck, PullRequest } from '../web/src/types.js';

(globalThis as { React?: typeof React }).React = React;

const { CiMark } = await import('../web/src/components/CiMark.js');

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
  assert.doesNotMatch(running, /ck-badge/, 'a running mark wears a count');
  assert.match(running, /aria-label="Checks: 1 of 2 checks still running"/);

  const stalled = draw(pr({ ciStatus: 'pending', ciChecks: [check('policy / build', 'pending', { expired: true })] }));
  assert.match(stalled, /class="ck t-amber"/);
  assert.match(stalled, /class="ck-badge">1</);
  assert.match(stalled, /aria-label="Checks: 1 check waiting on a run nobody has started"/);
});

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

test('an advisory check is in no count', () => {
  const html = draw(
    pr({ ciChecks: [check('build / test', 'passing'), check('comments', 'pending', { advisory: true })] }),
  );
  assert.match(html, /aria-label="Checks: All 1 checks passed"/);
});

test('the mark is a button only where it opens something', () => {
  const subject = pr({ ciChecks: [check('build / test', 'passing')] });
  assert.match(renderToStaticMarkup(createElement(CiMark, { pr: subject, onOpen: () => {} })), /^<button/);
  assert.match(draw(subject), /^<span/);
});
