import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { goalFingerprint } from '../src/intake/appraisal.js';
import { githubRefUrl } from '../src/integrations/github/refUrl.js';
import { buildRefUrls, issueCommentRef } from '../src/server/refUrls.js';
import type { Issue } from '../src/types.js';
import type { CockpitState } from '../src/wire.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

const ISSUE = 12;

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-comments-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
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
  const { buildStateSnapshot } = await import('../src/server/stateSnapshot.js');
  return buildStateSnapshot(system);
}

test('a plan that has written no comment ships null, not an empty link', async () => {
  const system = build();
  await withIssue(system);
  system.store.upsertPlan({ originRef: `issue:${ISSUE}`, title: 'Big thing', status: 'active', reason: null });

  const snap = await snapshot(system);
  assert.equal(snap.plans[0]!.statusCommentRef, null);
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
  system.store.setPlanStatusComment(plan.id, '8391');
  assert.equal(system.store.getPlan(plan.id)!.statusCommentRef, '8391', 'the store keeps the provider id');

  const snap = await snapshot(system);
  assert.equal(snap.plans[0]!.statusCommentRef, `issue:${ISSUE}:comment:8391`);
  system.store.close?.();
});

test("the appraisal's refusal comment ships beside its verdict", async () => {
  const system = build();
  const issue = await withIssue(system);
  system.store.recordAppraisal({
    originRef: `issue:${ISSUE}`,
    verdict: 'unclear',
    summary: 'Name one behaviour that is wrong today.',
    goalRef: goalFingerprint(issue.title, issue.body),
    by: 'appraiser',
  });

  const asked = await snapshot(system);
  assert.equal(asked.world.issues.find((i) => i.number === ISSUE)!.appraisal!.commentRef, null);

  system.store.setAppraisalComment(`issue:${ISSUE}`, '8402');
  const answered = await snapshot(system);
  assert.equal(
    answered.world.issues.find((i) => i.number === ISSUE)!.appraisal!.commentRef,
    `issue:${ISSUE}:comment:8402`,
  );
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
  system.store.recordAppraisal({
    originRef: `issue:${ISSUE}`,
    verdict: 'unclear',
    summary: 'Name one behaviour that is wrong today.',
    goalRef: goalFingerprint(issue.title, issue.body),
    by: 'appraiser',
  });
  system.store.setAppraisalComment(`issue:${ISSUE}`, '8402');

  const snap = await snapshot(system);
  const shipped = [
    snap.plans[0]!.statusCommentRef!,
    snap.world.issues.find((i) => i.number === ISSUE)!.appraisal!.commentRef!,
  ];
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
  assert.equal(githubRefUrl('octo', 'repo', '8391'), 'https://github.com/octo/repo/issues/8391');
  assert.equal(
    githubRefUrl('octo', 'repo', issueCommentRef('issue:12', '8391')!),
    'https://github.com/octo/repo/issues/12#issuecomment-8391',
  );
});
