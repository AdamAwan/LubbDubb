import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { GoalWatch, PlanPart, StateQuery, ValidationCheck } from '../src/types.js';
import type { PlanPartView } from '../src/wire.js';

(globalThis as { React?: typeof React }).React = React;

const { PlanModal } = await import('../web/src/components/PlanModal.js');
const { RefLinks } = await import('../web/src/components/refs.js');

// → docs/spec/17-cockpit.md#the-proof-band

test('the band counts a plan’s four kinds of proof, and jumps rather than drawing rows', () => {
  const html = sheet({
    parts: [part({ slug: 'route' }), part({ slug: 'e2e-download', coverage: 'Snapshots' })],
    checks: [check({ id: 'a-person-opens-it' }), check({ id: 'the-suite-opens-it', area: 'Snapshots' })],
    watches: [watch({ id: 'download-401s' }), watch({ id: 'download-p95', kind: 'measure' })],
    queries: [query({ id: 'no-capability-persisted' })],
  });

  const band = ['manual', 'suite', 'watch', 'state'].map((kind) => cell(html, kind)).join('');
  assert.ok(band.includes('A person runs'), 'the four cells are drawn');
  assert.ok(band.includes('The suite runs'));
  assert.ok(band.includes('After it ships'));
  assert.ok(band.includes('The data is right'));

  assert.ok(band.includes('Snapshots'), 'the area a test part covers is named — it is drawn nowhere else');
  assert.ok(band.includes('1 signal, 1 measure'), 'the watch is counted by kind, which is how it is expected');

  assert.ok(
    !band.includes('the do wording'),
    'the band counts and nothing else — a row it drew itself could disagree with the section it stands for',
  );
  assert.ok(!band.includes('select id from'), 'and it draws no query either');
});

test('a check that inherited an area is the suite’s, and is not counted as a person’s as well', () => {
  const both = sheet({
    parts: [part({ slug: 'e2e-download', coverage: 'Snapshots' })],
    checks: [check({ id: 'by-hand' }), check({ id: 'by-the-suite', area: 'Snapshots' })],
  });
  assert.ok(cell(both, 'manual').includes('0/1 settled'), 'one check has no area, so one is a person’s');
  assert.ok(
    cell(both, 'suite').includes('1 check verified against it'),
    'and the one that inherited an area is answered by the suite',
  );
});

test('a cell with nothing declared draws, and says which nothing', () => {
  const bare = sheet({ parts: [part({ slug: 'route' })] });

  assert.ok(cell(bare, 'suite').includes('No test part'), 'no coverage declared says so');
  assert.ok(cell(bare, 'watch').includes('No watch declared'));
  assert.ok(cell(bare, 'state').includes('No state query'));
  assert.ok(cell(bare, 'manual').includes('No check declared'));
  assert.equal(
    (bare.match(/pm-pnone/g) ?? []).length,
    4,
    'nothing declared is a third fact, not a synonym for clean — an undeclared cell is drawn, greyed',
  );
});

test('the state digest draws a goal’s queries, read-only, and nothing where none were declared', () => {
  const withQuery = sheet({
    parts: [part({ slug: 'route' })],
    queries: [query({ id: 'no-capability-persisted' })],
  });
  assert.ok(withQuery.includes('No capability is ever written'), 'the query’s title');
  assert.ok(withQuery.includes('select id, created_at from snapshots'), 'the query itself');
  assert.ok(withQuery.includes('select id from snapshots'), 'and the presence query beside it');
  assert.ok(withQuery.includes('declared at conclude'), 'a query the working agent wrote says so');

  const opens = withQuery.indexOf('The data is right</span>', withQuery.indexOf('pm-pcell state'));
  const digest = withQuery.slice(opens, withQuery.indexOf('pm-flags', opens));
  assert.ok(!digest.includes('<button'), 'a query is accepted on the goal, against a named environment — not here');

  const none = sheet({ parts: [part({ slug: 'route' })] });
  assert.ok(!none.includes('pm-wquery'), 'a goal that declared no queries draws no digest at all');
});

test('a goal’s state queries reach the cockpit beside its watches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
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
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() },
  );

  system.store.saveStateQueries(
    'issue:395',
    [
      {
        id: 'no-capability-persisted',
        seq: 1,
        title: 'No capability is ever written to the snapshot table',
        query: 'select id, created_at from snapshots where download_capability is not null',
        presence: 'select id from snapshots order by created_at desc limit 50',
        why: null,
      },
    ],
    'plan',
  );

  const snap = buildStateSnapshot(system) as unknown as { stateQueries: StateQuery[] };
  assert.deepEqual(
    snap.stateQueries.map((q) => q.id),
    ['no-capability-persisted'],
    'the plan sheet has no other way to count them',
  );
  system.store.close();
});

