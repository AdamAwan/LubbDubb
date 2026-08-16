import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { resolveAgentProfile } from '../src/agents/modelPolicy.js';
import { resolveModelTag } from '../src/modelLabels.js';
import { pinnedProfileFor } from '../src/profilePin.js';
import { assayHold, goalFingerprint } from '../src/intake/assay.js';
import type { Issue, IssueAssay } from '../src/types.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { failPlanningOpen } from './support/plans.js';

/**
 * Pinning one goal to a model profile (issue #342) — the precedence chain, the
 * tag it is read from, the origins it reaches, and the gate the assayer's
 * proposal raises.
 *
 * Separate from `agentModels.test.ts`, which owns the rule-keyed policy those
 * tests were written for: the pin is a different question asked of the same
 * resolver, and folding it in would leave one file answering "which kind of work
 * is this" and "which goal is this" without saying which assertions were about
 * which.
 */

const PROFILES = {
  fast: { model: 'haiku', rank: 1, description: 'mechanical work' },
  standard: { model: 'sonnet', effort: 'medium', rank: 2, description: 'ordinary work' },
  deep: { model: 'opus', effort: 'medium', rank: 3, description: 'work whose shape is unclear' },
} as const;

const MODELS = { profiles: PROFILES, default: 'standard', byRule: { 'issue-pickup': 'fast' } };

// -- the precedence chain -----------------------------------------------------

test('a pin beats the rule, the rule beats the default, and each says which answered', () => {
  assert.deepEqual(resolveAgentProfile(MODELS, 'issue-pickup', 'deep'), {
    name: 'deep',
    model: 'opus',
    effort: 'medium',
    source: 'pin',
  });
  assert.deepEqual(resolveAgentProfile(MODELS, 'issue-pickup', null), {
    name: 'fast',
    model: 'haiku',
    effort: null,
    source: 'rule',
  });
  assert.deepEqual(resolveAgentProfile(MODELS, 'issue-plan', null), {
    name: 'standard',
    model: 'sonnet',
    effort: 'medium',
    source: 'default',
  });
});

test('a pin wins whether it is deeper or cheaper than the rule — it is not an escalation', () => {
  // `issue-plan` falls to `standard`; pinning `fast` must take it *down*, or the
  // inverse case (pin one noisy goal to the cheapest profile) has no mechanism.
  assert.equal(resolveAgentProfile(MODELS, 'issue-plan', 'fast')?.name, 'fast');
});

test('a pin naming a profile this deployment does not have falls through rather than resolving to nothing', () => {
  // A tag is typed on a ticket by a human the harness cannot refuse at boot, so
  // the only choices are the rule's own entry or a dispatch with no flags. The
  // first is the one that cannot silently change what a run costs.
  const resolved = resolveAgentProfile(MODELS, 'issue-pickup', 'thorough');
  assert.equal(resolved?.name, 'fast');
  assert.equal(resolved?.source, 'rule');
});

// -- reading the tag off a ticket ---------------------------------------------

test('a model tag resolves to its profile, and an unknown one is ignored rather than obeyed', () => {
  assert.deepEqual(resolveModelTag(['lubbdubb-watch', 'lubbdubb-model-deep'], 'lubbdubb', MODELS), {
    profile: 'deep',
    ignored: [],
  });
  assert.deepEqual(resolveModelTag(['lubbdubb-model-thorough'], 'lubbdubb', MODELS), {
    profile: null,
    ignored: ['lubbdubb-model-thorough'],
  });
});

test('two tags resolve to the deeper one, and the one that lost is reported', () => {
  // Deeper rather than cheaper: a pin is bought capability, and quietly taking the
  // cheaper of two is the failure that reads as ordinary output.
  assert.deepEqual(resolveModelTag(['lubbdubb-model-fast', 'lubbdubb-model-deep'], 'lubbdubb', MODELS), {
    profile: 'deep',
    ignored: ['lubbdubb-model-fast'],
  });
});

test('no prefix and no profiles both read as the feature being off', () => {
  assert.equal(resolveModelTag(['lubbdubb-model-deep'], '', MODELS).profile, null);
  assert.equal(resolveModelTag(['lubbdubb-model-deep'], 'lubbdubb', undefined).profile, null);
});

