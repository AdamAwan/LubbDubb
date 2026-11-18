import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { issueBranch } from '../src/dispatcher/issuePickup.js';
import { localValidationOrigin } from '../src/validation/local/origin.js';
import { localValidationIsOpen } from '../src/validation/local/stale.js';
import { LocalValidationTicketDesk } from '../src/validation/local/ticket.js';
import type { TicketFiler } from '../src/tickets/filing.js';
import type { CiStatus, Issue, PullRequest, WorldSnapshot } from '../src/types.js';

const HEAD = 'c'.repeat(40);
const NEXT = 'd'.repeat(40);

function build(auto = true): { system: System; worktrees: FakeWorktreeManager } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-lva-'));
  const worktrees = new FakeWorktreeManager();
  const system = buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      localRunRoot: join(dir, 'local-run'),
      validationRoot: join(dir, 'validation'),
      heartbeatIntervalMs: 999_999,
      localRun: { instruction: 'npm run dev' } as never,
      localValidation: { auto } as never,
    }),
    { worktrees, backend: new FakePtyBackend(), gitObserver: new FakeGitObserver(), errorMirror: () => {} },
  );
  return { system, worktrees };
}

function issue(number: number): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Goal ${number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
  };
}

function pr(number: number, ciStatus: CiStatus, headSha = HEAD): PullRequest {
  return {
    id: `pr${number}`,
    number,
    title: `PR ${number}`,
    branch: issueBranch(number),
    ciStatus,
    headSha,
    unresolvedComments: [],
  };
}

function world(system: System, ...goals: { n: number; ci: CiStatus; head?: string }[]): WorldSnapshot {
  const snapshot: WorldSnapshot = {
    takenAt: '2026-01-01T00:00:00.000Z',
    issues: goals.map((g) => issue(g.n)),
    pullRequests: goals.map((g) => pr(g.n, g.ci, g.head)),
  };
  system.store.world.setWorldBaseline(snapshot);
  return snapshot;
}

async function press(system: System, snapshot: WorldSnapshot): Promise<void> {
  system.store.world.setWorldBaseline(snapshot);
  await system.localValidationAuto.run(snapshot);
  await system.localValidationAuto.settled();
}

function deliver(system: System, n: number): void {
  system.store.verdicts.recordDelivery({ originRef: `issue:${String(n)}`, summary: 'done', by: 'assessor' });
}

test('a delivered goal with green CI on the commit it would run is validated without a press', async () => {
  const { system, worktrees } = build();
  try {
    const snapshot = world(system, { n: 12, ci: 'passing' });
    worktrees.setPreviewCommit(issueBranch(12), HEAD);
    deliver(system, 12);

    await press(system, snapshot);

    const row = system.store.localValidations.latestLocalValidation('issue:12');
    assert.ok(row !== null && localValidationIsOpen(row), 'open — its own cycle may already have dispatched it');
    assert.equal(row?.requestedBy, 'auto');
    assert.equal(row?.commit, HEAD);
    assert.equal(system.store.localRuns.liveLocalRun()?.originRef, 'issue:12');
  } finally {
    system.store.close();
  }
});

test('nothing is pressed while off, undelivered, CI not green, or the checkout has not caught up', async () => {
  const cases: { name: string; auto?: boolean; ci?: CiStatus; delivered?: boolean; tip?: string }[] = [
    { name: 'off', auto: false },
    { name: 'undelivered', delivered: false },
    { name: 'ci pending', ci: 'pending' },
    { name: 'checkout behind', tip: NEXT },
  ];
  for (const c of cases) {
    const { system, worktrees } = build(c.auto ?? true);
    try {
      const snapshot = world(system, { n: 12, ci: c.ci ?? 'passing' });
      worktrees.setPreviewCommit(issueBranch(12), c.tip ?? HEAD);
      if (c.delivered !== false) deliver(system, 12);
      await press(system, snapshot);
      assert.equal(system.store.localValidations.latestLocalValidation('issue:12'), null, c.name);
      assert.equal(system.store.localRuns.liveLocalRun(), null, c.name);
    } finally {
      system.store.close();
    }
  }
});

test('an environment the operator started is never taken', async () => {
  const { system, worktrees } = build();
  try {
    const snapshot = world(system, { n: 12, ci: 'passing' });
    worktrees.setPreviewCommit(issueBranch(12), HEAD);
    deliver(system, 12);
    const mine = await system.localRun.start('issue:7');
    assert.ok(mine.ok);

    await press(system, snapshot);

    assert.equal(system.store.localValidations.latestLocalValidation('issue:12'), null);
    assert.equal(system.store.localRuns.liveLocalRun()?.originRef, 'issue:7');
  } finally {
    system.store.close();
  }
});

