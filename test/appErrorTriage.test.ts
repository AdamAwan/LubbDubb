import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeAppErrorReader } from '../src/appErrors/fakeReader.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import {
  episodeAnchor,
  episodeId,
  pickForTriage,
  triageBriefing,
  triageCandidates,
  type UnlinkedGroup,
} from '../src/appErrors/triage.js';
import { DAY_MS } from '../src/primitives.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { GoalLanding } from '../src/types.js';
import type { AppErrorGroupView, AppErrorsPayload } from '../src/wire.js';

// → docs/spec/39-app-errors.md#agent-triage

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

function view(over: Partial<AppErrorGroupView> = {}): AppErrorGroupView {
  return {
    environment: 'live',
    fingerprint: 'fp-1',
    title: 'NullReferenceException in OrderService.Submit',
    operation: 'POST /orders',
    version: null,
    frames: ['src/Orders/OrderService.cs:118'],
    hasDetail: true,
    url: null,
    firstSeen: '2026-11-01T08:00:00.000Z',
    lastSeen: '2026-11-01T11:00:00.000Z',
    returnedAt: null,
    daily: [],
    key: 'err:shop:aaaa1111',
    state: 'new',
    count: 5,
    ignored: false,
    spike: null,
    link: {
      goalRef: null,
      how: [],
      why: 'No goal is in the 7 days of arrivals on live before it.',
      candidates: 0,
      tied: [],
    },
    tracker: null,
    triage: null,
    ...over,
  };
}

function unlinked(over: Partial<AppErrorGroupView> = {}): UnlinkedGroup {
  const group = view(over);
  return { group, head: null, anchor: episodeAnchor(group, null)! };
}

test('an episode is anchored where the group moved, and a spike with no deploy does not move with the clock', () => {
  assert.equal(episodeAnchor(view(), null), '2026-11-01T08:00:00.000Z');
  assert.equal(
    episodeAnchor(view({ state: 'returned', returnedAt: '2026-10-30T00:00:00.000Z' }), null),
    '2026-10-30T00:00:00.000Z',
  );
  assert.equal(episodeAnchor(view({ state: 'spiking' }), null), '', 'no deploy on record: one episode for the spike');
  const head = {
    environment: 'live',
    sha: 'b',
    previousSha: 'a',
    observedAt: '',
    changedAt: '2026-10-31T00:00:00.000Z',
  };
  assert.equal(episodeAnchor(view({ state: 'spiking' }), head), '2026-10-31T00:00:00.000Z');
  assert.equal(episodeAnchor(view({ state: 'steady' }), null), null);
  assert.equal(episodeAnchor(view({ ignored: true }), null), null, 'a muted group has no episode');
});

test('a run takes each episode once, one group per key, the most moved and most frequent first', () => {
  const a = unlinked({ fingerprint: 'a', key: 'err:shop:a', state: 'spiking', count: 90 });
  const b = unlinked({ fingerprint: 'b', key: 'err:shop:b', state: 'new', count: 3 });
  const c = unlinked({ fingerprint: 'c', key: 'err:shop:c', state: 'new', count: 30 });
  const cElsewhere = unlinked({ environment: 'test', fingerprint: 'c', key: 'err:shop:c', state: 'new', count: 40 });
  const answered = new Set([episodeId({ environment: 'live', fingerprint: 'b', state: 'new', anchor: b.anchor })]);
  const picked = pickForTriage([a, b, c, cElsewhere], answered, 10).map(
    (g) => `${g.group.environment}/${g.group.fingerprint}`,
  );
  assert.deepEqual(picked, ['test/c', 'live/a'], 'answered is skipped, one per key, new before spiking');
  assert.equal(pickForTriage([a, b, c], new Set(), 1).length, 1, 'the limit holds');
  const back = unlinked({
    fingerprint: 'b',
    key: 'err:shop:b',
    state: 'returned',
    returnedAt: '2026-11-01T09:00:00.000Z',
  });
  assert.equal(pickForTriage([back], answered, 10).length, 1, 'a group that returns is a new episode');
});

function landing(goalRef: string, sha: string, daysBefore: number, onIntegration: boolean | null = true): GoalLanding {
  const at = new Date(NOW - daysBefore * DAY_MS).toISOString();
  return { prNumber: Number(goalRef.slice(6)), goalRef, sha, recordedAt: at, onIntegration, mergedAt: null };
}