// -- which origins a pin reaches ----------------------------------------------

const LOOKUP = {
  goal: (n: number) => (n === 12 ? 'deep' : null),
  part: (n: number, slug: string) => (n === 12 && slug === 'store' ? 'fast' : null),
};

test('a pin reaches the goal, its plan and its pickup', () => {
  for (const origin of ['issue:12', 'issue:12:plan', 'issue:12:assess', 'issue:12:shortfall'])
    assert.equal(pinnedProfileFor(origin, LOOKUP), 'deep', origin);
});

test("a part's own profile beats the goal's, and a part with none inherits it", () => {
  assert.equal(pinnedProfileFor('issue:12:part:store', LOOKUP), 'fast');
  assert.equal(pinnedProfileFor('issue:12:part:reader', LOOKUP), 'deep');
});

test('the retrospective and the assay run on their rules whatever the goal is pinned to', () => {
  // The retro gates nothing, so a deep pin there is money for a document no
  // dispatch reads; the assay is the stage that *proposes* the pin.
  assert.equal(pinnedProfileFor('issue:12:retro', LOOKUP), null);
  assert.equal(pinnedProfileFor('issue:12:assay', LOOKUP), null);
});

test('an origin outside the issue subtree is never pinned', () => {
  for (const origin of ['pr:87', 'pr:87:ci', 'job:abc', null])
    assert.equal(pinnedProfileFor(origin, LOOKUP), null, String(origin));
});

// -- the gate -----------------------------------------------------------------

const ISSUE: Issue = {
  id: 'i1',
  number: 12,
  title: 'Split the store',
  body: 'It is one file.',
  labels: [],
  state: 'open',
  linkedPrNumber: null,
};

function assay(over: Partial<IssueAssay> = {}): IssueAssay {
  return {
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'Splitting the store module by table group.',
    goalRef: goalFingerprint(ISSUE.title, ISSUE.body),
    by: 'assayer',
    proposedProfile: null,
    profileAnsweredAt: null,
    agentId: 'a1',
    taskId: 't1',
    commentRef: null,
    decidedAt: '2026-08-15T09:00:00.000Z',
    updatedAt: '2026-08-15T09:00:00.000Z',
    ...over,
  };
}

test('an unanswered proposal holds the funnel, and says what it proposed', () => {
  const held = assayHold(assay({ proposedProfile: 'deep' }), ISSUE);
  assert.match(held ?? '', /proposes running this on "deep"/);
});

test('an answered proposal holds nothing, whichever way it was answered', () => {
  assert.equal(
    assayHold(assay({ proposedProfile: 'deep', profileAnsweredAt: '2026-08-15T10:00:00.000Z' }), ISSUE),
    null,
  );
});

test('an assay that proposed nothing holds nothing — the fail-open a blocking gate needs', () => {
  // The whole safety of the gate: a crashed, killed or capped assayer writes no
  // row at all, and one that named no profile leaves the issue to the funnel it
  // would have entered anyway.
  assert.equal(assayHold(assay(), ISSUE), null);
  assert.equal(assayHold(null, ISSUE), null);
});

test('a rewritten ticket ends the hold, because the proposal is about text that no longer exists', () => {
  const edited = { ...ISSUE, body: 'It is one file, and three of the table groups are unrelated.' };
  assert.equal(assayHold(assay({ proposedProfile: 'deep' }), edited), null);
});

test('a refused goal reads as refused, not as unpriced', () => {
  // Both arms stand; asking the cheaper question second means an issue that is
  // both is reported as the one a human has to act on.
  const held = assayHold(assay({ verdict: 'unclear', proposedProfile: 'deep' }), ISSUE);
  assert.match(held ?? '', /could not act on this goal/);
});

// -- what the loader refuses --------------------------------------------------

/** `loadConfig`, never `loadDeploymentConfig` — the latter reads this machine's own file. */
function load(agentModels: Config['agentModels']) {
  return loadConfig({ dbPath: ':memory:', agentModels });
}

