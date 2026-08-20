import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { issuePickupStatus } from '../src/dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { assayHold, assaySignalQuery, goalFingerprint, hasWorkStarted, isAssayed } from '../src/intake/assay.js';
import { AssayDesk, renderAssayComment } from '../src/intake/assayDesk.js';
import { assayerOrigin } from '../src/mcp/goalAssay.js';
import { MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { Agent, Decision, Issue, IssueAssay, Plan, Task, WorldEvent, WorldSnapshot } from '../src/types.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { spentPlannerAttempts } from './support/plans.js';

// Rule `issue-assay` — the goal assay. The one gate in front of an issue that asks about its
// *content*. What makes it fire, what it must never do (park an issue for good),
// and the two things that end a hold.

const NOW = '2026-07-28T12:00:00.000Z';
const EARLIER = '2026-07-28T10:00:00.000Z';

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

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function assay(over: Partial<IssueAssay> = {}): IssueAssay {
  const i = issue();
  return {
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'Better how? There is no measure here I could tell "done" by.',
    goalRef: goalFingerprint(i.title, i.body),
    by: 'assayer',
    proposedProfile: null,
    profileAnsweredAt: null,
    agentId: null,
    taskId: null,
    commentRef: null,
    decidedAt: EARLIER,
    updatedAt: EARLIER,
    ...over,
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: spentPlannerAttempts(12),
    agentHeadroom: 3,
    ...over,
  };
}

/** The dispatcher with the assay on — everything else default. */
function assayer(): RuleDispatcher {
  return new RuleDispatcher();
}

function origins(actions: { type: string; originRef?: string | null }[]): string[] {
  return actions.filter((a) => a.type.startsWith('dispatch_')).map((a) => a.originRef ?? '');
}

/** A spent attempt cap on an origin — three executed dispatches, all outside the cooldown. */
function spentCap(origin: string, branch: string): Decision[] {
  return [1, 2, 3].map((i) => ({
    id: `d${i}`,
    cycleId: `c${i}`,
    action: { type: 'dispatch_code_agent', branch, title: 'x', prompt: 'x', originRef: origin, reason: 'x' },
    outcome: 'executed',
    rule: 'issue-assay',
    admission: null,
    detail: '',
    createdAt: '2026-07-27T00:00:00.000Z',
  })) as Decision[];
}

// -- the headline ------------------------------------------------------------

test('a fresh issue is assayed before anything is dispatched against it', async () => {
  const { actions } = await assayer().decide(ctx());

  assert.deepEqual(origins(actions), ['issue:12:assay'], 'the assay replaces the pickup for this cycle');
  const dispatch = actions.find((a) => a.type === 'dispatch_code_agent') as {
    branch: string;
    base?: string;
    rule: string;
    originTitle?: string | null;
    originSummary?: string | null;
  };
  assert.equal(dispatch.branch, 'assay/issue/12', 'its own namespace — git cannot put issue/12/assay beside issue/12');
  assert.equal(dispatch.base, 'main', 'cut from the default branch: the goal is judged against the repo as it stands');
  assert.equal(dispatch.rule, 'issue-assay');
  // The verdict is fingerprinted off these two fields, so a dispatch that dropped
  // them would stamp every verdict with the fingerprint of an empty goal.
  assert.equal(dispatch.originTitle, 'Make it better');
  assert.equal(dispatch.originSummary, 'the thing should be better');
});

test('there is no flag to turn it off — a fresh issue is assayed before the planner sees it', async () => {
  const { actions } = await new RuleDispatcher().decide(ctx({ recentDecisions: [] }));
  assert.deepEqual(origins(actions), ['issue:12:assay'], 'unconditional, and it runs in front of the funnel');
});

test('assay and pickup never both fire for one issue', async () => {
  const { actions } = await assayer().decide(ctx());
  const dispatched = origins(actions).filter((o) => o.startsWith('issue:12'));
  assert.equal(dispatched.length, 1, 'one agent on the issue, not two');
  assert.ok(!dispatched.includes('issue:12'), 'answering the question by ignoring it is the failure');
});

test('the planner is suppressed too — decomposing an unanswerable question is the point of this rule', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(ctx());
  assert.deepEqual(origins(actions), ['issue:12:assay'], 'ranked ahead of the planner, and standing it down');
});

// -- what it does not fire on ------------------------------------------------

