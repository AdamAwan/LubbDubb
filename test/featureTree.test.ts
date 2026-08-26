import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildFeatureTree, type FeatureTreeInput } from '../src/features/featureTree.js';
import type { MirroredTicket } from '../src/store/tickets.js';
import type { Issue, IssueRelative } from '../src/types.js';
import type { FeatureNode, FeaturesPayload } from '../src/wire.js';

/**
 * The Features page's arithmetic.
 *
 * Every assertion here is about a number a reader would act on — how much of a
 * feature is finished, and how much of it this harness cannot see — and each is a
 * thing no render can show: a bar folded from the wrong buckets draws exactly like
 * one folded from the right ones. → docs/spec/17-cockpit.md#the-features-page
 */

function mirrored(over: Partial<MirroredTicket> & Pick<MirroredTicket, 'number'>): MirroredTicket {
  return {
    title: `Item ${over.number}`,
    labels: [],
    state: 'open',
    workItemState: null,
    url: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    changedAt: '2026-08-01T00:00:00.000Z',
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    tracking: 'live',
    issueType: 'User Story',
    lastReadAt: null,
    ...over,
  };
}

function relative(over: Partial<IssueRelative> & Pick<IssueRelative, 'number'>): IssueRelative {
  return { title: `Item ${over.number}`, issueType: 'User Story', workItemState: '', state: 'open', ...over };
}