test('the candidates are every goal landed in the thirty days before the anchor, and a returned group’s ticket first', () => {
  const candidates = triageCandidates({
    anchor: NOW,
    frames: ['/app/src/Orders/OrderService.cs:118'],
    landings: [
      landing('issue:1', 'a', 2),
      landing('issue:2', 'b', 10),
      landing('issue:3', 'c', 40),
      landing('issue:4', 'd', 5, false),
      landing('issue:5', 'e', -1),
      landing('issue:9', 'f', 60),
    ],
    titles: new Map([['issue:2', 'Rework order submission']]),
    diff: (sha) => (sha === 'b' ? ['src/Orders/OrderService.cs'] : null),
    prime: 'issue:9',
  });
  assert.deepEqual(
    candidates.map((c) => c.goalRef),
    ['issue:9', 'issue:2', 'issue:1'],
    'the ticket’s goal leads wherever it landed; a frame-touching change next; off-branch, late and old ones are left out',
  );
  assert.equal(candidates[0]!.prime, true);
  assert.deepEqual(candidates[1]!.touched, ['/app/src/Orders/OrderService.cs']);
  assert.equal(candidates[1]!.title, 'Rework order submission');
  assert.equal(candidates[2]!.files, null, 'a diff the linker has not answered is omitted, never asked for');
});

test('the briefing carries frames, the link and the candidates, and never the message or the stack', () => {
  const group = view({ tracker: { status: 'closed', ticketRef: 'issue:9', note: 'fixed 2026-10-20, error is back' } });
  const brief = triageBriefing([
    {
      group,
      anchor: group.firstSeen,
      candidates: [
        {
          goalRef: 'issue:2',
          title: 'Rework order submission',
          landedAt: '2026-10-25T00:00:00.000Z',
          files: ['src/Orders/OrderService.cs'],
          touched: ['src/Orders/OrderService.cs'],
          prime: false,
        },
      ],
    },
  ]);
  assert.match(brief, /### err:shop:aaaa1111 — NullReferenceException/);
  assert.match(brief, /`src\/Orders\/OrderService.cs:118`/);
  assert.match(brief, /No goal is in the 7 days of arrivals/);
  assert.match(brief, /issue:2 — Rework order submission — landed 2026-10-25/);
  assert.match(brief, /Its tracker ticket: issue:9 \(closed/);
  assert.match(brief, /app_error_detail returns them/);
});

const ENVIRONMENTS: EnvironmentConfig[] = [
  { name: 'live', at: 'unused', errors: { list: './errors.sh live {since}' } },
];
const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();
const A = 'a'.repeat(40);

function build(perDay = 20, backend = new FakePtyBackend()): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-triage-'));
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
      environments: ENVIRONMENTS,
      pool: { project: 'shop' },
      appErrorTriagePerDay: perDay,
    }),
    {
      backend,
      worktrees: new FakeWorktreeManager(),
      environmentProber: new FakeEnvironmentProber(),
      appErrorReader: new FakeAppErrorReader(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

function seed(system: System): void {
  const env = system.store.environments;
  env.recordGoalLanding({ prNumber: 1, goalRef: 'issue:412', sha: A, mergedAt: null });
  env.recordEnvironmentReach({ sha: A, environment: 'live', status: 'absent', detail: null });
  env.recordEnvironmentHead('live', 'f'.repeat(40));
  const group = (fingerprint: string, count: number) => ({
    group: {
      environment: 'live',
      fingerprint,
      title: `${fingerprint} failed`,
      operation: 'POST /orders',
      version: null,
      frames: ['src/Orders/OrderService.cs:118'],
      message: 'SECRET-MESSAGE for alice@example.com',
      stack: 'SECRET-STACK at OrderService.Submit()',
      url: null,
      firstSeen: soon(30_000),
      lastSeen: soon(30_000),
      returnedAt: null,
    },
    days: [{ day: soon(0).slice(0, 10), count }],
  });
  system.store.appErrors.recordRead(
    { environment: 'live', readAt: new Date().toISOString(), status: 'ok', detail: null },
    [group('Orders.Submit', 9), group('Cart.Load', 4)],
  );
}

async function payload(system: System): Promise<AppErrorsPayload> {
  const { app } = await buildApp(system);
  try {
    return (await app.inject({ method: 'GET', url: '/api/app-errors' })).json<AppErrorsPayload>();
  } finally {
    await app.close();
  }
}

function groupOf(data: AppErrorsPayload, fingerprint: string): AppErrorGroupView {
  const g = data.environments[0]!.groups.find((x) => x.fingerprint === fingerprint);
  assert.ok(g);
  return g;
}

test('the pulse opens a run over the unlinked moved groups without waiting, within the day’s cap', async () => {
  const system = build(1);
  try {
    seed(system);
    system.appErrorTriage.run();
    assert.equal(system.store.appErrorTriage.openRunNow(), null, 'the pass returns before the linked read lands');
    await system.appErrorTriage.settled();
    const run = system.store.appErrorTriage.openRunNow();
    assert.ok(run);
    assert.equal(run.trigger, 'auto');
    assert.deepEqual(
      run.subjects.map((s) => s.fingerprint),
      ['Orders.Submit'],
      'the cap of one takes the most frequent',
    );
    assert.deepEqual(run.subjects[0]!.candidates, ['issue:412'], 'the wider list holds a goal the window did not');
    system.store.appErrorTriage.settleRun(run.id);
    system.appErrorTriage.run();
    await system.appErrorTriage.settled();
    assert.equal(system.store.appErrorTriage.openRunNow(), null, 'the day’s cap is spent');
  } finally {
    system.store.close();
  }
});

test('appErrorTriagePerDay 0 leaves triage to the press', async () => {
  const system = build(0);
  try {
    seed(system);
    system.appErrorTriage.run();
    await system.appErrorTriage.settled();
    assert.equal(system.store.appErrorTriage.openRunNow(), null);
    const { app } = await buildApp(system);
    try {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/app-errors/triage',
        payload: { environment: 'live', fingerprint: 'nope' },
      });
      assert.equal(missing.statusCode, 404);
      const pressed = await app.inject({
        method: 'POST',
        url: '/api/app-errors/triage',
        payload: { environment: 'live', fingerprint: 'Cart.Load' },
      });
      assert.equal(pressed.statusCode, 200);
      assert.equal(system.store.appErrorTriage.openRunNow()?.trigger, 'operator');
      const again = await app.inject({
        method: 'POST',
        url: '/api/app-errors/triage',
        payload: { environment: 'live', fingerprint: 'Orders.Submit' },
      });
      assert.equal(again.statusCode, 409, 'one run out at a time');
      assert.equal(groupOf(await payload(system), 'Cart.Load').triage?.queued, true, 'the row says the agent has it');
    } finally {
      await app.close();
    }
  } finally {
    system.store.close();
  }
});