test('an issue that has already had work is the assessor’s, not the assay’s', async () => {
  // `hasPriorWork` is the discriminator both rules read, each taking one arm:
  // nothing started means the goal is all there is to judge; something started
  // means the question was answered by someone acting on it.
  const { actions } = await assayer().decide(ctx({ tasks: [task()] }));
  assert.ok(!origins(actions).includes('issue:12:assay'), 'the goal is not the open question any more');
});

test('an issue that already has a plan is past this gate', async () => {
  const plan = (status: Plan['status']): Plan => ({
    id: 'pl1',
    originRef: 'issue:12',
    title: 'Split it',
    status,
    reason: 'because',
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
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const status of ['planning', 'awaiting_approval', 'active', 'complete'] as const) {
    const { actions } = await assayer().decide(ctx({ plans: [plan(status)] }));
    assert.ok(!origins(actions).includes('issue:12:assay'), `a ${status} plan means the funnel has read this`);
  }
});

test('anything live under the issue stands the assay down', async () => {
  for (const live of ['issue:12', 'issue:12:assay', 'issue:12:plan']) {
    const { actions } = await assayer().decide(ctx({ tasks: [task({ originRef: live, status: 'running' })] }));
    assert.ok(!origins(actions).includes('issue:12:assay'), `${live} is in flight`);
  }
});

test('the watch gate applies — an untagged issue is never assayed', async () => {
  const d = new RuleDispatcher({ watchLabel: 'agent-ready' });

  const unwatched = await d.decide(ctx());
  assert.deepEqual(origins(unwatched.actions), [], 'the assay never filters a backlog nobody opted in');

  const watched = await d.decide(
    ctx({ world: { takenAt: NOW, pullRequests: [], issues: [issue({ labels: ['agent-ready'] })] } }),
  );
  assert.deepEqual(origins(watched.actions), ['issue:12:assay']);
});

test('an issue already judged against this exact text is not re-assayed', async () => {
  for (const verdict of ['workable', 'unclear'] as const) {
    const { actions } = await assayer().decide(ctx({ assays: [assay({ verdict })] }));
    assert.ok(!origins(actions).includes('issue:12:assay'), `${verdict} is an answer; asking again is the duplicate`);
  }
});

// -- failing open: the property that makes blocking safe ---------------------

test('a spent attempt cap returns the issue to the funnel, with no escalation', async () => {
  // Narrowing pickup without this makes the assay the most effective way to stop
  // the harness working — issue #158's own first decision.
  const { actions } = await assayer().decide(ctx({ recentDecisions: spentCap('issue:12:assay', 'assay/issue/12') }));
  assert.deepEqual(origins(actions), ['issue:12:plan'], 'the issue falls through into the funnel');
  assert.ok(
    !actions.some((a) => a.type === 'escalate_to_human'),
    'no escalation: an assay that did not happen tells a human nothing they cannot see on the issue',
  );
});

test('an assayer that writes no verdict holds nothing — silence is not a refusal', () => {
  assert.equal(assayHold(null, issue()), null);
});

test('a cooling assayer still suppresses pickup for that cycle, and stays visible', async () => {
  const recent: Decision[] = [
    {
      id: 'd1',
      cycleId: 'c1',
      action: {
        type: 'dispatch_code_agent',
        branch: 'assay/issue/12',
        title: 'Assay issue #12',
        prompt: 'x',
        originRef: 'issue:12:assay',
        reason: 'assaying',
      },
      outcome: 'executed',
      rule: 'issue-assay',
      admission: null,
      detail: '',
      createdAt: '2026-07-28T11:55:00.000Z', // inside the 15-minute window
    },
  ];
  const { actions, upcoming } = await assayer().decide(ctx({ recentDecisions: recent }));
  assert.deepEqual(origins(actions), [], 'cooling, so nothing is dispatched');
  assert.equal(upcoming?.find((i) => i.origin === 'issue:12:assay')?.status, 'cooldown', 'visible, not silently gone');
});

// -- the hold, and the two things that end it --------------------------------

test('an unclear verdict holds the issue out of pickup and planning alike', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(ctx({ assays: [assay()] }));
  assert.deepEqual(origins(actions), [], 'no pickup, no planner, and not re-asked either');
});