function cell(html: string, kind: string): string {
  const at = html.indexOf(`pm-pcell ${kind}`);
  assert.ok(at > 0, `the ${kind} cell is drawn`);
  return html.slice(at, html.indexOf('</button>', at));
}

function sheet(input: {
  parts: PlanPartView[];
  checks?: ValidationCheck[];
  watches?: GoalWatch[];
  queries?: StateQuery[];
}): string {
  return renderToStaticMarkup(
    createElement(
      RefLinks,
      {
        refUrls: {},
        openGoal: () => undefined,
        hasGoal: () => false,
        openPr: () => undefined,
        hasPr: () => false,
      } as unknown as Parameters<typeof RefLinks>[0],
      createElement(PlanModal, {
        plan: {
          id: 'plan-395',
          originRef: 'issue:395',
          title: 'Snapshot downloads 401 in the review console',
          status: 'awaiting_approval',
          reason: 'The signer has to exist first.',
          diagnosis: null,
          approach: null,
          risks: null,
          outOfScope: null,
          alternatives: null,
          openQuestions: null,
          verification: null,
          evidence: [],
          document: null,
          statusCommentRef: null,
          createdAt: 'then',
          updatedAt: 'then',
        },
        parts: input.parts,
        atoms: [],
        checks: input.checks ?? [],
        caveatAnswers: [],
        watches: input.watches ?? [],
        queries: input.queries ?? [],
        upcoming: [],
        spend: null,
        planning: { fileBudget: 20, maxConcurrentPartsPerIssue: 2 },
        now: Date.now(),
        refUrls: {},
        onClose: () => undefined,
        onReplan: () => undefined,
        onWatchProposal: () => undefined,
        onDecide: () => undefined,
        onBackOut: () => undefined,
        onOpenGoal: () => undefined,
        onPartProfile: () => undefined,
        onRestartPart: () => undefined,
        canClosePr: false,
        profiles: [],
        defaultProfile: null,
        desktopFolder: '/home/you/shop',
      } as unknown as Parameters<typeof PlanModal>[0]),
    ),
  );
}

function part(over: Partial<PlanPart> & { slug: string }): PlanPartView {
  return {
    id: `plan-395:${over.slug}`,
    planId: 'plan-395',
    seq: 1,
    title: 'The route',
    scope: 'Where the route is registered.',
    touches: [],
    atoms: [],
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    acceptanceCriteria: [],
    outsideScope: [],
    size: null,
    depth: 0,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: 'then',
    updatedAt: 'then',
    ...over,
  } as unknown as PlanPartView;
}

function check(over: Partial<ValidationCheck> & { id: string }): ValidationCheck {
  return {
    originRef: 'issue:395',
    letter: 'A',
    seq: 1,
    title: 'A snapshot download opens in a new tab',
    do: 'the do wording',
    expect: 'The file downloads.',
    uses: [],
    covers: [],
    steps: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'human',
    handbackNote: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    claimedBy: null,
    claimedAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    area: null,
    createdAt: 'then',
    updatedAt: 'then',
    ...over,
  };
}

function watch(over: Partial<GoalWatch> & { id: string }): GoalWatch {
  return {
    originRef: 'issue:395',
    seq: 1,
    kind: 'signal',
    title: 'Downloads stop 401ing',
    query: "traces | where message has 'rejected'",
    presence: "traces | where operation_Name == 'download'",
    tolerate: 0,
    expectUnder: null,
    expectOver: null,
    expectBaseline: false,
    unit: null,
    why: null,
    dryRunEnvironment: null,
    dryRunAt: null,
    dryRunVerdict: null,
    dryRunPresence: null,
    dryRunRows: null,
    dryRunDetail: null,
    baselineValue: null,
    baselineAt: null,
    live: true,
    proposal: null,
    authored: 'plan',
    ...over,
  } as unknown as GoalWatch;
}

function query(over: Partial<StateQuery> & { id: string }): StateQuery {
  return {
    originRef: 'issue:395',
    seq: 1,
    title: 'No capability is ever written to the snapshot table',
    query: 'select id, created_at from snapshots where download_capability is not null',
    presence: 'select id from snapshots order by created_at desc limit 50',
    why: null,
    digest: 'sha256:4f21c0',
    authored: 'agent',
    dryRunEnvironment: null,
    dryRunAt: null,
    dryRunVerdict: null,
    dryRunPresence: null,
    dryRunRows: null,
    dryRunDetail: null,
    dryRunSample: null,
    ...over,
  };
}
