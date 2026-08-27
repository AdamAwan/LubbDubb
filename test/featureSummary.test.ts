import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import {
  featureStandingKey,
  featureSummaryOrigin,
  featureSummarySubmitOrigin,
  validateFeatureSummary,
  type FeatureChildStandingFacts,
} from '../src/summaries/featureSummary.js';
import { buildFeatureBoard } from '../src/features/featureBoard.js';
import type { FeatureSummary, Task } from '../src/types.js';
import type { MirroredTicket } from '../src/store/tickets.js';
import { Store } from '../src/store/store.js';

// Rule `feature-summary` and the pure layer under it — what makes it fire, what
// makes it stand down for ever, and the one thing it must never see: prose.

const NOW = '2026-08-27T12:00:00.000Z';

function child(over: Partial<FeatureChildStandingFacts> = {}): FeatureChildStandingFacts {
  return {
    number: 1,
    state: 'open',
    workItemState: 'Doing',
    deliveredAt: null,
    shortfallAt: null,
    runningSince: null,
    landedAt: null,
    ...over,
  };
}

test('the standing key moves when an item moves and not when its text does', () => {
  const before = [child({ number: 1 }), child({ number: 2 })];
  // A title, a body or a label is not in the digest at all — there is nothing to
  // assert about them here, which is the point: they cannot reach it. What can is
  // the tracker's state, the verdicts, a run and a landing, and each moves it.
  assert.equal(featureStandingKey(before), featureStandingKey([child({ number: 2 }), child({ number: 1 })]));
  for (const moved of [
    child({ number: 2, state: 'closed' }),
    child({ number: 2, workItemState: 'In Review' }),
    child({ number: 2, deliveredAt: NOW }),
    child({ number: 2, shortfallAt: NOW }),
    child({ number: 2, runningSince: NOW }),
    child({ number: 2, landedAt: NOW }),
  ]) {
    assert.notEqual(featureStandingKey(before), featureStandingKey([child({ number: 1 }), moved]), 'a movement shows');
  }
  // An item appearing under the Feature is a movement too — the summary that did
  // not mention it is out of date the moment it is linked.
  assert.notEqual(featureStandingKey(before), featureStandingKey([...before, child({ number: 3 })]));
});

test('only the agent dispatched to summarise a Feature may write one', () => {
  const ok = featureSummarySubmitOrigin(featureSummaryOrigin(29857));
  assert.equal(ok.ok && ok.featureOrigin, 'issue:29857');
  assert.equal(ok.ok && ok.featureNumber, 29857);
  for (const origin of ['issue:29857', 'issue:29857:retro', 'pr:31827:ci', null]) {
    const refused = featureSummarySubmitOrigin(origin);
    assert.equal(refused.ok, false, `${String(origin)} is refused`);
    // Refused **by name and with the tool it actually wants** — a working agent
    // that reaches for this must be told where its own account goes, or it writes
    // nothing and nobody finds out.
    assert.match(refused.ok === false ? refused.error : '', /retro_submit|conclude_work/);
  }
});

test('a summary needs a lede and nothing else', () => {
  const empty = validateFeatureSummary({ usable: 'lots', blocked: 'nothing' });
  assert.equal(empty.ok, false);
  assert.match(empty.ok === false ? empty.error : '', /standing is required/);

  // The three sections are optional: a Feature with nothing usable, nothing
  // blocked and nothing left is an ordinary Feature, and the lede says so.
  const lean = validateFeatureSummary({ standing: 'Not started.' });
  assert.equal(lean.ok, true);
  assert.deepEqual(lean.ok && lean.input, {
    standing: 'Not started.',
    usable: null,
    blocked: null,
    remaining: null,
  });
  // Whitespace is not content: a section of spaces is an absent section, not an
  // empty heading on the card.
  const blank = validateFeatureSummary({ standing: 'Going.', usable: '   ' });
  assert.equal(blank.ok && blank.input.usable, null);

  // A section over the cap is **trimmed and said so**, never refused: the whole
  // submission must not sink over one long block, and an agent that was not told
  // has no way to find out.
  const long = validateFeatureSummary({ standing: 'Going.', remaining: 'x'.repeat(5_000) });
  assert.equal(long.ok, true);
  assert.equal(long.ok && long.trimmed, true);
  assert.ok(long.ok && (long.input.remaining?.length ?? 0) < 5_000);

  // The lede is refused rather than trimmed, and the refusal says where the rest
  // goes — half a lede is the whole of what the card draws.
  const shouted = validateFeatureSummary({ standing: 'x'.repeat(5_000) });
  assert.equal(shouted.ok, false);
  assert.match(shouted.ok === false ? shouted.error : '', /too long/);
});

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    featureStandings: [{ number: 29857, title: 'Wider matching', key: 'abc123' }],
    ...over,
  };
}

