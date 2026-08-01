import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { goalFingerprint } from '../src/intake/assay.js';
import { githubRefUrl } from '../src/integrations/github/refUrl.js';
import { buildRefUrls, issueCommentRef } from '../src/server/refUrls.js';
import type { Issue } from '../src/types.js';
import type { CockpitState } from '../src/wire.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// Issue #171 — the two comments the harness maintains on a ticket by itself: the
// plan's status comment and the goal assay's refusal. Both are written without
// anyone authorising them (mechanical bookkeeping, deliberately not auto-send
// gated), and both were invisible to the cockpit — the ref lived in the store and
// nothing on `/api/state` said a comment existed, let alone where to read it.
//
// What is asserted here is the *shape* that makes them visible: a provider comment
// id is paired with its issue on the way out, because the id alone is not a ref —
// it resolves to nothing, and a bare number reads as an issue number to anything
// that resolves refs. Absent, or unresolvable, must reach the cockpit as silence.

const ISSUE = 12;

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-comments-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

async function withIssue(system: System): Promise<Issue> {
  system.connector.inject({
    kind: 'new_issue',
    number: ISSUE,
    title: 'Make it better',
    body: 'the thing should be better',
  });
  const world = await system.connector.getState();
  system.store.setWorldBaseline(world);
  return world.issues.find((i) => i.number === ISSUE)!;
}

async function snapshot(system: System): Promise<CockpitState> {
  const { buildStateSnapshot } = await import('../src/server/app.js');
  return buildStateSnapshot(system);
}

test('a plan that has written no comment ships null, not an empty link', async () => {
  const system = build();
  await withIssue(system);
  system.store.upsertPlan({ originRef: `issue:${ISSUE}`, title: 'Big thing', status: 'active', reason: null });

  const snap = await snapshot(system);
  assert.equal(snap.plans[0]!.statusCommentRef, null);
  // Nothing to key, so nothing in the map either: absent must reach the cockpit
  // as silence rather than as a caption with no way in.
  assert.equal(
    Object.keys(snap.refUrls).some((k) => k.includes(':comment:')),
    false,
  );
  system.store.close?.();
});

test('the plan status comment ships as a canonical ref, never the provider id', async () => {
  const system = build();
  await withIssue(system);
  const plan = system.store.upsertPlan({
    originRef: `issue:${ISSUE}`,
    title: 'Big thing',
    status: 'active',
    reason: null,
  });
  // What the provider handed back from `upsertIssueComment` — an id, and only an
  // id. This is the thing the store must keep (it round-trips through the seam to
  // edit the same comment in place) and the thing the wire must not carry.
  system.store.setPlanStatusComment(plan.id, '8391');
  assert.equal(system.store.getPlan(plan.id)!.statusCommentRef, '8391', 'the store keeps the provider id');

  const snap = await snapshot(system);
  assert.equal(snap.plans[0]!.statusCommentRef, `issue:${ISSUE}:comment:8391`);
  system.store.close?.();
});

test("the assay's refusal comment ships beside its verdict", async () => {
  const system = build();
  const issue = await withIssue(system);
  system.store.recordAssay({
    originRef: `issue:${ISSUE}`,
    verdict: 'unclear',
    summary: 'Name one behaviour that is wrong today.',
    goalRef: goalFingerprint(issue.title, issue.body),
    by: 'assayer',
  });

  // Before the desk has spoken there is a verdict and no comment — the reading and
  // the way in are separate facts, and the second one is allowed to be missing.
  const asked = await snapshot(system);
  assert.equal(asked.world.issues.find((i) => i.number === ISSUE)!.assay!.commentRef, null);

  system.store.setAssayComment(`issue:${ISSUE}`, '8402');
  const answered = await snapshot(system);
  assert.equal(answered.world.issues.find((i) => i.number === ISSUE)!.assay!.commentRef, `issue:${ISSUE}:comment:8402`);
  system.store.close?.();
});

test('the refs the snapshot ships are the refs a provider can resolve', async () => {
  const system = build();
  const issue = await withIssue(system);
  const plan = system.store.upsertPlan({
    originRef: `issue:${ISSUE}`,
    title: 'Big thing',
    status: 'active',
    reason: null,
  });
  system.store.setPlanStatusComment(plan.id, '8391');
  system.store.recordAssay({
    originRef: `issue:${ISSUE}`,
    verdict: 'unclear',
    summary: 'Name one behaviour that is wrong today.',
    goalRef: goalFingerprint(issue.title, issue.body),
    by: 'assayer',
  });
  system.store.setAssayComment(`issue:${ISSUE}`, '8402');

  const snap = await snapshot(system);
  const shipped = [
    snap.plans[0]!.statusCommentRef!,
    snap.world.issues.find((i) => i.number === ISSUE)!.assay!.commentRef!,
  ];
  // The `fake` connector resolves nothing, so the snapshot's own map is empty for
  // these — the cockpit draws no link, which is the documented degradation and not
  // a bug. What the shape has to earn is that a provider which *does* build URLs
  // can answer it, so the same refs go through the real GitHub resolver here.
  for (const ref of shipped) assert.equal(snap.refUrls[ref], undefined, 'the fake provider resolves nothing');
  const resolved = buildRefUrls({
    pullRequests: [],
    issues: [],
    taskBranches: [],
    refs: shipped,
    resolve: (ref) => githubRefUrl('octo', 'repo', ref),
  });
  assert.equal(resolved[shipped[0]!], 'https://github.com/octo/repo/issues/12#issuecomment-8391');
  assert.equal(resolved[shipped[1]!], 'https://github.com/octo/repo/issues/12#issuecomment-8402');
  system.store.close?.();
});

test('a bare comment id would have linked the wrong ticket', async () => {
  // The reason the pairing exists, asserted rather than only argued: shipping the
  // store's value would have keyed a confident link off `githubRefUrl`'s bare
  // number arm — to issue #8391, which has nothing to do with this comment.
  assert.equal(githubRefUrl('octo', 'repo', '8391'), 'https://github.com/octo/repo/issues/8391');
  assert.equal(
    githubRefUrl('octo', 'repo', issueCommentRef('issue:12', '8391')!),
    'https://github.com/octo/repo/issues/12#issuecomment-8391',
  );
});
