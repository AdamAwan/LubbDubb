import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DISPATCH_RULES } from '../src/dispatcher/rules.js';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { buildDesktopTools } from '../src/mcp/desktopTools.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import {
  featureSequenceKey,
  featureSequenceSubmitOrigin,
  findCycle,
  sequenceableFeatures,
  validateSequenceSubmission,
} from '../src/sequence/sequence.js';
import { linkEdges } from '../src/sequence/readiness.js';
import { heldByAccepting, waitingOnThis, waitsOn, waveOf, wavesOf } from '../web/src/view/sequence.js';
import { pastTheFunnel } from './support/plans.js';
import { sequenceBriefing } from '../src/sequence/dossier.js';
import type { DispatchContext, QueueItem } from '../src/dispatcher/dispatcher.js';
import type { FeatureSequence, FeatureSequenceEdge, Issue, IssueRelative } from '../src/types.js';

// Stage 1 of story sequencing: the record, the sequencer and the hold an accepted
// order puts on work. → `docs/spec/33-story-sequencing.md`

const NOW = '2026-09-04T12:00:00.000Z';

const FEATURE: IssueRelative = {
  number: 500,
  title: 'Post-deploy watch windows',
  issueType: 'Feature',
  workItemState: 'Active',
  state: 'open',
  body: 'Watch what a deploy does to the things that were meant to stop happening.',
};