test('one read-only agent triages the run: fenced verdicts, recorded detail reads, and the verdict on the wire', async () => {
  const backend = new FakePtyBackend();
  const system = build(20, backend);
  try {
    seed(system);
    system.appErrorTriage.run();
    await system.appErrorTriage.settled();
    await system.harness.runCycle('manual');
    const tasks = system.store.tasks.listTasks().filter((t) => t.rule === 'app-error-triage');
    assert.equal(tasks.length, 1, 'one agent for the whole run');
    const task = system.store.tasks.getTask(tasks[0]!.id)!;
    assert.ok(task.agentId);
    assert.match(task.prompt, /### err:shop:[0-9a-f]{8} — Orders.Submit failed/);
    assert.match(task.prompt, /issue:412/);
    assert.ok(!task.prompt.includes('SECRET'), 'neither message nor stack is in the brief');
    assert.equal(system.store.appErrorTriage.openRunNow()?.status, 'dispatched');

    const run = system.store.appErrorTriage.openRunNow()!;
    const orders = run.subjects.find((s) => s.fingerprint === 'Orders.Submit')!;
    const cart = run.subjects.find((s) => s.fingerprint === 'Cart.Load')!;
    const agentId = task.agentId;
    const say = (over: Partial<Parameters<System['agents']['recordAppErrorTriage']>[1]>) =>
      system.agents.recordAppErrorTriage(agentId, {
        key: orders.key,
        verdict: 'caused-by',
        goalRef: 'issue:412',
        confidence: 'medium',
        reason: 'OrderService.cs:118 is the null check #412 removed.',
        ...over,
      });
    assert.equal(say({ key: 'err:shop:00000000' }).ok, false, 'a key outside the run is refused');
    const outside = say({ goalRef: 'issue:7' });
    assert.ok(!outside.ok && outside.error.includes('#412'), 'a goal outside the candidates is refused, naming them');
    assert.equal(say({ verdict: 'pre-existing' }).ok, false, 'goalRef goes only with caused-by');
    assert.equal(say({ goalRef: null }).ok, false, 'caused-by needs a goal');
    assert.deepEqual(say({ goalRef: '#412' }), { ok: true, remaining: [cart.key] });

    const detail = await system.agents.readAppErrorDetail(agentId, orders.key);
    assert.ok(detail.ok && detail.message?.startsWith('SECRET-MESSAGE') && detail.stack?.startsWith('SECRET-STACK'));
    assert.equal(detail.query, null, 'no detail query is declared, so none ran');
    assert.equal((await system.agents.readAppErrorDetail(agentId, 'err:shop:00000000')).ok, false);

    const data = await payload(system);
    const triage = groupOf(data, 'Orders.Submit').triage;
    assert.equal(triage?.verdict, 'caused-by');
    assert.equal(triage?.goalRef, 'issue:412');
    assert.equal(triage?.queued, false);
    assert.ok(triage?.detailReadAt, 'the row says the agent read the stack');
    assert.equal(groupOf(data, 'Orders.Submit').link?.goalRef, null, 'the deterministic link is untouched');
    assert.equal(groupOf(data, 'Cart.Load').triage?.queued, true);

    backend.last().emitExit(0);
    await delay(5);
    await system.harness.runCycle('manual');
    await system.appErrorTriage.settled();
    const next = system.store.appErrorTriage.openRunNow();
    assert.ok(next, 'the run settled when its agent ended, and the unanswered group went in the next');
    assert.deepEqual(
      next.subjects.map((s) => s.fingerprint),
      ['Cart.Load'],
      'an answered episode is not triaged again',
    );
  } finally {
    system.store.close();
  }
});