test('a Feature is summarised when it has moved, and never again until it does', async () => {
  const dispatcher = new RuleDispatcher();

  // Nothing on file: the first pulse after a Feature exists writes the first
  // account of it.
  const first = await dispatcher.decide(ctx());
  const dispatch = first.actions.find((a) => a.rule === 'feature-summary');
  assert.ok(dispatch, 'a Feature nobody has summarised gets one');
  assert.equal(dispatch.type, 'dispatch_desk_agent');
  assert.equal(dispatch.originRef, 'issue:29857:summary');
  // No branch and no worktree: it writes no files, and a checkout would only be a
  // temptation to start work on somebody's story.
  assert.equal('branch' in dispatch ? dispatch.branch : null, null);

  // The key on file matches what the children stand at: there is nothing to say,
  // and there will be nothing to say on every pulse from here until one moves.
  const settled = await dispatcher.decide(
    ctx({ featureSummaryKeys: [{ originRef: 'issue:29857', standingKey: 'abc123' }] }),
  );
  assert.equal(
    settled.actions.some((a) => a.rule === 'feature-summary'),
    false,
  );

  // A stale key is a movement, whatever moved.
  const moved = await dispatcher.decide(
    ctx({ featureSummaryKeys: [{ originRef: 'issue:29857', standingKey: 'older' }] }),
  );
  assert.ok(moved.actions.some((a) => a.rule === 'feature-summary'));
});

test('a summariser already on the Feature is not joined by a second', async () => {
  const live: Task = {
    id: 't1',
    kind: 'desk',
    title: 'Summarise feature #29857',
    prompt: 'say where it is',
    branch: null,
    originRef: 'issue:29857:summary',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const plan = await new RuleDispatcher().decide(ctx({ tasks: [live] }));
  assert.equal(
    plan.actions.some((a) => a.rule === 'feature-summary'),
    false,
    'the one in flight will read the standing again when it submits',
  );
});

test('nothing is summarised where the deployment has no feature board', async () => {
  // The absent-standings arm: no flag, or a tracker with no hierarchy. The whole
  // feature is off rather than dispatching against a digest nobody built.
  const plan = await new RuleDispatcher().decide(ctx({ featureStandings: undefined }));
  assert.equal(
    plan.actions.some((a) => a.rule === 'feature-summary'),
    false,
  );
});

function ticket(over: Partial<MirroredTicket> = {}): MirroredTicket {
  return {
    number: 35916,
    title: 'Turn a match bucket on or off per ORC',
    labels: [],
    state: 'open',
    url: null,
    createdAt: NOW,
    changedAt: NOW,
    firstSeenAt: NOW,
    tracking: 'live',
    workItemState: null,
    issueType: 'User Story',
    parent: { number: 29857, title: 'Wider matching' },
    lastReadAt: null,
    ...over,
  };
}

test('the board quotes the summary whole and composes nothing', () => {
  const summary: FeatureSummary = {
    originRef: 'issue:29857',
    standing: 'The main thing works and is on hallway. The per-ORC switch is stuck on a decision.',
    usable: 'On hallway, switching a customer over keeps their candidate pairs.',
    blocked: null,
    remaining: 'The bucket switch, and four items nobody is watching.',
    standingKey: 'abc123',
    agentId: 'a1',
    taskId: 't1',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const board = buildFeatureBoard({
    items: [ticket()],
    outcomes: new Map(),
    costs: new Map(),
    featureSlots: new Map(),
    running: new Map(),
    deliveries: [],
    shortfalls: [],
    escalations: [],
    reach: [],
    landings: [],
    environments: [],
    containerTypes: ['Feature'],
    watchLabel: 'lubbdubb-watch',
    summaries: new Map([['issue:29857', summary]]),
  });
  assert.deepEqual(board.features[0]?.summary, summary, 'quoted, never re-worded or re-derived');
  // A Feature with none ships null rather than a sentence assembled from the
  // counts — which would be the verdict this board exists to refuse, in an
  // agent's voice.
  const bare = buildFeatureBoard({
    items: [ticket()],
    outcomes: new Map(),
    costs: new Map(),
    featureSlots: new Map(),
    running: new Map(),
    deliveries: [],
    shortfalls: [],
    escalations: [],
    reach: [],
    landings: [],
    environments: [],
    containerTypes: ['Feature'],
    watchLabel: 'lubbdubb-watch',
    summaries: new Map(),
  });
  assert.equal(bare.features[0]?.summary, null);
});

test('a second submission revises one row and keeps the date it was first written', () => {
  const store = new Store(':memory:');
  const first = store.recordFeatureSummary({
    originRef: 'issue:29857',
    standing: 'Not started.',
    usable: null,
    blocked: null,
    remaining: null,
    standingKey: 'k1',
    agentId: 'a1',
    taskId: 't1',
  });
  const second = store.recordFeatureSummary({
    originRef: 'issue:29857',
    standing: 'On hallway now.',
    usable: 'Switch a customer over and their pairs survive.',
    blocked: null,
    remaining: null,
    standingKey: 'k2',
    agentId: 'a2',
    taskId: 't2',
  });
  assert.equal(store.listFeatureSummaries().length, 1, 'a revision is one row, not two accounts of one Feature');
  assert.equal(second.createdAt, first.createdAt, 'still dates the first time anybody said where this was');
  assert.equal(store.getFeatureSummary('issue:29857')?.standing, 'On hallway now.');
  // The key is what the rule compares: a revision that did not carry the new
  // standing forward would re-dispatch on the very next pulse, for ever.
  assert.equal(store.getFeatureSummary('issue:29857')?.standingKey, 'k2');
});
