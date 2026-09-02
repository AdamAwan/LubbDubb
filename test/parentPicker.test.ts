import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildSystem, type System } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { candidateParents, relatedWorkNote, DEFAULT_CONTAINER_TYPES } from '../src/issueRelations.js';
import type { Issue, IssueRelative, WorldSnapshot } from '../src/types.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { AppState, Issue as WebIssue } from '../web/src/types.js';

/**
 * The answer under the missing-parent warning: which containers an operator is
 * actually offered (issue #683).
 *
 * The failure this exists to stop is the one that was reported. The *question*
 * appears — `placementAsks` reads it off the live item, and `orphanGoal` off the
 * item again — and the three answers under it come from `ParentPicker`. Two of
 * them always draw. The one that resolves the warning is the list, and the list
 * used to be `world.issues` filtered by container type, which is the half of
 * `candidateParents` that is almost always empty: an Azure item list is narrowed
 * by tag and assignee, so an open Feature is usually visible only as some *other*
 * item's parent. So the deployments that raise the warning were the deployments
 * with nothing under it, and nothing was red.
 *
 * The tests are therefore pointed at the seam that was wrong rather than at the
 * warning: a world whose containers exist only as parents, and the select that has
 * to be drawn from it.
 */

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the console's modules load so the test exercises the same sources.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ParentPicker } = await import('../web/src/components/ParentPicker.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

const FEATURE: IssueRelative = {
  number: 300,
  title: 'Statement reconciliation',
  issueType: 'Feature',
  workItemState: 'Active',
  state: 'open',
};

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: `i${over.number ?? 12}`,
    number: 12,
    title: 'Reconcile the statement totals',
    body: 'The totals drift by a penny.',
    labels: [],
    state: 'open',
    issueType: 'User Story',
    linkedPrNumber: null,
    ...over,
  };
}

// -- the list itself --------------------------------------------------------

/**
 * The regression, at the level it happened: a world with no container-typed item
 * in it still has containers, and they are the ones an operator needs.
 */
test('the candidate list is the containers a narrowed world can see, not just the ones in it', () => {
  const world = [issue({ number: 12, parent: null }), issue({ number: 13, parent: FEATURE })];

  assert.deepEqual(
    candidateParents(world, DEFAULT_CONTAINER_TYPES).map((c) => c.number),
    [300],
    'the Feature is in nobody’s item list — it is only #13’s parent, which is where most of them are',
  );
  assert.deepEqual(
    world.filter((i) => i.issueType === 'Feature'),
    [],
    'and the filter the picker used to run finds nothing at all here',
  );
});

/**
 * The cap is the prompt's, and it moved so the picker would stop inheriting it. A
 * truncated select is the same dead end as an absent one: the container an operator
 * wants is either offered or unreachable, and "the thirteenth by id" is not a rule
 * anybody can learn from a box it is missing from.
 */
test('the whole list reaches the cockpit; only the prompt is capped', () => {
  const world = Array.from({ length: 20 }, (_, i) =>
    issue({ number: 500 + i, parent: { ...FEATURE, number: 100 + i, title: `Feature ${100 + i}` } }),
  );
  const candidates = candidateParents(world, DEFAULT_CONTAINER_TYPES);
  assert.equal(candidates.length, 20, 'the cockpit is offered every container the world can see');

  const note = relatedWorkNote(issue({ parent: null }), DEFAULT_CONTAINER_TYPES, candidates);
  const offered = note.match(/^- Feature #/gm) ?? [];
  assert.equal(offered.length, 12, 'the prompt still pays for twelve lines and no more');
});

// -- what the snapshot ships ------------------------------------------------

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-parent-picker-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

test('the snapshot carries the candidate containers, derived once for the whole world', () => {
  const system = build();
  try {
    system.store.setWorldBaseline({
      takenAt: '2026-08-01T00:00:00.000Z',
      pullRequests: [],
      closedPullRequests: [],
      issues: [issue({ number: 12, parent: null }), issue({ number: 13, parent: FEATURE })],
    } as unknown as WorldSnapshot);

    const snapshot = buildStateSnapshot(system);
    assert.deepEqual(
      snapshot.world.parentCandidates.map((c) => c.number),
      [300],
      'the browser cannot derive this half, so the server ships it',
    );
  } finally {
    system.store.close();
  }
});

// -- what the picker draws --------------------------------------------------

/**
 * `renderToStaticMarkup` escapes text nodes, so an assertion on prose decodes first.
 */
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function pickerHtml(candidates: IssueRelative[], goalNumber = 12): string {
  const state = buildDemoState().state as AppState;
  state.world.parentCandidates = candidates;
  const view = { state, now: Date.now() } as unknown as CockpitView;
  const goal = { ...issue({ number: goalNumber, parent: null }) } as unknown as WebIssue;
  return decode(renderToStaticMarkup(createElement(ParentPicker, { issue: goal, proposed: null, view, actions })));
}

test('the picker offers every candidate the world carries', () => {
  const html = pickerHtml([FEATURE, { ...FEATURE, number: 301, title: 'Ledger exports' }]);
  assert.match(html, /<select/, 'the list is the answer that resolves the warning — it has to be drawn');
  assert.match(html, /#300 — Statement reconciliation/);
  assert.match(html, /#301 — Ledger exports/);
  assert.match(html, /Choose a Feature/, 'with no proposal to compare against, the list is the whole offer');
});

/**
 * A goal cannot be its own container, and it is in the list whenever anything
 * already hangs off it — a Feature the operator is looking at the page of.
 */
test('the goal is never offered as its own parent', () => {
  const html = pickerHtml([FEATURE], 300);
  assert.doesNotMatch(html, /<select/, 'the only candidate was the goal itself, so there is nothing to pick');
  assert.match(html, /Not applicable/, 'and the answer that changes nothing out there still stands');
});

test('an empty list draws no select rather than an empty one', () => {
  const html = pickerHtml([]);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /Not applicable/);
});
