import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { WorldSnapshot } from '../src/types.js';
import { Store } from '../src/store/store.js';
import { pastTheFunnel } from './support/plans.js';

/**
 * Pricing a queued row: the profile every "Up next" item says it
 * would launch on, and the operator's per-origin override of it.
 *
 * Separate from `profilePins.test.ts`, which owns the goal tag and the plan's
 * part profile: those are statements about *work*, read off a ticket and a plan
 * row, and this is a statement about a *queue row*, which is why it is keyed on
 * the whole origin and reaches the pull-request rows neither of those can.
 */

const PROFILES = {
  fast: { model: 'haiku', rank: 1, description: 'mechanical work' },
  standard: { model: 'sonnet', effort: 'medium', rank: 2, description: 'ordinary work' },
  deep: { model: 'opus', effort: 'medium', rank: 3, description: 'work whose shape is unclear' },
} as const;

const MODELS = { profiles: PROFILES, default: 'standard', byRule: { 'issue-pickup': 'fast' } };
const PINS = { labelPrefix: 'lubbdubb', models: MODELS };

function ctx(world: Partial<WorldSnapshot>, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], ...world },
    plans: [],
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: (world.issues ?? []).flatMap((i) => pastTheFunnel(i.number)),
    agentHeadroom: 3,
    modelPins: PINS,
    ...over,
  };
}

const issue = (number: number, labels: string[] = []) => ({
  id: `i${number}`,
  number,
  title: `Issue ${number}`,
  body: 'b',
  labels,
  state: 'open' as const,
  linkedPrNumber: null,
});

test('every queued row names the profile it would run on, and which level answered', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(ctx({ issues: [issue(101), issue(102)] }, { agentHeadroom: 1 }));

  assert.deepEqual(
    result.upcoming?.map((q) => [q.origin, q.status, q.profile, q.profileSource]),
    [
      ['issue:101', 'dispatching', 'fast', 'rule'],
      // The row below the cut is priced too: "what will this cost when it runs"
      // is the question being asked of a row nobody has started.
      ['issue:102', 'waiting', 'fast', 'rule'],
    ],
  );
  assert.equal(result.upcoming?.[0]?.override, undefined, 'nothing is overridden until somebody says so');
});

test('a row with no agentModels is priced null rather than guessed at', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(ctx({ issues: [issue(7)] }, { modelPins: undefined }));
  assert.equal(result.upcoming?.[0]?.profile, null, 'no policy means no --model flag, which is not a profile');
  assert.equal(result.upcoming?.[0]?.profileSource, undefined);
});

test("an override beats the goal's tag, and says which pin is the operator's", async () => {
  const d = new RuleDispatcher();
  const world = { issues: [issue(310, ['lubbdubb-model-deep'])] };

  const pinned = await d.decide(ctx(world));
  assert.equal(pinned.upcoming?.[0]?.profile, 'deep', "the goal's tag stands on its own");
  assert.equal(pinned.upcoming?.[0]?.override, undefined);

  const priced = await d.decide(ctx(world, { profileOverrides: [{ origin: 'issue:310', profile: 'fast' }] }));
  assert.equal(priced.upcoming?.[0]?.profile, 'fast', 'the narrower, later statement wins');
  assert.equal(priced.upcoming?.[0]?.profileSource, 'pin');
  assert.equal(priced.upcoming?.[0]?.override, 'fast', 'and the row says which pin is the one to clear');
});

test('the override reaches a pull-request row, which no goal tag can', async () => {
  // The motivating case: a conflict fix an operator can see is mechanical. Its
  // origin is `pr:<n>:ci`, which has no ticket to tag and no part to carry one.
  const d = new RuleDispatcher();
  const world = {
    pullRequests: [
      { id: 'a', number: 12, title: 'red', branch: 'a', ciStatus: 'failing' as const, unresolvedComments: [] },
    ],
  };
  const result = await d.decide(ctx(world, { profileOverrides: [{ origin: 'pr:12:ci', profile: 'fast' }] }));
  assert.equal(result.upcoming?.[0]?.origin, 'pr:12:ci');
  assert.equal(result.upcoming?.[0]?.profile, 'fast');
  assert.equal(result.upcoming?.[0]?.override, 'fast');
});

test('an overridden row dispatches on the profile the queue advertised', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx({ issues: [issue(88)] }, { profileOverrides: [{ origin: 'issue:88', profile: 'deep' }] }),
  );
  const dispatched = result.actions.find((a) => a.type === 'dispatch_code_agent');
  assert.ok(dispatched);
  assert.equal((dispatched as { profile?: string }).profile, 'deep', 'the queue and the launch cannot disagree');
});

test('an override prices and never un-holds: a held row keeps its hold', async () => {
  const d = new RuleDispatcher();
  // Unwatched work is held by the watch gate; pricing it says nothing about that.
  const result = await d.decide(
    ctx({ issues: [issue(9)] }, { agentHeadroom: 0, profileOverrides: [{ origin: 'issue:9', profile: 'fast' }] }),
  );
  assert.equal(result.upcoming?.[0]?.status, 'waiting', 'zero headroom still holds it');
  assert.equal(result.upcoming?.[0]?.profile, 'fast');
  assert.equal(result.actions[0]?.type, 'no_op', 'and nothing dispatched');
});

// --------------------------------------------------------------------------
// Store: one row per origin, cleared by null, pruned like a priority override.
// --------------------------------------------------------------------------

test('setProfileOverride writes one row per origin and clears with null', () => {
  const store = new Store(':memory:');
  store.setProfileOverride('issue:1', 'fast');
  store.setProfileOverride('pr:2:ci', 'deep');
  assert.deepEqual(store.listProfileOverrides(), [
    { origin: 'issue:1', profile: 'fast' },
    { origin: 'pr:2:ci', profile: 'deep' },
  ]);
  // Re-pricing one row leaves the other alone — unlike the re-ordering above it,
  // which is a statement about the whole queue.
  store.setProfileOverride('issue:1', 'deep');
  assert.deepEqual(
    store.listProfileOverrides().find((o) => o.origin === 'issue:1'),
    { origin: 'issue:1', profile: 'deep' },
  );
  store.setProfileOverride('issue:1', null);
  assert.deepEqual(store.listProfileOverrides(), [{ origin: 'pr:2:ci', profile: 'deep' }]);
  store.close();
});

test('a stale profile override is pruned once its origin stops being tracked', () => {
  let t = Date.parse('2026-07-01T00:00:00Z');
  const store = new Store(':memory:', () => new Date(t).toISOString());
  store.setProfileOverride('issue:1', 'fast');
  store.setProfileOverride('issue:2', 'fast');

  store.reconcileProfileOverrides(['issue:1', 'issue:2'], 1000);
  t += 500;
  store.reconcileProfileOverrides(['issue:2'], 1000);
  assert.deepEqual(
    store.listProfileOverrides().map((o) => o.origin),
    ['issue:1', 'issue:2'],
    'under the TTL it survives a pulse that did not queue it',
  );

  t += 2000;
  store.reconcileProfileOverrides(['issue:2'], 1000);
  assert.deepEqual(
    store.listProfileOverrides().map((o) => o.origin),
    ['issue:2'],
  );

  // A zero TTL disables pruning, which is a supported configuration.
  t += 10_000_000;
  store.reconcileProfileOverrides([], 0);
  assert.deepEqual(
    store.listProfileOverrides().map((o) => o.origin),
    ['issue:2'],
  );
  store.close();
});
