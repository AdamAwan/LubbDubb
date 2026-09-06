import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanCaveat } from '../web/src/types.js';

(globalThis as { React?: typeof React }).React = React;

const { PlanAnswers } = await import('../web/src/components/PlanAnswers.js');

const PLAN_MODAL = readFileSync(new URL('../web/src/components/PlanModal.tsx', import.meta.url), 'utf8');
const ESCALATION = readFileSync(new URL('../web/src/components/EscalationCard.tsx', import.meta.url), 'utf8');

const CAVEAT: PlanCaveat = { id: 'risks', label: 'Risks the planner named', detail: 'It touches the hold.' };

const answers = (over: Partial<Parameters<typeof PlanAnswers>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(PlanAnswers, {
      proposalId: 'prop-1',
      issueNumber: 781,
      approveLabel: 'Approve — start 2 agents now',
      outstanding: [],
      acknowledged: [],
      desktopFolder: '/home/you/shop',
      discussExplain: 'so the plan is talked through.',
      onDecide: () => undefined,
      onBackOut: () => undefined,
      ...over,
    }),
  );

test('a plan is answered four ways, and the two about the ticket are set apart', () => {
  const html = answers();
  for (const label of ['Approve — start 2 agents now', 'Change something first', 'Open in Claude Code']) {
    assert.ok(html.includes(label), `no "${label}" among the answers`);
  }
  const backout = /<div class="pa-backout">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  assert.ok(backout.includes('Not the work you want?'), 'the ticket answers are not captioned');
  assert.ok(backout.includes('Close the ticket'), 'no way to close the ticket');
  assert.ok(backout.includes('Just stop watching'), 'no way to stop watching');
});

test('nothing asks for words until an answer that needs them is chosen', () => {
  assert.ok(!answers().includes('pa-drawer'), 'a drawer is open before anything was clicked');
  assert.ok(!answers().includes('<input'), 'the answers ask for words before an answer was picked');
});

test('Approve is held while a caveat is unticked, and says how many', () => {
  const html = answers({ outstanding: [CAVEAT] });
  const approve = /<button[^>]*>Approve — start 2 agents now<\/button>/.exec(html)?.[0] ?? '';
  assert.ok(approve.includes('disabled'), 'Approve is offered with a caveat outstanding');
  assert.ok(approve.includes('One box left to tick'), 'the button does not say what is holding it');
});

test('Approve carries no note, because releasePlan takes none', () => {
  const accept = /onDecide\(proposalId, 'accept'[^)]*\)/.exec(
    readFileSync(new URL('../web/src/components/PlanAnswers.tsx', import.meta.url), 'utf8'),
  )?.[0];
  assert.equal(accept, "onDecide(proposalId, 'accept', undefined, acknowledged)");
});

test('the Claude Code hand-off is dropped where no goal number resolves the plan', () => {
  assert.ok(!answers({ issueNumber: null }).includes('Open in Claude Code'));
});

test('the drawers are held until there are words, and each says where they go', () => {
  const source = readFileSync(new URL('../web/src/components/PlanAnswers.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('disabled={words.length === 0}'), 'a drawer can be submitted empty');
  assert.match(source, /placeholder: 'The planner gets these words and amends the plan'/);
  assert.match(source, /placeholder: 'Posted on the ticket as the closing comment'/);
});

test('Replan is never drawn beside a verdict', () => {
  const foot = PLAN_MODAL.slice(PLAN_MODAL.indexOf('<div className="pm-foot">'));
  const replan = foot.indexOf('Replan');
  assert.ok(replan > 0, 'Replan left the sheet entirely');
  const arm = foot.lastIndexOf('{!decidable && (', replan);
  assert.ok(arm > 0 && arm < replan, 'Replan is drawn on a plan that is still awaiting a verdict');
});

test('both surfaces draw the one component, rather than a row each', () => {
  for (const [name, source] of [
    ['the plan sheet', PLAN_MODAL],
    ['the inbox card', ESCALATION],
  ] as const) {
    assert.ok(source.includes('<PlanAnswers'), `${name} hand-rolls its own answers`);
  }
});