test('a workable verdict releases the issue into the funnel and holds nothing', async () => {
  const { actions } = await assayer().decide(ctx({ assays: [assay({ verdict: 'workable' })], recentDecisions: [] }));
  assert.deepEqual(
    origins(actions),
    ['issue:12:plan'],
    'saying yes schedules nothing itself — it un-blocks the funnel',
  );
  assert.equal(assayHold(assay({ verdict: 'workable' }), issue()), null);
});

test('editing the ticket ends the hold, with no event to have witnessed', async () => {
  const edited = issue({ body: 'the p99 of /search should be under 200ms, measured by the existing bench' });
  // The verdict was cast against the old text, so it no longer describes this item.
  assert.equal(assayHold(assay(), edited), null);
  assert.equal(isAssayed(assay(), edited), false, 'and it is assayed again rather than merely released');

  const { actions } = await assayer().decide(
    ctx({ world: { takenAt: NOW, pullRequests: [], issues: [edited] }, assays: [assay()] }),
  );
  assert.deepEqual(origins(actions), ['issue:12:assay'], 'the edit re-opens the question, on the next pulse');
});

test('an assay of its own is not "work has started" — a crashed assayer is retryable', () => {
  // `issue:12:assay` is inside the subtree `hasPriorWork` matches, so without the
  // exclusion one failed assay would retire the cooldown, the attempt cap and the
  // assessor's arm of the same discriminator in a single stroke.
  assert.equal(hasWorkStarted(12, [task({ originRef: 'issue:12:assay' })]), false);
  assert.equal(hasWorkStarted(12, [task({ originRef: 'issue:12' })]), true);
  assert.equal(hasWorkStarted(12, [task({ originRef: 'issue:12:assess' })]), true, 'downstream evidence work happened');
});

test('the title counts as much as the body, and moving words between them is a change', () => {
  const a = goalFingerprint('Make it', ' better');
  const b = goalFingerprint('Make it better', '');
  assert.notEqual(a, b, 'a separator concatenation could produce would make an edit invisible');
});

test('any transition on the issue ends the hold — a comment answers the question too', () => {
  const after: WorldEvent[] = [
    { id: 'e1', kind: 'issue_linked', ref: 'issue:12', summary: 'linked', createdAt: '2026-07-28T11:00:00.000Z' },
  ];
  assert.equal(assayHold(assay(), issue(), { signals: after }), null);

  const before: WorldEvent[] = [
    { id: 'e0', kind: 'issue_linked', ref: 'issue:12', summary: 'linked', createdAt: '2026-07-28T09:00:00.000Z' },
  ];
  assert.ok(assayHold(assay(), issue(), { signals: before }), 'a transition older than the verdict is not news');

  const elsewhere: WorldEvent[] = [
    { id: 'e2', kind: 'pr_opened', ref: 'pr:40', summary: 'opened', createdAt: '2026-07-28T11:00:00.000Z' },
  ];
  assert.ok(assayHold(assay(), issue(), { signals: elsewhere }), 'another item is not this one');
});

