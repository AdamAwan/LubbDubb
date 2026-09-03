import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { isHarnessBranch, isOurPr, isSomeoneElsesPr } from '../src/prOwnership.js';
import { prsToSeedWatch } from '../src/prWatch.js';
import { prAttentionStatus, type PrAttentionContext } from '../src/prAttention.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { renamablePrs } from '../src/prRename.js';
import type { PullRequest } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  id: 'p',
  number: 1,
  title: 'X',
  branch: 'feat',
  ciStatus: 'passing',
  unresolvedComments: [],
  ...over,
});

function ctx(over: Partial<PrAttentionContext> = {}): PrAttentionContext {
  return {
    openPrs: [],
    defaultBranch: 'main',
    watchLabel: '',
    tasks: [],
    proposals: [],
    recentDecisions: [],
    cooldown: DEFAULT_COOLDOWN,
    ci: { checks: [] },
    now: '2026-07-26T12:00:00.000Z',
    ...over,
  };
}

function build(overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
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

// --------------------------------------------------------------------------
// The predicates
// --------------------------------------------------------------------------

test('isOurPr: the provider’s answer outranks the filter and the branch shape', () => {
  // The bug this exists for: `prAuthor` is configured, so the fetch also returns
  // the pull requests a colleague put the operator on — and every one of them used
  // to read as the harness's own.
  assert.equal(isOurPr(pr({ viewerAuthored: false }), true), false);
  assert.equal(isOurPr(pr({ branch: 'issue/12', viewerAuthored: false }), true), false, 'even on a dispatch branch');
  assert.equal(isOurPr(pr({ viewerAuthored: true }), false), true);

  // Unknown authorship falls back to what it always did.
  assert.equal(isOurPr(pr({}), true), true);
  assert.equal(isOurPr(pr({}), false), false);
  assert.equal(isOurPr(pr({ branch: 'issue/12' }), false), true);
  assert.equal(isHarnessBranch('job/abc'), true);
});

test('isSomeoneElsesPr: only a positive answer hides a pull request', () => {
  assert.equal(isSomeoneElsesPr(pr({ viewerAuthored: false })), true);
  assert.equal(isSomeoneElsesPr(pr({ viewerAuthored: true })), false);
  // A provider that cannot name an author must not take the whole world out of
  // dispatch: unknown is not "somebody else's".
  assert.equal(isSomeoneElsesPr(pr({})), false);
});

test('a colleague’s pull request is neither renamed nor seeded for watching', () => {
  const theirs = pr({ number: 5, branch: 'issue/12', title: 'wip', viewerAuthored: false });
  assert.deepEqual(
    renamablePrs([theirs], {
      prAuthorConfigured: true,
      template: '{number}: {title}',
      issues: [{ id: 'i12', number: 12, title: 'Widget', body: '', state: 'open', labels: [], linkedPrNumber: 5 }],
    }),
    [],
  );
  assert.deepEqual(
    prsToSeedWatch([theirs], {
      watchLabel: 'lubbdubb-watch',
      legacyIgnoreLabel: 'lubbdubb-ignore',
      seeded: new Set<number>(),
    }),
    [],
  );
});

test('a colleague’s pull request reads as elsewhere, and as yours once they assign it', () => {
  const watched = ctx({ watchLabel: '' });
  const theirs = prAttentionStatus(pr({ viewerAuthored: false, author: 'priya' }), watched);
  assert.equal(theirs.status, 'elsewhere');
  assert.match(theirs.reasons[0]!, /priya opened this/);
  assert.equal(theirs.assignedToYou, undefined);

  const asked = prAttentionStatus(
    pr({ viewerAuthored: false, author: 'priya', viewerAssignment: 'reviewer-required' }),
    watched,
  );
  assert.equal(asked.status, 'you', 'a review they asked you for is still your court');
  assert.equal(asked.assignedToYou, 'reviewer-required');
});

// --------------------------------------------------------------------------
// The harness
// --------------------------------------------------------------------------

test('no rule fires on a watched pull request somebody else opened', async () => {
  const system = build();
  system.connector.inject({
    kind: 'new_pr',
    number: 42,
    title: 'Their change',
    branch: 'feat',
    labels: ['lubbdubb-watch'],
    author: 'priya',
    viewerAuthored: false,
  });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  system.connector.inject({ kind: 'pr_comment', prNumber: 42, author: 'priya', body: 'please rename this' });
  await system.harness.runCycle('manual');

  const origins = system.store.listTasks().map((t) => t.originRef);
  assert.equal(
    origins.some((o) => o?.startsWith('pr:42')),
    false,
    'neither the CI fix nor the review-comment reply is dispatched for a colleague’s PR',
  );

  // Still fully visible — the panel keeps the row, the fleet keeps its hands off.
  const world = await system.connector.getState();
  assert.ok(
    world.pullRequests.some((p) => p.number === 42),
    'the pull request is hidden from dispatch, not from the world',
  );
  system.store.close();
});

test('the same pull request is worked once it is the harness’s own', async () => {
  const system = build();
  system.connector.inject({
    kind: 'new_pr',
    number: 42,
    title: 'Our change',
    branch: 'feat',
    labels: ['lubbdubb-watch'],
    viewerAuthored: true,
  });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    true,
  );
  system.store.close();
});
