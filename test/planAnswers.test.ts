import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanCaveat } from '../web/src/types.js';

// The classic runtime, as `console.test.ts` sets it up and for its reason.
(globalThis as { React?: typeof React }).React = React;

const { PlanAnswers } = await import('../web/src/components/PlanAnswers.js');

const PLAN_MODAL = readFileSync(new URL('../web/src/components/PlanModal.tsx', import.meta.url), 'utf8');
const ESCALATION = readFileSync(new URL('../web/src/components/EscalationCard.tsx', import.meta.url), 'utf8');

/**
 * The four answers to a plan, and the two ways the six that preceded them went
 * quietly wrong.
 *
 * The first is the note. It was one box serving five verdicts with the caption
 * `Why (optional) — recorded either way`, and on the two that matter that caption
 * is false: a rejection's note is the *whole* instruction the next planner gets
 * (`refusedPlanReason`, `src/plans/planApproval.ts`), and a close's is posted on
 * somebody's tracker as the reason it shut. An empty refusal is the failure worth
 * a test — the route accepts it, and what reaches the planner is "a human said no"
 * against the plan it just wrote, which re-runs the question that produced it.
 *
 * The second is that two of the six were one act. `Reject` and `Replan` both ask a
 * planner again, and nothing on the row said which was which.
 *
 * → docs/spec/08-planning.md#the-four-answers, docs/spec/17-cockpit.md
 */

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
  // The two that are not about the plan, in their own row under their own
  // question. A rejection asks a planner for a different plan, which is the wrong
  // "no" for a goal that should not be worked at all.
  const backout = /<div class="pa-backout">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  assert.ok(backout.includes('Not the work you want?'), 'the ticket answers are not captioned');
  assert.ok(backout.includes('Close the ticket'), 'no way to close the ticket');
  assert.ok(backout.includes('Just stop watching'), 'no way to stop watching');
});

test('nothing asks for words until an answer that needs them is chosen', () => {
  // The old row carried a note box at rest, beside five verdicts that each meant
  // something different by it. At rest there is now nothing to type into.
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
  // `ProposalDesk.accept` stores a note on the proposal row and `releasePlan` takes
  // no note at all, so a box beside Approve promised a tweak the release cannot
  // apply. The accept sends the ticked caveats and nothing else.
  const accept = /onDecide\(proposalId, 'accept'[^)]*\)/.exec(
    readFileSync(new URL('../web/src/components/PlanAnswers.tsx', import.meta.url), 'utf8'),
  )?.[0];
  assert.equal(accept, "onDecide(proposalId, 'accept', undefined, acknowledged)");
});

test('the Claude Code hand-off is dropped where no goal number resolves the plan', () => {
  // `plan_amend` resolves a plan *by* that number, so a control opened without one
  // would land a session on a plan it cannot find.
  assert.ok(!answers({ issueNumber: null }).includes('Open in Claude Code'));
});

/**
 * The change arm's whole content is the operator's words, so the guard is that it
 * cannot be fired without them. Asserted on the source rather than by rendering a
 * drawer: the disabled state is what a click produces, and the source is where the
 * rule that produces it is either present or gone.
 */
test('the drawers are held until there are words, and each says where they go', () => {
  const source = readFileSync(new URL('../web/src/components/PlanAnswers.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('disabled={words.length === 0}'), 'a drawer can be submitted empty');
  // Both arms say what happens to what is typed — the caption the one shared box
  // could never carry, because it served five verdicts that disagreed about it.
  assert.match(source, /placeholder: 'The planner gets these words and amends the plan'/);
  assert.match(source, /placeholder: 'Posted on the ticket as the closing comment'/);
});

test('Replan is never drawn beside a verdict', () => {
  // On a decidable plan it is "Change something first" with an empty note: the
  // same route, the same outcome, and the one an operator reaches for when they
  // have nothing to say. It survives only where no verdict is on offer, which is
  // the surface's `!decidable` arm.
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