function issue(over: Partial<Issue> & Pick<Issue, 'number'>): Issue {
  return {
    id: `${over.number}`,
    title: `Item ${over.number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function tree(over: Partial<FeatureTreeInput> = {}) {
  return buildFeatureTree({
    items: [],
    issues: [],
    costs: new Map(),
    outcomes: new Map(),
    featureSlots: new Map(),
    watchLabel: 'lubbdubb-watch',
    containerTypes: ['Feature', 'Epic'],
    ...over,
  });
}

/** One node by number, anywhere in the tree — the assertions read by id, not by position. */
function find(nodes: readonly FeatureNode[], number: number): FeatureNode | null {
  for (const node of nodes) {
    if (node.number === number) return node;
    const deeper = find(node.children, number);
    if (deeper !== null) return deeper;
  }
  return null;
}

test('a flat tracker reports no hierarchy, which is what hides the page', () => {
  // Every GitHub issue: no `parent` key at all, because nothing resolved a link.
  const flat = tree({ items: [mirrored({ number: 1 }), mirrored({ number: 2 })] });
  assert.equal(flat.tracked, false, 'an absent parent link is not a resolved absence');
  assert.deepEqual(flat.roots, []);
  assert.deepEqual(flat.orphans, [], 'nothing is an orphan on a tracker with no parents to be missing');
});

test('a resolved absence is an orphan, and an unreadable link is neither', () => {
  const built = tree({
    items: [
      mirrored({ number: 1, parent: null }),
      // The provider named a parent it could not read: `undefined`, and the item is
      // not reported under a heading it cannot draw *or* as having no feature.
      mirrored({ number: 2 }),
    ],
  });
  assert.equal(built.tracked, true);
  assert.deepEqual(
    built.orphans.map((o) => o.number),
    [1],
  );
});

test('a feature rolls its children up and never counts itself', () => {
  const built = tree({
    items: [
      mirrored({ number: 10, issueType: 'Feature' }),
      mirrored({ number: 11, state: 'closed', parent: { number: 10, title: 'Payments' } }),
      mirrored({ number: 12, labels: ['lubbdubb-watch'], parent: { number: 10, title: 'Payments' } }),
      mirrored({ number: 13, parent: { number: 10, title: 'Payments' } }),
    ],
    costs: new Map([[13, 4.5]]),
  });

  const feature = find(built.roots, 10);
  assert.ok(feature !== null);
  assert.equal(feature.container, true, 'a Feature is a heading, never a row');
  assert.deepEqual(feature.progress, {
    done: 1,
    working: 1,
    queued: 1,
    waiting: 0,
    outside: 0,
    // Three children and not four: a container is a statement of intent its
    // children deliver, so counting it beside them would inflate every feature by
    // an item nobody can work.
    total: 3,
    costUsd: 4.5,
  });
});

test('a child the assignment filter never returned is counted, and counted as outside', () => {
  const built = tree({
    items: [mirrored({ number: 21, parent: { number: 20, title: 'Payments' } })],
    issues: [
      issue({
        number: 20,
        issueType: 'Feature',
        parent: null,
        // The container's own membership: two of these are not ours.
        children: [relative({ number: 21 }), relative({ number: 22 }), relative({ number: 23, state: 'closed' })],
      }),
    ],
  });

  const feature = find(built.roots, 20);
  assert.ok(feature !== null);
  assert.equal(feature.progress.total, 3, 'the feature is three items wide, whoever is assigned them');
  assert.equal(feature.progress.outside, 1, 'the open one nobody here owns');
  assert.equal(feature.progress.done, 1, 'a closed item is done whether or not we could see it being worked');
  assert.equal(find(built.roots, 22)?.known, 'relation');
  assert.equal(find(built.roots, 22)?.watch, null, 'nothing told us its labels, and `unwatched` would be a claim');
});

test('an epic rolls up its features without double-counting them', () => {
  const built = tree({
    items: [
      mirrored({ number: 31, state: 'closed', parent: { number: 30, title: 'Payments' } }),
      mirrored({ number: 32, parent: { number: 30, title: 'Payments' } }),
      mirrored({ number: 33, parent: { number: 40, title: 'Onboarding' } }),
    ],
    issues: [
      issue({ number: 30, issueType: 'Feature', parent: relative({ number: 50, issueType: 'Epic' }) }),
      issue({ number: 40, issueType: 'Feature', parent: relative({ number: 50, issueType: 'Epic' }) }),
      issue({ number: 50, issueType: 'Epic', parent: null }),
    ],
  });

  assert.deepEqual(
    built.roots.map((r) => r.number),
    [50],
    'the epic is the only thing with nowhere above it',
  );
  const epic = built.roots[0];
  assert.ok(epic !== undefined);
  assert.equal(epic.progress.total, 3, 'three stories, not three stories plus two features');
  assert.equal(epic.progress.done, 1);
  assert.equal(find(built.roots, 30)?.depth, 1, 'a feature under an epic is drawn one level in');
});

test('the tracker’s own word outranks every reading the harness has', () => {
  // Closed while an agent was on it: finished work, not work in flight.
  const built = tree({
    items: [
      mirrored({ number: 61, state: 'closed', labels: ['lubbdubb-watch'], parent: { number: 60, title: 'F' } }),
      mirrored({ number: 62, parent: { number: 60, title: 'F' } }),
    ],
    costs: new Map([[61, 12]]),
    outcomes: new Map([[61, 'delivered']]),
  });
  const feature = find(built.roots, 60);
  assert.equal(feature?.progress.done, 1);
  assert.equal(feature?.progress.working, 0);
  assert.equal(feature?.progress.costUsd, 12, 'the money still rolls up — it was spent either way');
});

test('a cycle in the tracker’s links is drawn once rather than for ever', () => {
  const built = tree({
    items: [
      mirrored({ number: 70, issueType: 'Feature', parent: { number: 71, title: 'B' } }),
      mirrored({ number: 71, issueType: 'Feature', parent: { number: 70, title: 'A' } }),
    ],
  });
  // Neither is a root by the parent test, so the tree is empty rather than
  // infinite: a cycle is a tracker fault, and inventing a top for it would be this
  // page having an opinion of its own.
  assert.deepEqual(built.roots, []);
});

test('GET /api/features ships the tree the page draws', async () => {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: 'lubbdubb',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });

  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Watched work', labels: ['lubbdubb-watch'] });
  await system.harness.runCycle('manual');

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/features' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as FeaturesPayload;
  // The fake tracker is flat, which is the deployment the page is switched off on —
  // and the route still answers, so the cockpit's gate reads a fact rather than an
  // error.
  assert.equal(body.tracked, false);
  assert.deepEqual(body.roots, []);
  assert.deepEqual(body.containerTypes, config.issueContainerTypes);
  await app.close();
});
