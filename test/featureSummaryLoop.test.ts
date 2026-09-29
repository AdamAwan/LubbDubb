import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FEATURE_SUMMARY_REPEAT_CAP } from '../src/featureSummaries/featureSummary.js';
import type { ErrorLogEntry } from '../src/types.js';

// → docs/spec/05-dispatcher.md#feature-summary--where-a-feature-is

const FEATURE = 500;
const CHILD = 501;
const ORIGIN = `issue:${FEATURE}:summary`;

function build(backend: FakePtyBackend, logged: ErrorLogEntry[]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-fsloop-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      featureBoard: true,
    }),
    { worktrees: new FakeWorktreeManager(), backend, errorMirror: (e) => logged.push(e) },
  );
  // The fake tracker has no hierarchy; the board and the rule are gated on one.
  system.connector.canPlaceWorkItem = () => true;
  system.store.tickets.ensureTrackerSweep(30 * 24 * 60 * 60 * 1000);
  system.store.tickets.recordSweep(
    '2026-07-01T00:00:00.000Z',
    [
      {
        number: CHILD,
        title: 'Turn a bucket on',
        labels: [],
        state: 'open',
        workItemState: 'Active',
        url: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        changedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    [
      {
        number: CHILD,
        labels: [],
        workItemState: 'Active',
        issueType: 'User Story',
        parent: { number: FEATURE, title: 'Wider matching' },
      },
    ],
  );
  return system;
}

function summaryTasks(system: System) {
  return system.store.tasks.listTasks().filter((t) => t.originRef === ORIGIN);
}

/* Past the rule's cooldown, which is what paced the loop on the deployment that found it, and past its
   attempt cap, which counts inside the last 200 decisions and so never binds on a busy fleet. */
function later(t: TestContext, system: () => System): () => void {
  let now = Date.parse('2026-09-01T00:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  return () => {
    now += 20 * 60_000;
    t.mock.timers.setTime(now);
    for (let i = 0; i < 200; i += 1) {
      system().store.decisions.recordDecision({
        cycleId: 'elsewhere',
        action: { type: 'no_op', reason: 'the rest of the fleet' },
        outcome: 'executed',
        detail: '',
      });
    }
  };
}

async function summarise(system: System, backend: FakePtyBackend): Promise<void> {
  const task = summaryTasks(system).find((t) => t.status === 'running');
  assert.ok(task?.agentId, 'a summariser is on the Feature');
  const filed = system.agents.recordFeatureSummary(task.agentId, {
    headline: 'Nearly there',
    standing: 'The one story is delivered and waiting to land.',
    usable: null,
    blocked: null,
    remaining: null,
  });
  assert.equal(filed.ok, true);
  backend.last().emitExit(0);
  await delay(5);
}

test('a fact the summariser is not shown can flip for ever and never re-dispatch it', async (t) => {
  const backend = new FakePtyBackend();
  const logged: ErrorLogEntry[] = [];
  const next = later(t, () => system);
  const system = build(backend, logged);
  try {
    system.store.verdicts.recordDelivery({ originRef: `issue:${CHILD}`, summary: 'PR #40 did it', by: 'assessor' });
    await system.harness.runCycle('manual');
    assert.equal(summaryTasks(system).length, 1, 'a Feature nobody has summarised gets one');
    await summarise(system, backend);

    for (let i = 0; i < 4; i += 1) {
      // Same sentence, new decided_at: the timestamp moves and nothing the dossier draws does.
      system.store.verdicts.clearDelivery(`issue:${CHILD}`);
      next();
      system.store.verdicts.recordDelivery({ originRef: `issue:${CHILD}`, summary: 'PR #40 did it', by: 'assessor' });
      await system.harness.runCycle('manual');
    }
    assert.equal(summaryTasks(system).length, 1, 'no summariser is sent to look at something it cannot see');
  } finally {
    system.store.close();
  }
});

test('an account refiled unchanged is held after the cap, shown to the operator, and released by real movement', async (t) => {
  const backend = new FakePtyBackend();
  const logged: ErrorLogEntry[] = [];
  const next = later(t, () => system);
  const system = build(backend, logged);
  try {
    await system.harness.runCycle('manual');
    await summarise(system, backend);

    // A shown fact flipping back and forth: every filing records one side, the next pulse sees the other.
    const sides = ['Resolved', 'Active'];
    for (let i = 0; i < FEATURE_SUMMARY_REPEAT_CAP + 3; i += 1) {
      next();
      system.store.tickets.patchTicketState({ number: CHILD, state: sides[i % 2]! });
      await system.harness.runCycle('manual');
      if (summaryTasks(system).some((t) => t.status === 'running')) await summarise(system, backend);
    }
    assert.equal(
      summaryTasks(system).length,
      FEATURE_SUMMARY_REPEAT_CAP + 1,
      'the first account, then the cap of identical refilings, then nothing',
    );
    assert.equal(
      logged.filter((e) => e.message.includes(`feature #${FEATURE}`)).length,
      1,
      'the loop is put in front of the operator, once',
    );
    assert.equal(system.store.tickets.getFeatureSummary(`issue:${FEATURE}`)?.repeats, FEATURE_SUMMARY_REPEAT_CAP);

    next();
    system.store.verdicts.recordDelivery({ originRef: `issue:${CHILD}`, summary: 'PR #41 did it', by: 'assessor' });
    await system.harness.runCycle('manual');
    assert.equal(
      summaryTasks(system).length,
      FEATURE_SUMMARY_REPEAT_CAP + 2,
      'something the summariser is shown moved somewhere new, so it is sent again',
    );
  } finally {
    system.store.close();
  }
});
