import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DISPATCH_RULES } from '../src/dispatcher/rules.js';
import { decisionAttribution } from '../web/src/components/util.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Agent, Decision, Issue, PullRequest, Task } from '../src/types.js';

// The decision row's two columns: `rule` names what **proposed** an act,
// `admission` what **became** of it. One column answering both is what made a
// throttled `issue-pickup` audit as `cooldown-escalate` with the pickup lost.

const NOW = '2026-07-28T12:00:00.000Z';

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Make it better',
    body: 'the thing should be better',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p42',
    number: 42,
    title: 'A change',
    branch: 'feature/x',
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

/** Three spent dispatches on `origin`, all outside the cooldown window. */
function spentCap(origin: string, rule: string): Decision[] {
  return [1, 2, 3].map((n) => ({
    id: `dec_${n}`,
    cycleId: 'cyc',
    action: { type: 'dispatch_code_agent', originRef: origin, reason: 'x', rule },
    outcome: 'executed' as const,
    detail: '',
    rule,
    admission: null,
    createdAt: '2026-07-25T00:00:00.000Z',
  }));
}

// -- the vocabularies are two, and the types keep them apart -----------------

test('only admission-kind ids are ever emitted into the admission field', async () => {
  // The registry is the display vocabulary; `AdmissionId` is the narrow subset
  // that may reach the column. Asserted over `string` so the property survives
  // someone widening the type it is derived from.
  const d = new RuleDispatcher({}, {}, undefined, 'main');
  const { actions } = await d.decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
      recentDecisions: spentCap('issue:12', 'issue-pickup'),
    }),
  );
  for (const a of actions) {
    if (!a.admission) continue;
    assert.ok(a.admission in DISPATCH_RULES, `${a.admission} resolves in the registry`);
    assert.equal(DISPATCH_RULES[a.admission as keyof typeof DISPATCH_RULES].kind, 'admission');
  }
});

// -- the four emission sites -------------------------------------------------

test('a throttled pickup names issue-pickup as its proposer, not the cap that stopped it', async () => {
  const d = new RuleDispatcher({}, {}, undefined, 'main');
  const { actions } = await d.decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
      recentDecisions: spentCap('issue:12', 'issue-pickup'),
    }),
  );
  const escalation = actions.find((a) => a.type === 'escalate_to_human');
  assert.ok(escalation, 'the spent cap escalates rather than looping');
  assert.equal(escalation.rule, 'issue-pickup', 'what got throttled — the fact the single column lost');
  assert.equal(escalation.admission, 'cooldown-escalate', 'and what throttling did to it');
});

test("a throttled PR concern names the concern's own rule", async () => {
  const d = new RuleDispatcher({}, {}, undefined, 'main');
  const { actions } = await d.decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [pr({ ciStatus: 'failing' })], issues: [] },
      recentDecisions: spentCap('pr:42:ci', 'pr-ci-failing'),
    }),
  );
  const escalation = actions.find((a) => a.type === 'escalate_to_human');
  assert.ok(escalation);
  assert.equal(escalation.rule, 'pr-ci-failing', 'the top concern, which is what the dispatch would have been for');
  assert.equal(escalation.admission, 'cooldown-escalate');
});

test('a branch note records no proposer at all, and says so through the admission', async () => {
  // The one deliberate null. `fresh` folds signals from every concern on the PR,
  // so no single rule proposed the note; `concerns[0]` is picked by the urgency
  // order, which exists to decide who gets the one agent when the branch is free.
  // The concerns it covers are on `originRefs`, in full.
  const task: Task = {
    id: 't1',
    kind: 'code',
    title: 'Fix CI',
    prompt: 'x',
    branch: 'feature/x',
    originRef: 'pr:42:mergeable',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const agent: Agent = {
    id: 'a1',
    taskId: 't1',
    status: 'running',
    cwd: '/tmp/wt/feature-x',
    pid: null,
    waitingReason: null,
    sessionId: null,
    startedAt: NOW,
    endedAt: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: null,
    note: null,
    notedAt: null,
    resumedAt: null,
  };
  const d = new RuleDispatcher({}, {}, undefined, 'main');
  const { actions } = await d.decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [pr({ ciStatus: 'failing' })], issues: [] },
      tasks: [task],
      agents: [agent],
    }),
  );
  const note = actions.find((a) => a.type === 'respond_to_agent');
  assert.ok(note, 'the fresh CI signal reaches the agent already on the branch');
  assert.equal(note.rule, null, 'no single rule proposed a note folding several concerns');
  assert.equal(note.admission, 'branch-notify');
  assert.deepEqual(note.originRefs, ['pr:42:ci'], 'what it covers is recorded per signal, finer than a rule id');
});

// -- the column ---------------------------------------------------------------

test('recordDecision lifts both ids off the action into their own columns', () => {
  const store = new Store(':memory:');
  const d = store.recordDecision({
    cycleId: 'cyc',
    action: {
      type: 'escalate_to_human',
      reason: 'capped',
      rule: 'issue-pickup',
      admission: 'cooldown-escalate',
    },
    outcome: 'executed',
    detail: '',
  });
  assert.equal(d.rule, 'issue-pickup');
  assert.equal(d.admission, 'cooldown-escalate');
  const [read] = store.listDecisions();
  assert.equal(read?.rule, 'issue-pickup', 'and survives the round trip');
  assert.equal(read?.admission, 'cooldown-escalate');
  store.close();
});