test('config load rejects a profile with no rank, naming it', () => {
  assert.throws(
    () => load({ profiles: { deep: { model: 'opus', description: 'hard work' } } as never }),
    /agentModels\.profiles\."deep"\.rank must be a number/,
  );
});

test('config load rejects a profile with no description, naming it', () => {
  assert.throws(
    () => load({ profiles: { deep: { model: 'opus', rank: 1 } } as never }),
    /agentModels\.profiles\."deep"\.description must be a non-empty sentence/,
  );
});

test('config load rejects two profiles sharing a rank, naming both', () => {
  assert.throws(
    () =>
      load({
        profiles: {
          fast: { model: 'haiku', rank: 1, description: 'cheap' },
          deep: { model: 'opus', rank: 1, description: 'expensive' },
        },
      }),
    /"deep" and "fast" both have rank 1/,
  );
});

// -- the whole wiring, at the buildSystem seam --------------------------------

/** Fake claude stream-JSON process — enough to be spawned and read back. */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 556;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

/**
 * A system with a real `labelPrefix`, so the goal tags mean something — the one
 * thing the model-policy suite's own fixture deliberately turns off.
 */
function pinConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pins-'));
  return loadConfig({
    labelPrefix: 'lubbdubb',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    agentModels: MODELS,
  });
}

async function dispatchTagged(n: number, labels: string[]) {
  const launches: string[][] = [];
  const spawner: Spawner = (_command, args) => {
    launches.push(args);
    return new FakeChild();
  };
  const system = buildSystem(pinConfig(), { worktrees: new FakeWorktreeManager(), streamSpawner: spawner });
  system.connector.inject({ kind: 'new_issue', number: n, title: 'Add login', labels });
  failPlanningOpen(system.store, n);
  await system.harness.runCycle('manual');
  const task = system.store.getTask(system.store.listAgentsByStatus('starting', 'running')[0]!.taskId)!;
  return { args: launches[0]!, task, system };
}

test('a tagged goal launches on its pin rather than its rule, and the row says it was pinned', async () => {
  // `issue-pickup` is assigned `fast` in `MODELS`, so a run on `opus` can only
  // have come from the tag.
  const { args, task, system } = await dispatchTagged(941, ['lubbdubb-watch', 'lubbdubb-model-deep']);
  assert.equal(task.rule, 'issue-pickup');
  assert.equal(task.model, 'opus');
  assert.equal(task.effort, 'medium');
  assert.equal(task.profile, 'deep');
  assert.equal(task.profileSource, 'pin');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  system.store.close();
});

test('an untagged goal beside it still launches on its rule', async () => {
  const { task, system } = await dispatchTagged(942, ['lubbdubb-watch']);
  assert.equal(task.model, 'haiku');
  assert.equal(task.profile, 'fast');
  assert.equal(task.profileSource, 'rule');
  system.store.close();
});

test('a pin survives a retry, because nothing about it is a function of run history', async () => {
  const { task, system } = await dispatchTagged(943, ['lubbdubb-watch', 'lubbdubb-model-deep']);

  // What a *resumed* agent re-launches on: the row, not a fresh lookup. Config
  // moves under a long run, and the flags it started with have to survive that.
  assert.deepEqual(
    { model: task.model, effort: task.effort, profile: task.profile, source: task.profileSource },
    { model: 'opus', effort: 'medium', profile: 'deep', source: 'pin' },
  );

  // What a *re-dispatch* resolves: the same two inputs, because the resolver takes
  // the rule and the origin's pin and nothing else. This is the property #342 was
  // required to preserve — escalating on attempt count would make a retry cost
  // more than the run it is repeating, and would make a resumed agent and a
  // re-dispatched one disagree about what the work is worth.
  const again = resolveAgentProfile(MODELS, task.rule, 'deep');
  assert.deepEqual(again, { name: 'deep', model: 'opus', effort: 'medium', source: 'pin' });

  // And the tag it was resolved from is still on the ticket, so the next dispatch
  // reads the same answer rather than one the first run consumed.
  const issue = system.store.getWorldBaseline()?.issues.find((i) => i.number === 943);
  assert.equal(resolveModelTag(issue?.labels, 'lubbdubb', MODELS).profile, 'deep');
  system.store.close();
});
