import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const { CheckSetAsk } = await import('../web/src/components/CheckSetAsk.js');
const { authoringBriefing } = await import('../src/validation/authoring.js');

// → docs/spec/20-validation.md#how-the-note-and-the-expect-are-written

const BULLETS = '**The numbers**\n\n- **41 of 74** rows are allocated.\n- The log reads `41/74 rows`.';

const set = {
  note: BULLETS,
  hint: null,
  checks: [
    {
      letter: 'A',
      title: 'The doc 609 journey',
      expect: BULLETS,
      steps: [],
      fleetCandidate: false,
      candidateWhy: null,
      fleetBlocked: false,
      carriesQuery: false,
    },
  ],
};

const html = (): string => renderToStaticMarkup(createElement(CheckSetAsk, { set }));

test('the planner’s note and a check’s expect draw as markdown, not as their markers', () => {
  const out = html();
  // Both fields, so neither half of the pair can go back to a raw string on its own.
  assert.equal(out.match(/<ul>/g)?.length, 2);
  assert.equal(out.match(/<li>/g)?.length, 4);
  assert.equal(out.match(/<strong>The numbers<\/strong>/g)?.length, 2);
  assert.equal(out.match(/<code>41\/74 rows<\/code>/g)?.length, 2);
  assert.doesNotMatch(out, /\*\*/);
  assert.doesNotMatch(out, /- \*\*41/);
});

test('the planner is asked for grouped bullets, on both of the fields that stay its own words', () => {
  const briefing = authoringBriefing({ hint: null, parts: [], environments: '' });
  assert.match(briefing, /grouped bullets/);
  assert.match(briefing, /`expect`/);
  assert.match(briefing, /`note`/);
});