test('there is no timer arm — a verdict the world has not moved on still stands', () => {
  const ancient = assay({ decidedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
  assert.ok(assayHold(ancient, issue()), 'age alone is not an answer, so it must not re-ask the question');
});

test('the signal query is bounded by item and time, and asks for nothing when nothing is refused', () => {
  assert.equal(assaySignalQuery([]), null);
  assert.equal(assaySignalQuery([assay({ verdict: 'workable' })]), null, 'a workable verdict holds nothing to expire');

  const q = assaySignalQuery([
    assay(),
    assay({ originRef: 'issue:20', decidedAt: '2026-07-01T00:00:00.000Z' }),
    assay({ originRef: 'issue:30', verdict: 'workable', decidedAt: '2020-01-01T00:00:00.000Z' }),
  ]);
  assert.deepEqual(q?.refs.sort(), ['issue:12', 'issue:20'], 'narrowed to the items actually carrying a refusal');
  assert.equal(q?.since, '2026-07-01T00:00:00.000Z', 'back to the oldest standing one, never a row count');
});

// -- the cockpit chip cannot disagree with the rule --------------------------

function pickupCtx(over: Partial<Parameters<typeof issuePickupStatus>[1]> = {}) {
  return {
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: DEFAULT_COOLDOWN,
    now: NOW,
    tasks: [],
    // The funnel has failed open, so pickup is reachable at all — every case here
    // is about the assay in front of it, not about the planner in front of that.
    recentDecisions: spentPlannerAttempts(12),
    openPrs: [],
    headroom: 3,
    paused: false,
    ...over,
  };
}

/**
 * The reason names *what happened*; the assayer's own words live on the
 * `IssueAssay` row beside it, which every surface that quotes them already reads
 * (the World panel's chip title, the Goal Floor's plate). They used to be folded
 * into this string as well, which made it the longest thing the cockpit renders —
 * a paragraph and an ISO timestamp inside a chip built to be scanned.
 */
test('the chip reports the hold, and leaves the assayer’s words to the row', () => {
  const status = issuePickupStatus(issue(), pickupCtx({ assays: [assay()] }));
  assert.equal(status.eligible, false);
  assert.equal(status.status, 'assay');
  assert.equal(status.reasons[0], 'the goal assay could not act on this goal');
  assert.doesNotMatch(status.reasons[0] ?? '', /Better how\?/, 'the verdict’s prose is not a reason');
  // Still one hover away, and from the record rather than from a rendered string.
  assert.match(assay().summary, /Better how\?/);
});

test('the chip reports the pending case too, so a waiting issue is not an idle fleet', () => {
  assert.equal(issuePickupStatus(issue(), pickupCtx()).reasons[0], 'awaiting a goal assay');
  const running = issuePickupStatus(
    issue(),
    pickupCtx({ tasks: [task({ originRef: 'issue:12:assay', status: 'running' })] }),
  );
  assert.equal(running.reasons[0], 'a goal assay is running');
});

test('the chip says eligible exactly when the rule would dispatch — cap spent, and off', () => {
  const capped = issuePickupStatus(
    issue(),
    pickupCtx({
      recentDecisions: [...spentPlannerAttempts(12), ...spentCap('issue:12:assay', 'assay/issue/12')],
    }),
  );
  assert.equal(capped.status, 'eligible', 'the fail-open is reported as the pickup it actually becomes');
});

test('an unwatched issue is reported as unwatched, never as awaiting an assay it will never get', () => {
  const status = issuePickupStatus(
    issue(),
    pickupCtx({ policy: { priorityLabels: {}, defaultPriority: 0, watchLabel: 'agent-ready' } }),
  );
  assert.equal(status.status, 'unwatched');
});

// -- the tool, through the same dispatch an agent's bridge reaches ------------

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-assay-'));
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

function spawnAgent(system: System, originRef: string, over: Partial<Task> = {}): Agent {
  const t = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'assay/issue/12',
    originRef,
    originTitle: issue().title,
    originSummary: issue().body,
    ...over,
  });
  return system.agents.spawn(t, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('assay_issue is advertised under its name in the allow-list', () => {
  assert.ok(MCP_TOOL_NAMES.includes('assay_issue'), 'a tool missing from names.ts connects but is never callable');
});

test('a verdict is attributed from the credential and fingerprinted off the text that was judged', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:assay');
  const res = await callTool(system, agent, 'assay_issue', {
    status: 'unclear',
    summary: 'Better how? Name the measure and I can start.',
  });
  assert.equal(res.isError, false);

  const stored = system.store.getAssay('issue:12');
  assert.equal(stored?.by, 'assayer');
  assert.equal(stored?.agentId, agent.id, 'attribution is structural — the tool takes no issue argument');
  assert.equal(
    stored?.goalRef,
    goalFingerprint(issue().title, issue().body),
    'taken off the task, so an edit mid-run is not swallowed',
  );
  assert.match(res.text, /not closed|nothing is rejected/i, 'the agent must not believe it rejected the ticket');
  system.store.close?.();
});

test('a verdict cast against text the ticket no longer has holds nothing', async () => {
  const system = build();
  // The issue was edited while the assayer was running: the fingerprint is of what
  // it read, so the hold simply does not apply to what is there now.
  const agent = spawnAgent(system, 'issue:12:assay', { originSummary: 'the old wording' });
  await callTool(system, agent, 'assay_issue', { status: 'unclear', summary: 'no measure here' });
  const stored = system.store.getAssay('issue:12');
  assert.ok(stored);
  assert.equal(assayHold(stored, issue()), null);
  system.store.close?.();
});

test('an agent doing the work cannot assay it, and is pointed at what it can do', async () => {
  const system = build();
  for (const origin of ['issue:12', 'issue:12:plan', 'issue:12:part:schema']) {
    const agent = spawnAgent(system, origin);
    const res = await callTool(system, agent, 'assay_issue', { status: 'unclear', summary: 'I do not get it' });
    assert.equal(res.isError, true, `${origin} has answered the question by starting`);
  }
  const refusal = assayerOrigin('issue:12');
  assert.equal(refusal.ok, false);
  assert.match(refusal.ok ? '' : refusal.error, /escalate/, 'an agent in the work is sent to a human, not to a park');
  assert.equal(system.store.getAssay('issue:12'), null, 'and nothing is written');
  system.store.close?.();
});

test('the assessor and the assayer are pointed at each other’s tools, not silently scoped', async () => {
  const system = build();
  const assaying = spawnAgent(system, 'issue:12:assay');
  const assess = await callTool(system, assaying, 'assess_issue', { status: 'delivered', summary: 'x' });
  assert.equal(assess.isError, true);
  assert.match(assess.text, /assay_issue/);

  const work = await callTool(system, assaying, 'conclude_work', { status: 'done', note: 'x' });
  assert.equal(work.isError, true);
  assert.match(work.text, /assay_issue/);
  system.store.close?.();
});

test('a rejected assay writes nothing', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:assay');
  assert.equal((await callTool(system, agent, 'assay_issue', { status: 'unclear', summary: ' ' })).isError, true);
  assert.equal((await callTool(system, agent, 'assay_issue', { status: 'vague', summary: 'x' })).isError, true);
  assert.equal(system.store.getAssay('issue:12'), null);
  system.store.close?.();
});