test('each commit is validated once, and a settled auto run hands its environment to the next goal', async () => {
  const { system, worktrees } = build();
  try {
    let snapshot = world(system, { n: 12, ci: 'passing' }, { n: 13, ci: 'passing' });
    worktrees.setPreviewCommit(issueBranch(12), HEAD).setPreviewCommit(issueBranch(13), HEAD);
    deliver(system, 12);
    deliver(system, 13);

    await press(system, snapshot);
    const first = system.store.localValidations.latestLocalValidation('issue:12');
    assert.equal(first?.requestedBy, 'auto');

    await press(system, snapshot);
    assert.equal(system.store.localValidations.latestLocalValidation('issue:13'), null, 'one at a time');

    system.store.localValidations.abandonLocalValidation(first.id, 'called off from the cockpit');
    await press(system, snapshot);
    assert.equal(system.store.localValidations.latestLocalValidation('issue:13')?.requestedBy, 'auto');
    assert.equal(system.store.localRuns.liveLocalRun()?.originRef, 'issue:13');

    const thirteen = system.store.localValidations.latestLocalValidation('issue:13');
    assert.ok(thirteen);
    system.store.localValidations.abandonLocalValidation(thirteen.id, 'done');
    await press(system, snapshot);
    assert.equal(
      system.store.localValidations.latestLocalValidation('issue:12')?.id,
      first.id,
      'a commit already validated is not run again',
    );

    snapshot = world(system, { n: 12, ci: 'passing', head: NEXT }, { n: 13, ci: 'passing' });
    worktrees.setPreviewCommit(issueBranch(12), NEXT);
    await press(system, snapshot);
    const again = system.store.localValidations.latestLocalValidation('issue:12');
    assert.notEqual(again?.id, first.id, 'a new commit is');
    assert.equal(again?.commit, NEXT);
  } finally {
    system.store.close();
  }
});

