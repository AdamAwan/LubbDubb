import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { prsToLinkWorkItem } from '../src/prWorkItemLink.js';
import { isRelationAlreadyExists } from '../src/integrations/azure/restAzureDevOpsApi.js';
import type { Issue, PullRequest } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

function build(overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
  return buildSystem(config, { backend: new FakePtyBackend() });
}

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  id: 'p',
  number: 1,
  title: 'X',
  branch: 'issue/12',
  ciStatus: 'pending',
  unresolvedComments: [],
  ...over,
});

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 'i',
  number: 12,
  title: 'Sync cursors',
  body: '',
  labels: [],
  state: 'open',
  linkedPrNumber: null,
  ...over,
});

// --------------------------------------------------------------------------
// The pure predicate
// --------------------------------------------------------------------------

test('prsToLinkWorkItem: the harness’s own unlinked pull requests, and the work item off the row', () => {
  const ctx = {
    prAuthorConfigured: false,
    issues: [issue(), issue({ id: 'j', number: 13 })],
    linked: new Set<number>(),
  };
  const seeds = prsToLinkWorkItem(
    [
      pr({ number: 1, branch: 'issue/12' }),
      pr({ number: 2, branch: 'issue/12/store' }),
      pr({ number: 3, branch: 'job/abc' }),
      pr({ number: 4, branch: 'someone-elses-work' }),
      pr({ number: 5, branch: 'issue/99' }),
      pr({ number: 6, branch: 'issue/13', state: 'merged', merged: true }),
    ],
    ctx,
  );
  assert.deepEqual(
    seeds,
    [
      { prNumber: 1, workItemNumber: 12 },
      { prNumber: 2, workItemNumber: 12 },
    ],
    'both parts of #12 are owed a link; a job branch names no issue, and #99 does not exist',
  );
});

test('prsToLinkWorkItem: a pull request the provider already reports linked is left alone', () => {
  const ctx = { prAuthorConfigured: false, issues: [issue({ linkedPrNumber: 1 })], linked: new Set<number>() };
  assert.deepEqual(prsToLinkWorkItem([pr({ number: 1 })], ctx), [], 'the relation is already there');
});

test('prsToLinkWorkItem: the recorded row is what makes it once', () => {
  const issues = [issue()];
  assert.deepEqual(prsToLinkWorkItem([pr({ number: 1 })], { prAuthorConfigured: false, issues, linked: new Set() }), [
    { prNumber: 1, workItemNumber: 12 },
  ]);
  assert.deepEqual(
    prsToLinkWorkItem([pr({ number: 1 })], { prAuthorConfigured: false, issues, linked: new Set([1]) }),
    [],
    'an operator who deleted the link does not get it written back',
  );
});

test('prsToLinkWorkItem: an earlier part stays linkable when linkedPrNumber names a later one', () => {
  // `linkedPrNumber` folds a work item's relations to one number, so part 1 reads as
  // unlinked once part 2 links. Only the row can tell them apart.
  const ctx = { prAuthorConfigured: false, issues: [issue({ linkedPrNumber: 2 })], linked: new Set([2]) };
  assert.deepEqual(prsToLinkWorkItem([pr({ number: 1, branch: 'issue/12/a' }), pr({ number: 2 })], ctx), [
    { prNumber: 1, workItemNumber: 12 },
  ]);
});

test('prsToLinkWorkItem: with prAuthor configured every open pull request in the world is ours', () => {
  const ctx = { prAuthorConfigured: true, issues: [issue({ linkedPrNumber: 7 })], linked: new Set<number>() };
  // Resolved by `linkedPrNumber` rather than the branch — a human's branch name is
  // not a dispatch shape, and the link is still the harness's to keep.
  assert.deepEqual(prsToLinkWorkItem([pr({ number: 8, branch: 'feature/hand-cut' })], ctx), [], 'no issue resolves');
  assert.deepEqual(
    prsToLinkWorkItem([pr({ number: 7, branch: 'feature/hand-cut' })], ctx),
    [],
    'and one that does is already linked',
  );
});

test('isRelationAlreadyExists: Azure’s duplicate-relation 400 is not a failure', () => {
  assert.equal(
    isRelationAlreadyExists(
      'Azure DevOps PATCH https://dev.azure.com/x/_apis/wit/workitems/12 -> 400 Bad Request ' +
        '(application/json): {"typeKey":"WorkItemRelationAlreadyExistsException"}',
    ),
    true,
  );
  assert.equal(isRelationAlreadyExists('Relation already exists.'), true);
  assert.equal(isRelationAlreadyExists('403 Forbidden: TF401027 you need Work Item write permission'), false);
});

// --------------------------------------------------------------------------
// Harness behaviour
// --------------------------------------------------------------------------

test('a PR on a dispatch branch is linked to its work item by the harness, once', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'Sync cursors' });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'issue/7' });
  await system.harness.runCycle('manual');

  const world = await system.connector.getState();
  assert.equal(
    world.issues.find((i) => i.number === 7)?.linkedPrNumber,
    42,
    'the harness linked the work item it opened the pull request for',
  );
  assert.ok(system.store.linkedWorkItemPrs().has(42), 'and recorded that it has answered for it');

  // The operator judges the link wrong and removes it. The next pulse must not
  // write it back — a correction that undoes itself is why the row exists.
  system.connector.inject({ kind: 'new_issue', number: 8, title: 'Other' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.linkedWorkItemPrs().size, 1, 'no second link is written for a pull request already done');
  system.store.close();
});

test('a PR on nobody’s dispatch branch is never linked', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'Sync cursors' });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'somebody-elses' });
  await system.harness.runCycle('manual');

  assert.equal((await system.connector.getState()).issues.find((i) => i.number === 7)?.linkedPrNumber ?? null, null);
  assert.equal(system.store.linkedWorkItemPrs().has(42), false);
  system.store.close();
});

test('a PR whose branch names no known work item is left for a human', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'issue/999' });
  await system.harness.runCycle('manual');

  assert.equal(system.store.linkedWorkItemPrs().has(42), false, 'the harness does not guess at a work item');
  system.store.close();
});
