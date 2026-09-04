import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { linkEdges, sequenceHoldReason, sequenceReadiness } from '../src/sequence/readiness.js';
import type { DispatchContext, QueueItem } from '../src/dispatcher/dispatcher.js';
import type { Issue, IssueRelative, PullRequest } from '../src/types.js';
import { pastTheFunnel } from './support/plans.js';

// Story sequencing, stage 0: the order somebody already drew on their own board.
// → `docs/spec/33-story-sequencing.md`

const NOW = '2026-09-04T12:00:00.000Z';

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Story ${number}`,
    body: 'do the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

/** A predecessor as the provider carries it — a summary, never the item itself. */
function relative(number: number): IssueRelative {
  return { number, title: `Story ${number}`, issueType: 'User Story', workItemState: 'Active', state: 'open' };
}

function pr(number: number, branch: string): PullRequest {
  return { id: `p${number}`, number, title: 'X', branch, ciStatus: 'passing', unresolvedComments: [] };
}

function ctx(issues: Issue[], over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    // Both stories are past the appraisal and the planner, so what is left in
    // front of them is the sequence and nothing else.
    recentDecisions: issues.flatMap((i) => pastTheFunnel(i.number)),
    agentHeadroom: 5,
    ...over,
  };
}

function queued(upcoming: QueueItem[] | undefined, origin: string): QueueItem | undefined {
  return upcoming?.find((q) => q.origin === origin);
}

/** The gate on, honouring the tracker's own links and inferring nothing. */
function linksOn(): RuleDispatcher {
  return new RuleDispatcher({ sequencing: 'links' });
}

// -- the edges ---------------------------------------------------------------

test('a provider that reports no dependencies contributes no edges', () => {
  assert.deepEqual(linkEdges([issue(11), issue(12)]), []);
});

test('an item that waits on nothing is not the same statement as a tracker that says nothing', () => {
  // Both produce no edge, and that is the point: the distinction is carried on
  // `Issue.dependsOn` for readers that need it, and costs the gate nothing.
  assert.deepEqual(linkEdges([issue(12, { dependsOn: [] })]), []);
});

test('a self-edge is dropped rather than holding its own story for good', () => {
  assert.deepEqual(linkEdges([issue(12, { dependsOn: [relative(12), relative(11)] })]), [{ issue: 12, dependsOn: 11 }]);
});

// -- readiness ---------------------------------------------------------------

test('a story waits on a predecessor that is open and has pushed nothing', () => {
  const issues = [issue(11), issue(12, { dependsOn: [relative(11)] })];
  const waits = sequenceReadiness(linkEdges(issues), { issues, openPrs: [] });
  assert.deepEqual(waits.get(12), [11]);
  assert.equal(waits.get(11), undefined, 'the story nothing waits behind is not held');
});

test('a predecessor in flight satisfies the edge the moment it has a branch — not a merge', () => {
  // Waiting for the merge would serialise a feature into a queue of one; waiting
  // for a branch is what lets the successor stack on work already underway.
  const issues = [issue(11), issue(12, { dependsOn: [relative(11)] })];
  const waits = sequenceReadiness(linkEdges(issues), { issues, openPrs: [pr(7, 'issue/11')] });
  assert.equal(waits.get(12), undefined);
});

test('a settled predecessor satisfies the edge', () => {
  const issues = [issue(11, { state: 'closed' }), issue(12, { dependsOn: [relative(11)] })];
  assert.equal(sequenceReadiness(linkEdges(issues), { issues, openPrs: [] }).get(12), undefined);
});

test('an edge naming an issue the world does not hold is ignored, never a hold', () => {
  // A story invisible for a pulse is not a story that has gone, and a hold that
  // outlived its reason would park a Feature with nothing red.
  const issues = [issue(12, { dependsOn: [relative(11)] })];
  assert.equal(sequenceReadiness(linkEdges(issues), { issues, openPrs: [] }).get(12), undefined);
});

test('a story waiting on several names all of them, in order, once each', () => {
  const issues = [issue(9), issue(11), issue(12, { dependsOn: [relative(11), relative(9), relative(11)] })];
  assert.deepEqual(sequenceReadiness(linkEdges(issues), { issues, openPrs: [] }).get(12), [9, 11]);
});

test('the held reason names what the story waits behind, not the mechanism', () => {
  assert.equal(sequenceHoldReason([593]), 'Held: waits on #593, which has not pushed a branch yet.');
  assert.match(sequenceHoldReason([593, 597]), /#593, #597, none of which/);
});

// -- the hold, at the dispatcher ---------------------------------------------

test('a held story is queued with its reason, not dropped', async () => {
  const issues = [issue(11), issue(12, { dependsOn: [relative(11)] })];
  const { upcoming, actions } = await linksOn().decide(ctx(issues));

  const held = queued(upcoming, 'issue:12');
  assert.ok(held, 'it is in Up next — a dispatch that silently never appears is one nobody can read');
  assert.equal(held.status, 'sequenced');
  assert.equal(held.rule, 'issue-pickup', 'attributed to the rule that proposed it, not to what held it');
  assert.match(held.reason, /waits on #11/);
  assert.ok(
    !actions.some((a) => a.type === 'dispatch_code_agent' && a.originRef === 'issue:12'),
    'and it does not go out',
  );
  assert.equal(queued(upcoming, 'issue:11')?.status, 'dispatching', 'the story it waits on does');
});

test('the same story dispatches once its predecessor has a branch, before any merge', async () => {
  const issues = [issue(11), issue(12, { dependsOn: [relative(11)] })];
  const { upcoming } = await linksOn().decide(
    ctx(issues, { world: { takenAt: NOW, pullRequests: [pr(7, 'issue/11')], issues } }),
  );
  assert.equal(queued(upcoming, 'issue:12')?.status, 'dispatching');
});

test('off is the default, and holds nothing', async () => {
  const issues = [issue(11), issue(12, { dependsOn: [relative(11)] })];
  const { upcoming } = await new RuleDispatcher().decide(ctx(issues));
  assert.equal(queued(upcoming, 'issue:12')?.status, 'dispatching');
});

test('a flagged goal is dispatched through the hold', async () => {
  // The operator naming one goal the priority is a standing instruction about
  // that goal, and it outranks an order the harness is enforcing on its behalf.
  const issues = [issue(11), issue(12, { dependsOn: [relative(11)] })];
  const { upcoming } = await linksOn().decide(ctx(issues, { goalPriorities: [{ originRef: 'issue:12', since: NOW }] }));
  assert.equal(queued(upcoming, 'issue:12')?.status, 'dispatching');
});

test('a dragged row is dispatched through the hold', async () => {
  // Dragging a held story to the top is the operator saying "go now". An override
  // that only re-ordered it would put the row at the top and still refuse it.
  const issues = [issue(11), issue(12, { dependsOn: [relative(11)] })];
  const { upcoming } = await linksOn().decide(ctx(issues, { priorityOverrides: [{ origin: 'issue:12', rank: 0 }] }));
  assert.equal(queued(upcoming, 'issue:12')?.status, 'dispatching');
});

test('a drag clears the sequence hold and nothing else', async () => {
  // Every other held reason is a statement about something other than the order.
  const issues = [issue(11), issue(12)];
  const { upcoming } = await new RuleDispatcher().decide(
    ctx(issues, { recentDecisions: [], priorityOverrides: [{ origin: 'issue:12:plan', rank: 0 }] }),
  );
  assert.equal(
    queued(upcoming, 'issue:12:plan')?.status,
    'superseded',
    'the appraisal still holds the planner it claimed this cycle',
  );
});

test('the planner is held by the order too, and says so rather than blaming a cooldown', async () => {
  // A decomposition written before the story it depends on has a branch is a
  // decomposition of a schema that does not exist yet.
  const issues = [issue(11), issue(12, { dependsOn: [relative(11)] })];
  const { upcoming } = await linksOn().decide(
    // Past the appraisal only, so the planner is the rule in front of this story.
    ctx(issues, { recentDecisions: issues.flatMap((i) => pastTheFunnel(i.number).slice(0, 3)) }),
  );
  const planner = queued(upcoming, 'issue:12:plan');
  assert.ok(planner);
  assert.equal(planner.status, 'sequenced');
  assert.match(planner.reason, /waits on #11/);
});