test('a press runs a cycle of its own, which dispatches the validator', async () => {
  const { system, worktrees } = build();
  try {
    const snapshot = world(system, { n: 12, ci: 'passing' });
    worktrees.setPreviewCommit(issueBranch(12), HEAD);
    deliver(system, 12);

    await press(system, snapshot);

    const deadline = Date.now() + 20_000;
    while (
      system.store.localValidations.latestLocalValidation('issue:12')?.status === 'pending' &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const row = system.store.localValidations.latestLocalValidation('issue:12');
    assert.equal(row?.requestedBy, 'auto');
    assert.equal(row?.status, 'dispatched');
  } finally {
    system.store.close();
  }
});

function land(system: System, n: number, mergedAt: string, pr = 100 + n): void {
  system.store.environments.recordGoalLanding({ prNumber: pr, goalRef: `issue:${String(n)}`, sha: HEAD, mergedAt });
  system.store.environments.markLandingIntegration(pr, true);
}

async function dispatched(system: System, originRef: string): Promise<string | undefined> {
  const deadline = Date.now() + 20_000;
  while (system.store.localValidations.latestLocalValidation(originRef)?.status === 'pending' && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return system.store.localValidations.latestLocalValidation(originRef)?.status;
}

async function justNow(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return new Date().toISOString();
}

test('a goal merged since auto was switched on is validated once, on the integration branch', async () => {
  const { system } = build();
  try {
    const empty: WorldSnapshot = { takenAt: '2026-01-01T00:00:00.000Z', issues: [issue(12)], pullRequests: [] };
    await press(system, empty);
    land(system, 12, await justNow());

    await press(system, empty);
    const row = system.store.localValidations.latestLocalValidation('issue:12');
    assert.equal(row?.requestedBy, 'auto');
    assert.equal(row?.ref, 'main');
    assert.equal(await dispatched(system, 'issue:12'), 'dispatched', 'dispatched onto the integration branch');

    system.store.localValidations.abandonLocalValidation(row.id, 'done');
    await press(system, empty);
    assert.equal(system.store.localValidations.latestLocalValidation('issue:12')?.id, row.id, 'once per merge');
  } finally {
    system.store.close();
  }
});

test('a merge from before auto was switched on is not queued, nor one already validated', async () => {
  const { system } = build();
  try {
    land(system, 12, '2020-01-01T00:00:00.000Z');
    const empty = world(system);
    await press(system, empty);
    assert.equal(system.store.localValidations.latestLocalValidation('issue:12'), null, 'the backlog stays put');

    const run = await system.localRun.start('issue:13');
    assert.ok(run.ok);
    const mine = system.localValidations.request({ originRef: 'issue:13', run: run.run });
    system.store.localValidations.recordLocalValidationReport(mine.id, {
      status: 'passed',
      summary: 'fine',
      findings: [],
      visited: [],
      setup: [],
      screenshots: [],
      note: null,
      recordingStatus: null,
    });
    await system.localRun.stop('done');
    land(system, 13, await justNow());
    await press(system, empty);
    assert.equal(system.store.localValidations.latestLocalValidation('issue:13')?.id, mine.id);
  } finally {
    system.store.close();
  }
});

test('only an automatic validation may report skipped', async () => {
  const { system, worktrees } = build();
  try {
    const snapshot = world(system, { n: 12, ci: 'passing' });
    worktrees.setPreviewCommit(issueBranch(12), HEAD);
    deliver(system, 12);
    await press(system, snapshot);
    const auto = system.store.localValidations.latestLocalValidation('issue:12');
    assert.ok(auto);
    const skip = { status: 'skipped' as const, summary: 'a refactor', findings: [], visited: [], setup: [] };
    const task = (id: string) =>
      system.store.tasks.createTask({
        kind: 'code',
        title: 'validate',
        prompt: 'go',
        branch: `validate-local/${id}`,
        originRef: localValidationOrigin(12, id),
      });

    const done = system.localValidations.report(task(auto.id), skip);
    assert.ok(done.ok);
    assert.equal(done.row.status, 'skipped');

    const run = system.store.localRuns.liveLocalRun();
    assert.ok(run);
    const asked = system.localValidations.request({ originRef: 'issue:12', run });
    const refused = system.localValidations.report(task(asked.id), skip);
    assert.equal(refused.ok, false);
    const still = system.store.localValidations.getLocalValidation(asked.id);
    assert.ok(still !== null && localValidationIsOpen(still), 'nothing was recorded on it');
  } finally {
    system.store.close();
  }
});

test('a failed validation on the integration branch files one linked, watched bug; a branch run does not', async () => {
  const { system } = build();
  try {
    const filed: Parameters<TicketFiler>[0][] = [];
    const desk = new LocalValidationTicketDesk({
      store: system.store,
      filing: async (input) => {
        filed.push(input);
        return '#900';
      },
      canFile: () => true,
      prompts: system.prompts,
      watchLabel: 'watch',
      defaultBranch: 'main',
      errors: { record: () => [] } as never,
      changed: () => {},
    });
    const failed = (originRef: string, ref: string) => {
      const row = system.store.localValidations.createLocalValidation({ originRef, runId: 'r', ref, commit: HEAD });
      system.store.localValidations.recordLocalValidationReport(row.id, {
        status: 'failed',
        summary: 'the button does nothing',
        findings: [{ title: 'Save is dead', detail: 'clicked it', severity: 'blocker', url: null, screenshot: null }],
        visited: [],
        setup: [],
        screenshots: [],
        note: null,
        recordingStatus: null,
      });
      return row.id;
    };
    const onMain = failed('issue:12', 'main');
    failed('issue:13', issueBranch(13));

    await desk.run();
    await desk.run();

    assert.equal(filed.length, 1, 'once, and only for the integration branch');
    assert.equal(filed[0]?.bug, true);
    assert.equal(filed[0]?.relatedTo, 12);
    assert.deepEqual(filed[0]?.labels, ['watch']);
    assert.match(filed[0]?.body ?? '', /Save is dead/);
    assert.equal(system.store.localValidations.getLocalValidation(onMain)?.fixTicketRef, '#900');

    let attempts = 0;
    const flaky = new LocalValidationTicketDesk({
      store: system.store,
      filing: () => {
        attempts += 1;
        return Promise.reject(new Error('tracker down'));
      },
      canFile: () => true,
      prompts: system.prompts,
      watchLabel: 'watch',
      defaultBranch: 'main',
      errors: { record: () => [] } as never,
      changed: () => {},
    });
    const again = failed('issue:14', 'main');
    await flaky.run();
    await flaky.run();
    assert.equal(attempts, 1, 'a failed filing waits before it is tried again');
    assert.equal(system.store.localValidations.getLocalValidation(again)?.fixTicketRef, null, 'and is released to be');
  } finally {
    system.store.close();
  }
});
