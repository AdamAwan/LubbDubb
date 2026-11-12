import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { planCaveats, proposedCaveats } from '../src/plans/planCaveats.js';
import { watchHintRequired, watchNote } from '../src/plans/planning.js';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';
import { PLAN_COLUMNS } from '../src/store/plans.js';
import type { Agent, Issue, WatchHint } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

interface ToolResultText {
  isError?: boolean;
  content: { text?: string }[];
}

const WATCHED: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk', schema: 'Structured logs land in `traces`.' },
};

const UNWATCHED: EnvironmentConfig = { name: 'testUk', at: 'echo unused' };

const INTENTS = {
  intents: [
    {
      kind: 'signal',
      source: 'logs',
      says: 'The statement job stops timing out',
      why: '~37 timeouts a day in traces today',
    },
    { kind: 'measure', source: 'metrics', says: 'The statement run is no slower' },
  ],
};

const NONE = { none: 'Docs-only change: nothing running behaves differently' };

function build(environments: EnvironmentConfig[]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-hint-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    environments,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    environmentObserver: new FakeEnvironmentObserver(),
    errorMirror: () => {},
  });
}

function spawnPlanner(system: System): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Plan issue #12',
    prompt: 'plan it',
    branch: 'issue/12/plan',
    originRef: 'issue:12:plan',
    originTitle: 'The statement job keeps timing out',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function submit(system: System, extra: Record<string, unknown>) {
  const session = system.mcp.session(spawnPlanner(system).id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session.call('plan_submit', {
    reason: 'One part.',
    parts: [{ slug: 'fix', title: 'Fix the job', scope: 'src/jobs' }],
    ...extra,
  })) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('a hint is required exactly where the planner is asked for one', () => {
  assert.equal(watchHintRequired([WATCHED]), true);
  assert.equal(watchHintRequired([UNWATCHED]), false);
  assert.equal(watchHintRequired([]), false);
  assert.equal(watchNote([UNWATCHED]), '', 'no note where no hint is required');
  const note = watchNote([WATCHED]);
  assert.match(note, /`watchHint`/);
  assert.match(note, /"none"/);
  assert.match(note, /The reason is required/);
  assert.match(note, /refactor, a docs change or a build fix/);
  assert.match(note, /Do not write a `watch` block/);
});

test('where an environment declares a watch, a plan with no hint is refused and records nothing', async () => {
  const system = build([WATCHED]);
  const res = await submit(system, {});
  assert.equal(res.isError, true);
  assert.match(res.text, /watchHint: required/);
  assert.equal(system.store.plans.getPlanByOrigin('issue:12'), null);
  system.store.close();
});

test('a hint carrying both shapes, or neither, is refused', async () => {
  const system = build([WATCHED]);
  const both = await submit(system, { watchHint: { ...INTENTS, ...NONE } });
  assert.equal(both.isError, true);
  assert.match(both.text, /never both/);
  const neither = await submit(system, { watchHint: {} });
  assert.equal(neither.isError, true);
  assert.match(neither.text, /needs "intents", or "none"/);
  const empty = await submit(system, { watchHint: { intents: [] } });
  assert.equal(empty.isError, true, 'an empty list of intents is not an answer');
  const blank = await submit(system, { watchHint: { none: '  ' } });
  assert.equal(blank.isError, true, 'a none without a reason is not an answer');
  assert.equal(system.store.plans.getPlanByOrigin('issue:12'), null);
  system.store.close();
});

test('intents, or none with a reason, are accepted and kept on the plan', async () => {
  const system = build([WATCHED]);
  assert.equal((await submit(system, { watchHint: INTENTS })).isError, false);
  const hint = system.store.plans.getPlanByOrigin('issue:12')!.watchHint;
  assert.deepEqual(hint, {
    intents: [
      {
        kind: 'signal',
        source: 'logs',
        says: 'The statement job stops timing out',
        why: '~37 timeouts a day in traces today',
      },
      { kind: 'measure', source: 'metrics', says: 'The statement run is no slower', why: null },
    ],
  });

  assert.equal((await submit(system, { watchHint: NONE })).isError, false);
  assert.deepEqual(system.store.plans.getPlanByOrigin('issue:12')!.watchHint, NONE, 'a replan replaces the hint');
  system.store.close();
});

test('where no environment declares a watch, a plan with no hint is accepted and carries none', async () => {
  const system = build([UNWATCHED]);
  const res = await submit(system, {});
  assert.equal(res.isError, false, res.text);
  assert.equal(system.store.plans.getPlanByOrigin('issue:12')!.watchHint, null);
  system.store.close();
});

test('the plan file is held to the same rule as the tool', () => {
  const doc = JSON.stringify({ version: 1, reason: 'One part.', parts: [{ slug: 'a', title: 'A', scope: 'src/' }] });
  assert.equal(parsePlanDocument(doc).ok, true, 'a stored or amended document is not asked for one');
  const refused = parsePlanDocument(doc, { watchHintRequired: true });
  assert.ok(!refused.ok);
  assert.match(refused.error, /watchHint: required/);
});

test('an amendment without a hint leaves the standing one in place', () => {
  const store = new Store(':memory:');
  const doc = (hint: unknown) => {
    const parsed = parsePlanDocument(
      JSON.stringify({
        version: 1,
        reason: 'One part.',
        parts: [{ slug: 'a', title: 'A', scope: 'src/' }],
        ...(hint === undefined ? {} : { watchHint: hint }),
      }),
    );
    assert.ok(parsed.ok);
    return parsed.document;
  };
  ingestPlanDocument(store, { doc: doc(NONE), originRef: 'issue:12', title: 'T' });
  ingestPlanDocument(store, { doc: doc(undefined), originRef: 'issue:12', title: 'T' });
  assert.deepEqual(store.plans.getPlanByOrigin('issue:12')!.watchHint, NONE);
  store.close();
});

test('the hint is a caveat labelled for what it is, with the intents or the reason as its detail', () => {
  const issue = { number: 12, linkedPrNumber: null } as unknown as Issue;
  const caveat = (watchHint: WatchHint | null) =>
    planCaveats({ risks: null, openQuestions: null, watchHint }, issue, [], []).find((c) => c.id === 'watch');

  assert.equal(caveat(null), undefined, 'a plan with no hint raises no box');
  const intents = caveat({
    intents: [
      { kind: 'signal', source: 'logs', says: 'The statement job stops timing out', why: null },
      { kind: 'measure', source: 'metrics', says: 'The run is no slower', why: 'it was 40s' },
    ],
  })!;
  assert.equal(intents.label, 'How we’ll know it worked');
  assert.equal(
    intents.detail,
    '- **signal** · logs — The statement job stops timing out\n- **measure** · metrics — The run is no slower (it was 40s)',
  );
  assert.equal(caveat({ none: 'Docs only.' })!.detail, 'Nothing to watch: Docs only.');
});

test('approving is held until the hint is ticked', async () => {
  const system = build([WATCHED]);
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Statement job', body: 'It times out.', labels: [] });
  assert.equal((await submit(system, { watchHint: INTENTS })).isError, false);
  await system.harness.runCycle('manual');
  const proposal = system.store.escalations.listProposals().find((p) => p.kind === 'plan')!;
  assert.ok(proposal, 'the plan is proposed');

  const caveats = proposedCaveats(proposal);
  assert.deepEqual(
    caveats.map((c) => c.id),
    ['watch'],
  );
  assert.match(caveats[0]!.detail ?? '', /\*\*signal\*\* · logs — The statement job stops timing out/);
  const esc = system.store.escalations.getEscalation(proposal.escalationId!)!;
  assert.match(esc.prompt, /How we’ll know it worked/);

  const refused = await system.proposals.accept(proposal.id, 'looks fine');
  assert.ok(refused && 'unacknowledged' in refused);
  assert.deepEqual(
    refused.unacknowledged.map((c) => c.id),
    ['watch'],
  );
  assert.equal(system.store.plans.getPlanByOrigin('issue:12')!.status, 'awaiting_approval');

  const accepted = await system.proposals.accept(proposal.id, 'agreed', ['watch']);
  assert.ok(accepted && 'outcome' in accepted);
  assert.equal(accepted.outcome, 'performed');
  assert.equal(system.store.plans.getPlanByOrigin('issue:12')!.status, 'active');
  system.store.close();
});

test('plans.watch_hint is declared in PLAN_COLUMNS, so a database from before it gains it on boot', () => {
  assert.equal(PLAN_COLUMNS.plans!.watch_hint, 'TEXT', 'CREATE TABLE IF NOT EXISTS never alters an existing table');
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-hint-'));
  const path = join(dir, 'old.db');
  const stripped = SCHEMA.split('\n')
    .filter((line) => !/^\s*watch_hint\s+TEXT/.test(line))
    .join('\n');
  assert.ok(!/\n\s*watch_hint\s+TEXT/.test(stripped), 'the fixture really is a database from before the column');
  const db = new Database(path);
  db.exec(stripped);
  db.prepare(
    `INSERT INTO plans (id, origin_ref, title, status, discussing, created_at, updated_at)
     VALUES ('plan_old', 'issue:12', 'Statement job', 'awaiting_approval', 0, ?, ?)`,
  ).run('2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z');
  db.close();

  const store = new Store(path);
  assert.equal(
    store.plans.getPlan('plan_old')!.watchHint,
    null,
    'null is a plan from before hints, which is true of every row written before the column',
  );
  store.plans.setPlanWatchHint('plan_old', { none: 'Docs only.' });
  assert.deepEqual(store.plans.getPlan('plan_old')!.watchHint, { none: 'Docs only.' });
  store.close();

  const inspect = new Database(path);
  const names = (inspect.prepare(`PRAGMA table_info(plans)`).all() as { name: string }[]).map((c) => c.name);
  inspect.close();
  assert.ok(names.includes('watch_hint'));
});