function story(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Story ${number}`,
    body: 'do the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    issueType: 'User Story',
    parent: FEATURE,
    ...over,
  };
}

const everything = (): boolean => true;

function features(issues: Issue[], max = 40) {
  return sequenceableFeatures(issues, ['Feature', 'Epic'], everything, max);
}

function ctx(issues: Issue[], over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 5,
    ...over,
  };
}

function queued(upcoming: QueueItem[] | undefined, origin: string): QueueItem | undefined {
  return upcoming?.find((q) => q.origin === origin);
}

/** The gate at its only level that runs an agent. */
function full(): RuleDispatcher {
  return new RuleDispatcher({ sequencing: 'full' });
}

function sequence(over: Partial<FeatureSequence> = {}): FeatureSequence {
  return {
    originRef: 'issue:500',
    status: 'accepted',
    reason: 'the table has to exist before anything reads it',
    unsure: null,
    standingKey: 'k',
    edges: [{ issue: 12, dependsOn: 11, source: 'inferred', reason: 'reads the table #11 writes' }],
    answeredBy: 'adam',
    answeredAt: NOW,
    agentId: 'a1',
    taskId: 't1',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

// -- the key: membership, never movement -------------------------------------

test('the key changes when a story is added', () => {
  const before = features([story(11), story(12)])[0]!.key;
  const after = features([story(11), story(12), story(13)])[0]!.key;
  assert.notEqual(before, after);
});

test('the key does not change when a story merges', () => {
  // The whole difference from the summary's key. Re-proposing an order every time a
  // child landed would ask an operator to re-accept the same sequence eight times.
  const before = features([story(11), story(12), story(13)])[0]!.key;
  const after = features([story(11, { state: 'closed' }), story(12), story(13)])[0]!.key;
  assert.equal(before, after);
});

test('the key changes when the board gains a Predecessor link', () => {
  // What was accepted was an order over a set of statements, and the statements
  // have changed — so the operator is asked again rather than held to an order
  // written before the team said anything.
  const before = features([story(11), story(12)])[0]!.key;
  const after = features([story(11), story(12, { dependsOn: [{ ...FEATURE, number: 11 }] })])[0]!.key;
  assert.notEqual(before, after);
});

test('the key is order-independent', () => {
  assert.equal(featureSequenceKey([11, 12], []), featureSequenceKey([12, 11], []));
});

// -- what is worth asking about ----------------------------------------------

test('a Feature with one story is not sequenced — there is no order to write', () => {
  assert.deepEqual(features([story(11)]), []);
});

test('a Feature above the cap is not sequenced, and keeps the ordering it had', () => {
  const stories = Array.from({ length: 6 }, (_, i) => story(11 + i));
  assert.equal(features(stories, 5).length, 0);
  assert.equal(features(stories, 6).length, 1);
});

test('a story with no parent belongs to no Feature', () => {
  assert.deepEqual(features([story(11, { parent: null }), story(12, { parent: null })]), []);
});

// -- cycles are refused at ingestion -----------------------------------------

test('a cycle is found and named', () => {
  const cycle = findCycle([
    { issue: 11, dependsOn: 12 },
    { issue: 12, dependsOn: 13 },
    { issue: 13, dependsOn: 11 },
  ]);
  assert.ok(cycle);
  assert.equal(cycle[0], cycle[cycle.length - 1], 'it comes back as a closed walk');
  assert.deepEqual([...cycle].sort(), [11, 11, 12, 13]);
});

test('a rejoin is not a cycle', () => {
  // Two stories waiting on one, and a fourth waiting on both, is an ordinary shape.
  assert.equal(
    findCycle([
      { issue: 12, dependsOn: 11 },
      { issue: 13, dependsOn: 11 },
      { issue: 14, dependsOn: 12 },
      { issue: 14, dependsOn: 13 },
    ]),
    null,
  );
});

test('a submitted cycle is refused, naming it, and nothing is stored', () => {
  const result = validateSequenceSubmission(
    {
      reason: 'they need each other',
      order: [
        { issue: 11, waitsOn: [12], why: 'a' },
        { issue: 12, waitsOn: [11], why: 'b' },
      ],
    },
    [11, 12],
  );
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /cycle/);
  assert.match(result.ok ? '' : result.error, /#11/);
});

test('an order naming a story the Feature does not have is refused', () => {
  const result = validateSequenceSubmission({ reason: 'r', order: [{ issue: 12, waitsOn: [99], why: 'a' }] }, [11, 12]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /#99/);
});

test('a self-edge is refused rather than stored', () => {
  const result = validateSequenceSubmission({ reason: 'r', order: [{ issue: 12, waitsOn: [12], why: 'a' }] }, [12]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /cannot wait on itself/);
});

test('an empty order is a real answer, not a rejected one', () => {
  const result = validateSequenceSubmission({ reason: 'these look independent', order: [] }, [11, 12]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.submission.edges : null, []);
});

test('a submission with no reason is refused — an order nobody can argue with', () => {
  const result = validateSequenceSubmission({ order: [] }, [11, 12]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /reason is required/);
});

test('every edge is marked inferred, whatever the agent says', () => {
  const result = validateSequenceSubmission(
    { reason: 'r', order: [{ issue: 12, waitsOn: [11], why: 'reads the table', source: 'link' }] },
    [11, 12],
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.submission.edges[0]!.source : null, 'inferred');
});

// -- the fence ---------------------------------------------------------------

test('only the agent dispatched to sequence a Feature may write its order', () => {
  assert.equal(featureSequenceSubmitOrigin('issue:500:sequence').ok, true);
  for (const origin of ['issue:500', 'issue:500:plan', 'issue:500:summary', null]) {
    const refused = featureSequenceSubmitOrigin(origin);
    assert.equal(refused.ok, false, `${origin} is refused`);
    assert.match(refused.ok ? '' : refused.error, /sequence_submit is only for/);
  }
});

// -- the rule ----------------------------------------------------------------

test('a Feature with no order gets a sequencer', async () => {
  const { upcoming, actions } = await full().decide(ctx([story(11), story(12)]));
  const row = queued(upcoming, 'issue:500:sequence');
  assert.ok(row);
  assert.equal(row.rule, 'feature-sequence');
  assert.equal(row.kind, 'desk');
  assert.equal(row.branch, null, 'no branch and no worktree — it writes no files');
  const dispatch = actions.find((a) => a.type === 'dispatch_desk_agent' && a.originRef === 'issue:500:sequence');
  assert.ok(dispatch, 'the sequencer goes out as a desk agent');
});

test('a Feature whose order was written against this membership gets nothing', async () => {
  const issues = [story(11), story(12)];
  const key = features(issues)[0]!.key;
  const { upcoming } = await full().decide(ctx(issues, { featureSequences: [sequence({ standingKey: key })] }));
  assert.equal(queued(upcoming, 'issue:500:sequence'), undefined);
});

test('a declined order is an answer, and holds the sequencer off', async () => {
  // A proposal that came back on the next pulse would make the fleet argue with the
  // operator once a Feature until they gave in.
  const issues = [story(11), story(12)];
  const key = features(issues)[0]!.key;
  const { upcoming } = await full().decide(
    ctx(issues, { featureSequences: [sequence({ status: 'declined', standingKey: key })] }),
  );
  assert.equal(queued(upcoming, 'issue:500:sequence'), undefined);
});

test('a declined order stops holding it off once the Feature gains a story', async () => {
  const issues = [story(11), story(12)];
  const key = features(issues)[0]!.key;
  const { upcoming } = await full().decide(
    ctx([...issues, story(13)], { featureSequences: [sequence({ status: 'declined', standingKey: key })] }),
  );
  assert.ok(queued(upcoming, 'issue:500:sequence'), 'the thing declined was an order over a set, and the set moved');
});

test('links alone runs no sequencer — every edge there was drawn by a person', async () => {
  const { upcoming } = await new RuleDispatcher({ sequencing: 'links' }).decide(ctx([story(11), story(12)]));
  assert.equal(queued(upcoming, 'issue:500:sequence'), undefined);
});

test('off runs no sequencer either, which is the default', async () => {
  const { upcoming } = await new RuleDispatcher().decide(ctx([story(11), story(12)]));
  assert.equal(queued(upcoming, 'issue:500:sequence'), undefined);
});

test('the rule is in the registry and names itself', () => {
  assert.ok('feature-sequence' in DISPATCH_RULES);
  assert.equal(DISPATCH_RULES['feature-sequence'].kind, 'rule');
});

// -- an accepted order holds work --------------------------------------------

test('an accepted order holds the story it puts second', async () => {
  const issues = [story(11), story(12)];
  const { upcoming } = await full().decide(
    ctx(issues, { featureSequences: [sequence()], recentDecisions: pastTheFunnelFor(issues) }),
  );
  const held = queued(upcoming, 'issue:12');
  assert.equal(held?.status, 'sequenced');
  assert.match(held?.reason ?? '', /waits on #11/);
  assert.equal(queued(upcoming, 'issue:11')?.status, 'dispatching');
});

test('a proposed order holds nothing — nobody has answered it', async () => {
  const issues = [story(11), story(12)];
  const { upcoming } = await full().decide(
    ctx(issues, {
      featureSequences: [sequence({ status: 'proposed', answeredBy: null, answeredAt: null })],
      recentDecisions: pastTheFunnelFor(issues),
    }),
  );
  assert.equal(queued(upcoming, 'issue:12')?.status, 'dispatching');
});

test('a declined order holds nothing', async () => {
  const issues = [story(11), story(12)];
  const { upcoming } = await full().decide(
    ctx(issues, { featureSequences: [sequence({ status: 'declined' })], recentDecisions: pastTheFunnelFor(issues) }),
  );
  assert.equal(queued(upcoming, 'issue:12')?.status, 'dispatching');
});

// -- the record --------------------------------------------------------------

test('an order is written as a set, never merged', () => {
  const store = new Store(':memory:');
  store.recordFeatureSequence({
    originRef: 'issue:500',
    status: 'proposed',
    reason: 'first',
    unsure: null,
    standingKey: 'k1',
    edges: [
      { issue: 12, dependsOn: 11, source: 'inferred', reason: 'a' },
      { issue: 13, dependsOn: 12, source: 'inferred', reason: 'b' },
    ],
    agentId: 'a1',
    taskId: 't1',
  });
  const first = store.listFeatureSequences()[0]!;
  const answered = store.answerFeatureSequence('issue:500', 'accepted', 'adam');
  assert.equal(answered?.status, 'accepted');
  assert.equal(answered?.answeredBy, 'adam');

  store.recordFeatureSequence({
    originRef: 'issue:500',
    status: 'proposed',
    reason: 'second',
    unsure: 'the 13 → 12 edge',
    standingKey: 'k2',
    edges: [{ issue: 12, dependsOn: 11, source: 'inferred', reason: 'a' }],
    agentId: 'a2',
    taskId: 't2',
  });
  const second = store.listFeatureSequences()[0]!;
  assert.equal(second.edges.length, 1, 'the dropped edge is gone, not left behind');
  assert.equal(second.status, 'proposed');
  assert.equal(second.answeredBy, null, 'a new order over a different set is a new question');
  assert.equal(second.createdAt, first.createdAt, 'when it was first sequenced survives');
});

test('answering a Feature with no order is a refusal, not a row conjured to hold it', () => {
  const store = new Store(':memory:');
  assert.equal(store.answerFeatureSequence('issue:500', 'accepted', 'adam'), null);
});

// -- the dossier -------------------------------------------------------------

test('the sequencer is shown the Feature and every open story under it', () => {
  const brief = sequenceBriefing('issue:500:sequence', [story(11), story(12), story(13, { state: 'closed' })]);
  assert.ok(brief);
  assert.match(brief, /Post-deploy watch windows/);
  assert.match(brief, /#11/);
  assert.match(brief, /#12/);
  assert.ok(!brief.includes('#13'), 'a settled story is not one to order');
});

test('a link the board already states is drawn as the board’s own', () => {
  const brief = sequenceBriefing('issue:500:sequence', [
    story(11),
    story(12, { dependsOn: [{ ...FEATURE, number: 11 }] }),
  ]);
  assert.match(brief ?? '', /The board already states/);
});

test('nothing is appended for a caller that is not a sequencer', () => {
  assert.equal(sequenceBriefing('issue:12', [story(11), story(12)]), null);
});

/** Past the appraisal and the planner, so what is left in front of a story is the order. */
function pastTheFunnelFor(issues: Issue[]) {
  return issues.flatMap((i) => pastTheFunnel(i.number));
}

// One edge the provider states is read straight off the issue, with no record at all.
test('the tracker’s own links need no sequence row', () => {
  assert.deepEqual(linkEdges([story(11), story(12, { dependsOn: [{ ...FEATURE, number: 11 }] })]), [
    { issue: 12, dependsOn: 11 },
  ]);
});

// -- the cockpit's own derivation --------------------------------------------

test('a wave is longest path, so a story never draws above what it waits on', () => {
  // The rejoin: #14 waits on #12 and #13, and #12 waits on #11. Taking the first
  // prerequisite listed would put #14 in wave 2 — above #12, which it waits on.
  const edges: FeatureSequenceEdge[] = [
    { issue: 12, dependsOn: 11, source: 'inferred', reason: null },
    { issue: 14, dependsOn: 13, source: 'inferred', reason: null },
    { issue: 14, dependsOn: 12, source: 'inferred', reason: null },
  ];
  assert.equal(waveOf(11, edges), 0);
  assert.equal(waveOf(13, edges), 0);
  assert.equal(waveOf(12, edges), 1);
  assert.equal(waveOf(14, edges), 2);
});

test('every story lands in exactly one wave, whether or not the order mentions it', () => {
  const edges: FeatureSequenceEdge[] = [{ issue: 12, dependsOn: 11, source: 'inferred', reason: null }];
  const waves = wavesOf([11, 12, 99], edges);
  assert.deepEqual(
    waves.map((w) => w.issues),
    [[11, 99], [12]],
    'a story with no edge waits on nothing and is in the first wave',
  );
});

test('the two sides of a story are direct, never transitive', () => {
  // "2 waiting on this" has to be a number the card in front of the operator adds
  // up to; a transitive count is one nothing on the page shows.
  const edges: FeatureSequenceEdge[] = [
    { issue: 12, dependsOn: 11, source: 'inferred', reason: null },
    { issue: 13, dependsOn: 12, source: 'inferred', reason: null },
  ];
  assert.deepEqual(waitingOnThis(11, edges), [12]);
  assert.deepEqual(waitsOn(12, edges), [11]);
  assert.deepEqual(waitsOn(11, edges), []);
});

test('what accepting costs counts only stories still open', () => {
  const edges: FeatureSequenceEdge[] = [{ issue: 12, dependsOn: 11, source: 'inferred', reason: null }];
  assert.equal(heldByAccepting([11, 12], edges), 1);
  // #11 has merged and is no longer in the list: accepting now holds nothing.
  assert.equal(heldByAccepting([12], edges), 0);
});

test('a cycle in a stored order does not spin the display', () => {
  // Ingestion refuses cycles, but this runs against whatever the payload carries.
  const edges: FeatureSequenceEdge[] = [
    { issue: 11, dependsOn: 12, source: 'inferred', reason: null },
    { issue: 12, dependsOn: 11, source: 'inferred', reason: null },
  ];
  assert.equal(typeof waveOf(11, edges), 'number');
});

// -- the desktop channel: an order is amended by talking to Claude Code -------

/**
 * The two desktop tools, driven through `buildDesktopTools` with a world baseline
 * written straight into the store — the one seam that lets a hierarchy be scripted
 * without a provider that reports one.
 */
function desktopDeck(): {
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  store: Store;
} {
  const store = new Store(':memory:');
  store.setWorldBaseline({
    takenAt: NOW,
    pullRequests: [],
    issues: [story(11), story(12), story(13)],
  });
  const deps = {
    store,
    briefConfig: () => loadConfig({ dbPath: ':memory:', issueSequencing: 'full' }),
  } as unknown as Parameters<typeof buildDesktopTools>[0];
  const tools = buildDesktopTools(deps, { label: 'adam', held: null });
  return {
    store,
    call: async (name, args) => {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is on the desktop channel`);
      const result = await tool.handler(args);
      return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
    },
  };
}