test('an action with no admission records null, never the rule over again', () => {
  const store = new Store(':memory:');
  const d = store.recordDecision({
    cycleId: 'cyc',
    action: { type: 'dispatch_code_agent', reason: 'go', rule: 'issue-pickup' },
    outcome: 'executed',
    detail: '',
  });
  assert.equal(d.rule, 'issue-pickup');
  assert.equal(d.admission, null, 'a proposal admitted unchanged has no outcome id');
  store.close();
});

test('the migration is additive on a database created before the column', () => {
  // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so without the
  // `ensureColumns('decisions', …)` entry the column is invisible on every older
  // database — and reading one would throw rather than degrade.
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-migrate-'));
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT NOT NULL,
      rule TEXT,
      created_at TEXT NOT NULL
    )`);
  old
    .prepare(`INSERT INTO decisions (id, cycle_id, action, outcome, detail, rule, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(
      'dec_old',
      'cyc',
      JSON.stringify({ type: 'escalate_to_human', reason: 'capped', rule: 'cooldown-escalate' }),
      'executed',
      'escalated',
      'cooldown-escalate',
      '2026-01-01T00:00:00.000Z',
    );
  old.close();

  const store = new Store(path);
  const columns = new Set(
    (new Database(path).prepare(`PRAGMA table_info(decisions)`).all() as { name: string }[]).map((c) => c.name),
  );
  assert.ok(columns.has('admission'), 'the column was added rather than the table recreated');

  const [row] = store.listDecisions();
  assert.equal(row?.id, 'dec_old', 'the pre-existing row is still there — nothing was rewritten');
  assert.equal(row?.rule, 'cooldown-escalate', 'and it still carries the outcome in the old place');
  assert.equal(row?.admission, null);

  // The new shape writes alongside it; the two coexist forever.
  store.recordDecision({
    cycleId: 'cyc2',
    action: { type: 'escalate_to_human', reason: 'x', rule: 'issue-pickup', admission: 'cooldown-escalate' },
    outcome: 'executed',
    detail: '',
  });
  const both = store.listDecisions();
  assert.equal(both.length, 2);
  store.close();
});

// -- what the cockpit makes of the two shapes --------------------------------

const RULES = DISPATCH_RULES as unknown as Record<string, { name: string; description: string; kind: string }>;

test('a new row reads as a proposer plus what became of it', () => {
  const { entries, note } = decisionAttribution({ rule: 'issue-pickup', admission: 'cooldown-escalate' }, RULES);
  assert.deepEqual(
    entries.map((e) => [e.label, e.id]),
    [
      ['Proposed by', 'issue-pickup'],
      ['Admitted as', 'cooldown-escalate'],
    ],
  );
  assert.equal(note, undefined, 'nothing to explain — both facts are present');
});

test('an old row is rendered as an outcome, and the missing proposer is stated', () => {
  // The cost of not rewriting history: which rule was throttled is not in the
  // row, so the renderer says which shape it is looking at instead of guessing.
  const { entries, note } = decisionAttribution({ rule: 'cooldown-escalate', admission: null }, RULES);
  assert.deepEqual(
    entries.map((e) => [e.label, e.id]),
    [['Outcome', 'cooldown-escalate']],
    'the single id is named as what it is — an outcome, never a proposer',
  );
  assert.match(note ?? '', /before proposer and outcome were separate/);
});

test('an old row from a server that never sent the field reads the same', () => {
  // Absent and null are different on the wire (an older server, versus a
  // proposal admitted unchanged) but identical for a row whose one id is an
  // admission.
  const { entries, note } = decisionAttribution({ rule: 'branch-notify' }, RULES);
  assert.deepEqual(
    entries.map((e) => e.label),
    ['Outcome'],
  );
  assert.match(note ?? '', /before proposer and outcome were separate/);
});

test('a branch note with no proposer explains the gap rather than showing one', () => {
  const { entries, note } = decisionAttribution({ rule: null, admission: 'branch-notify' }, RULES);
  assert.deepEqual(
    entries.map((e) => [e.label, e.id]),
    [['Admitted as', 'branch-notify']],
  );
  assert.match(note ?? '', /more than one concern/);
});

test('an ordinary rule row is one line, and a row with neither says so', () => {
  const plain = decisionAttribution({ rule: 'issue-pickup', admission: null }, RULES);
  assert.deepEqual(
    plain.entries.map((e) => [e.label, e.id]),
    [['Proposed by', 'issue-pickup']],
  );
  assert.equal(plain.note, undefined);

  const none = decisionAttribution({ rule: null, admission: null }, RULES);
  assert.deepEqual(none.entries, []);
  assert.match(none.note ?? '', /No dispatcher rule recorded/);
});

test('an unknown id still renders, because the row is what it is', () => {
  const { entries } = decisionAttribution({ rule: 'a-rule-since-renamed', admission: null }, RULES);
  assert.deepEqual(
    entries.map((e) => [e.label, e.rule]),
    [['Proposed by', undefined]],
    'the renderer names the raw id rather than dropping the row',
  );
});
