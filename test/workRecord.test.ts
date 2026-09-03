import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkNode } from '../src/types.js';

// The classic JSX runtime the test compiler emits wants the global, and it has to
// be in before the console's modules load — `test/console.test.ts`' reason.
(globalThis as { React?: typeof React }).React = React;

const { RefLinks } = await import('../web/src/components/refs.js');
const { WorkRow } = await import('../web/src/components/workTree.js');

/**
 * The durable record, drawn. Two surfaces read one component now — the work tab's
 * expanded root and the goal page's own record — so what a row *says* is asserted
 * here once rather than in whichever panel changed last.
 */
function node(over: Partial<WorkNode> & { ref: string }): WorkNode {
  return {
    kind: 'pr',
    parentRef: null,
    baseRef: null,
    title: 'Add path counters',
    status: 'merged',
    terminal: true,
    provenance: 'observed',
    firstSeenAt: '2026-07-14T09:00:00.000Z',
    lastSeenAt: '2026-07-14T09:00:00.000Z',
    ...over,
  };
}

/**
 * Rendered the way the shell mounts it, with the *route's* URLs standing in for
 * the snapshot's — which is the whole point of the surface: the shell's map is
 * assembled from the world, and the graph's job is remembering what left it.
 */
function draw(nodes: WorkNode[], refUrls: Record<string, string> = {}): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls,
      openGoal: () => undefined,
      hasGoal: () => false,
      openPr: () => undefined,
      hasPr: () => false,
      children: nodes.map((n) => createElement(WorkRow, { key: n.ref, node: n, nodes, now: Date.parse(n.lastSeenAt) })),
    }),
  );
}

test('a row draws its ref as a link, never as bare text', () => {
  // The cockpit's most repeated bug: a row that names a pull request and offers no
  // way there reads correctly and is a dead end.
  const html = draw([node({ ref: 'pr:31688' })], { 'pr:31688': 'https://example.test/pr/31688' });
  assert.match(html, /href="https:\/\/example\.test\/pr\/31688"/, 'the record must link what it names');
  assert.match(html, /rel="noopener noreferrer"/);
});

test('a merge the harness only inferred says so; one it watched does not', () => {
  assert.match(draw([node({ ref: 'pr:31902', provenance: 'inferred' })]), /inferred/);
  assert.doesNotMatch(
    draw([node({ ref: 'pr:31688', provenance: 'observed' })]),
    /inferred/,
    'a watched merge claimed as inferred understates what the record holds',
  );
});

/**
 * How the goal page's record is drawn: `GET /api/work/:ref` returns the root with
 * its subtree, and the record filters the root out — it is the page the reader is
 * already standing on. Every child is then orphaned, and `depth`'s missing-parent
 * arm is what has to land them flush left rather than dropping them.
 */
test('a node whose parent is outside the set sits flush left rather than vanishing', () => {
  const orphan = node({ ref: 'pr:31688', parentRef: 'issue:35174' });
  const html = draw([orphan]);
  assert.match(html, /Add path counters/, 'a child of the filtered-out root must still be drawn');
  assert.match(html, /margin-left:\s*0px/, 'with nothing above it in the set, it is at depth 0');
});

test('depth is walked within the set, so a nested subtree still indents', () => {
  const html = draw([
    node({ ref: 'issue:35174:part:api', kind: 'part' }),
    node({ ref: 'pr:31688', parentRef: 'issue:35174:part:api' }),
  ]);
  assert.match(html, /margin-left:\s*14px/, 'the PR sits under the part that produced it');
});

/**
 * The defect the demo surfaced: `refLabel` shortens a whole family to its number,
 * so every sub-origin under `issue:395` read `#395` — four rows on one goal's
 * record, each a link back to the page the reader was already standing on.
 */
test('a sub-origin draws no ref — the number it would show belongs to its ancestor', () => {
  const urls = { 'issue:395': 'https://example.test/i/395', 'issue:395:part:api': 'https://example.test/i/395' };
  const plan = draw([node({ ref: 'issue:395:plan', kind: 'plan', title: 'The plan', status: 'active' })], urls);
  assert.doesNotMatch(plan, /#395/, 'a plan is not the goal, and saying so is a dead-end link');
  assert.match(plan, /The plan/, 'the row is still drawn — its identity is its title and its indent');

  const part = draw([node({ ref: 'issue:395:part:api', kind: 'part', title: 'Add the signer' })], urls);
  assert.doesNotMatch(part, /#395/);
});

test('a goal and a pull request do name themselves, and keep their refs', () => {
  const html = draw([node({ ref: 'pr:412' }), node({ ref: 'issue:395', kind: 'issue', title: 'Snapshot 401s' })], {
    'pr:412': 'https://example.test/pr/412',
  });
  assert.match(html, /href="https:\/\/example\.test\/pr\/412"/, 'a PR is the one thing this row is');
  assert.match(html, /#395/, 'and a goal names itself too — it is only its sub-origins that do not');
});