test('both sequence tools are on the desktop channel and neither is on the fleet’s', () => {
  for (const name of ['sequence_read', 'sequence_amend']) {
    assert.ok(DESKTOP_TOOL_NAMES.includes(name as never), `${name} is a desktop tool`);
    assert.ok(!MCP_TOOL_NAMES.includes(name as never), `${name} is not one the fleet can call`);
  }
  // The one the fleet gets, and it is the other way round.
  assert.ok(MCP_TOOL_NAMES.includes('sequence_submit'));
  assert.ok(!DESKTOP_TOOL_NAMES.includes('sequence_submit' as never));
});

test('a story number resolves to the Feature it hangs off', async () => {
  const deck = desktopDeck();
  const read = await deck.call('sequence_read', { issue: 12 });
  const json = JSON.parse(read.text as string) as { feature: number; order: unknown };
  assert.equal(json.feature, 500, 'an order is a statement about a Feature, not about one of its stories');
  assert.equal(json.order, null);
});

test('an amendment lands accepted, marked as the operator’s own', async () => {
  const deck = desktopDeck();
  const done = await deck.call('sequence_amend', {
    issue: 500,
    reason: 'the schema in #11 is what #12 and #13 both read',
    order: [
      { issue: 12, waitsOn: [11], why: 'reads the table' },
      { issue: 13, waitsOn: [11], why: 'reads the table' },
    ],
  });
  assert.equal(done.isError, false, done.text as string);
  const stored = deck.store.getFeatureSequence('issue:500');
  assert.equal(stored?.status, 'accepted', 'the person making it is the person who would have accepted it');
  assert.equal(stored?.answeredBy, 'adam');
  assert.deepEqual(
    stored?.edges.map((e) => e.source),
    ['operator', 'operator'],
    'never `inferred` — no agent guessed these',
  );
});

test('an empty amendment releases the order rather than being refused', async () => {
  const deck = desktopDeck();
  await deck.call('sequence_amend', {
    issue: 500,
    reason: 'first pass',
    order: [{ issue: 12, waitsOn: [11], why: 'reads the table' }],
  });
  const done = await deck.call('sequence_amend', { issue: 500, reason: 'they are independent after all', order: [] });
  assert.equal(done.isError, false, done.text as string);
  assert.deepEqual(deck.store.getFeatureSequence('issue:500')?.edges, []);
});

test('an amendment naming a story the Feature does not have is refused', async () => {
  const deck = desktopDeck();
  const done = await deck.call('sequence_amend', {
    issue: 500,
    reason: 'r',
    order: [{ issue: 12, waitsOn: [999], why: 'a' }],
  });
  assert.equal(done.isError, true);
  assert.match(done.text as string, /#999/);
});

test('a Feature the harness can see no stories under is refused, and says why', async () => {
  const deck = desktopDeck();
  const done = await deck.call('sequence_read', { issue: 4242 });
  assert.equal(done.isError, true);
  assert.match(done.text as string, /no stories under it/);
});