// -- the store ---------------------------------------------------------------

test('a re-assay keeps the instant world signal is measured against', () => {
  const system = build();
  const first = system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'a',
    goalRef: 'aaaa',
    by: 'assayer',
  });
  const second = system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'b',
    goalRef: 'aaaa',
    by: 'assayer',
  });
  assert.equal(second.decidedAt, first.decidedAt, 'refreshing it would keep moving the goalposts a signal must clear');
  assert.equal(system.store.listAssays().length, 1, 'one row per issue — a standing verdict is a lookup');
  assert.equal(system.store.clearAssay('issue:12'), true);
  assert.equal(system.store.getAssay('issue:12'), null, 'and "not assayed" has exactly one representation');
  system.store.close?.();
});

test('a verdict about new text gets a new comment rather than overwriting the old question', () => {
  const system = build();
  system.store.recordAssay({ originRef: 'issue:12', verdict: 'unclear', summary: 'a', goalRef: 'aaaa', by: 'assayer' });
  system.store.setAssayComment('issue:12', 'c_1');
  assert.equal(system.store.getAssay('issue:12')?.commentRef, 'c_1');

  const same = system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'a, restated',
    goalRef: 'aaaa',
    by: 'assayer',
  });
  assert.equal(same.commentRef, 'c_1', 'the same question, edited in place');

  const fresh = system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'now a different question',
    goalRef: 'bbbb',
    by: 'assayer',
  });
  assert.equal(fresh.commentRef, null);
  system.store.close?.();
});

// -- the comment: what the person who wrote the ticket sees ------------------

/** A sink that records comment writes and hands back a stable ref. */
function commentSink(): { sink: ActionSink; writes: { number: number; body: string; commentRef?: string | null }[] } {
  const writes: { number: number; body: string; commentRef?: string | null }[] = [];
  const sink = {
    upsertIssueComment: async (input: { number: number; body: string; commentRef?: string | null }) => {
      writes.push(input);
      return { ok: true as const, ref: 'c_1' };
    },
  } as unknown as ActionSink;
  return { sink, writes };
}

function world(over: Partial<Issue> = {}): WorldSnapshot {
  return { takenAt: NOW, pullRequests: [], issues: [issue(over)] };
}

test('a refused goal asks its question on the ticket, once, and edits it thereafter', async () => {
  const system = build();
  const { sink, writes } = commentSink();
  const desk = new AssayDesk({ store: system.store, sink });
  system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'Better how? Name the measure.',
    goalRef: goalFingerprint(issue().title, issue().body),
    by: 'assayer',
  });

  await desk.announce(world(), []);
  assert.equal(writes.length, 1, 'the question is asked');
  assert.equal(writes[0]?.commentRef, null, 'the first write creates it');
  assert.match(writes[0]?.body ?? '', /Name the measure/);
  assert.match(writes[0]?.body ?? '', /Nothing has been rejected/, 'a question, not a refusal');
  assert.equal(system.store.getAssay('issue:12')?.commentRef, 'c_1', 'and the ref is kept, so the next write edits');

  await desk.announce(world(), []);
  assert.equal(writes.length, 1, 'nothing changed, so nothing is said again — the thread is not a stream');
  system.store.close?.();
});

test('a hold that ended is retracted on the thread, not left standing', async () => {
  const system = build();
  const { sink, writes } = commentSink();
  const desk = new AssayDesk({ store: system.store, sink });
  system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'no measure here',
    goalRef: goalFingerprint(issue().title, issue().body),
    by: 'assayer',
  });
  await desk.announce(world(), []);

  await desk.announce(world({ body: 'p99 of /search under 200ms' }), []);
  assert.equal(writes.length, 2);
  assert.match(writes[1]?.body ?? '', /No longer waiting/, 'leaving the question up makes people distrust a bot');
  assert.equal(writes[1]?.commentRef, 'c_1', 'edited in place');
  system.store.close?.();
});

test('nothing is said for a workable verdict', async () => {
  const system = build();
  const { sink, writes } = commentSink();
  system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'make the search endpoint faster',
    goalRef: goalFingerprint(issue().title, issue().body),
    by: 'assayer',
  });
  await new AssayDesk({ store: system.store, sink }).announce(world(), []);
  assert.deepEqual(writes, [], 'a yes is not news for the ticket');
  system.store.close?.();
});

test('the comment body is pure, and a multi-line summary stays inside its quote', () => {
  const body = renderAssayComment(assay({ summary: 'line one\nline two' }), true);
  assert.match(body, /<!-- lubbdubb:assay -->/, 'identified as the harness’s, for anyone reading cold');
  assert.match(body, /> line one\n> line two/);
});

// -- the operator's escape hatch ---------------------------------------------

test('an operator verdict is a first-class one, and clearing it is a delete', () => {
  const system = build();
  const i = issue();
  system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'I want the reporter to say what they mean',
    goalRef: goalFingerprint(i.title, i.body),
    by: 'operator',
  });
  const held = assayHold(system.store.getAssay('issue:12'), i);
  assert.match(held ?? '', /^you could not act on this goal/, 'attributed to the operator, not to an agent');

  system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'work it anyway',
    goalRef: goalFingerprint(i.title, i.body),
    by: 'operator',
  });
  assert.equal(assayHold(system.store.getAssay('issue:12'), i), null, 'the override releases it with no clearing step');
  system.store.close?.();
});

// -- the cockpit's half ------------------------------------------------------

test('/api/state ships the verdict beside the pickup reason, not inside it', async () => {
  const { buildStateSnapshot } = await import('../src/server/stateSnapshot.js');
  const system = build();
  system.connector.inject({
    kind: 'new_issue',
    number: 12,
    title: 'Make it better',
    body: 'the thing should be better',
  });
  system.store.setWorldBaseline(await system.connector.getState());

  // Nothing assayed: **null**, and that is a third reading rather than a synonym
  // for `workable`. The Goal Floor draws no drill at all for it, where a refusal
  // draws one that is stopped and says why — telling those apart by reading
  // `pickup.reasons[0]` is what `signalPolarity` refuses to do.
  const untouched = buildStateSnapshot(system);
  assert.equal(untouched.world.issues.find((i) => i.number === 12)!.assay, null);

  const i = untouched.world.issues.find((x) => x.number === 12)!;
  system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'unclear',
    summary: 'Name one behaviour that is wrong today.',
    goalRef: goalFingerprint(i.title, i.body),
    by: 'assayer',
  });
  const refused = buildStateSnapshot(system);
  const shipped = refused.world.issues.find((x) => x.number === 12)!.assay!;
  assert.equal(shipped.verdict, 'unclear');
  assert.equal(shipped.summary, 'Name one behaviour that is wrong today.');
  assert.equal(shipped.by, 'assayer');
  // The fingerprint is what the hold is measured against, not a reading, so it
  // does not go on the wire — and now it *cannot*, since the shipped shape is the
  // declared one rather than whatever a local cast happened to name.
  assert.equal('goalRef' in shipped, false);
  system.store.close?.();
});
