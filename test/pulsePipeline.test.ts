import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PULSE_PHASES, PULSE_PIPELINE, runPulse, type PulseDeps, type PulseId } from '../src/pulseDesks.js';
import { DEFAULT_PR_REVIEW } from '../src/review/policy.js';
import type { Store } from '../src/store/store.js';
import type { WorldSnapshot } from '../src/types.js';

const WORLD: WorldSnapshot = { takenAt: '2026-09-12T00:00:00.000Z', pullRequests: [], issues: [] };
const PREV: WorldSnapshot = { takenAt: '2026-09-11T00:00:00.000Z', pullRequests: [], issues: [] };
const AT = { world: WORLD, previousWorld: PREV };

const RECONCILE: PulseId[] = PULSE_PIPELINE.filter((e) => e.phase === 'reconcile').map((e) => e.id as PulseId);

function position(id: PulseId): number {
  const at = PULSE_PIPELINE.findIndex((e) => e.id === id);
  assert.notEqual(at, -1, `${id} takes a position in the pipeline`);
  return at;
}

function entry(id: PulseId): (typeof PULSE_PIPELINE)[number] {
  return PULSE_PIPELINE[position(id)]!;
}

function below(lower: PulseId, upper: PulseId, why: string): void {
  assert.ok(position(lower) > position(upper), `${lower} runs below ${upper}: ${why}`);
}

function deskDeps(): { deps: PulseDeps; calls: { id: string; args: unknown[] }[] } {
  const calls: { id: string; args: unknown[] }[] = [];
  const deps: Record<string, unknown> = {};
  for (const id of RECONCILE) {
    const record =
      (name: string) =>
      (...args: unknown[]): undefined => {
        calls.push({ id, args: [name, ...args] });
        return undefined;
      };
    deps[id] = {
      run: record('run'),
      reconcile: record('reconcile'),
      record: record('record'),
      settle: record('settle'),
    };
  }
  return { deps: { ...bareDeps(), ...deps } as PulseDeps, calls };
}

test('every entry takes its own position — an id walked twice is a pass nothing can assert about', () => {
  const ids = PULSE_PIPELINE.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every desk in the registry is reached, in the declared order', async () => {
  const { deps, calls } = deskDeps();
  await runPulse('reconcile', deps, AT, true);
  assert.deepEqual(
    calls.map((c) => c.id),
    RECONCILE,
    'each entry calls the dependency it declares — a registry naming a desk it never runs is the same dead desk',
  );
});

test('a desk needing a fresh world read is skipped on a local cycle, and no other is', async () => {
  const { deps, calls } = deskDeps();
  await runPulse('reconcile', deps, AT, false);
  const ran = new Set(calls.map((c) => c.id));
  for (const id of RECONCILE)
    assert.equal(ran.has(id), !entry(id).readWorld, `${id} on a local cycle follows its own readWorld flag`);
});

test('a missing desk is skipped, never an error — every dependency is optional', async () => {
  await runPulse('reconcile', bareDeps(), AT, true);
  await runPulse('reconcile', bareDeps(), AT, false);
});

test('the desks handed the diff are handed the pair the diff was taken from', async () => {
  const { deps, calls } = deskDeps();
  await runPulse('reconcile', deps, AT, true);
  for (const id of ['notices', 'obstacleVoice'] as const) {
    const call = calls.find((c) => c.id === id);
    assert.deepEqual(call?.args, ['run', PREV, WORLD], `${id} reads the previous world and this one`);
  }
});

test('the obstacle reading desk is the one pass the pulse does not wait on', () => {
  for (const e of PULSE_PIPELINE)
    assert.equal(
      e.awaited,
      e.id !== 'obstacleDesk',
      `${e.id}: a model round trip is the only thing the pulse declines to block on`,
    );
});

test('the validation chain runs in the order the bench is read in', () => {
  below('environments', 'graph', 'merge attribution walks the graph, so a stale graph resolves nothing');
  below('remoteValidation', 'environments', 'a sheet is assembled off the arrivals the environment desk records');
  below('validationReady', 'remoteValidation', "the validate row's detail carries this pulse's sheet");
  below('closeOuts', 'validationReady', 'the bench asks for one thing at a time');
  below('validationReady', 'validationAsks', 'the resources are asked for before the obligation they are for');
  assert.equal(
    PULSE_PIPELINE[position('graph') + 1]?.id,
    'environments',
    'the environment desk runs *immediately* below the graph record',
  );
});

test('the graph is recorded after the reconciler and before anything that reads it', () => {
  below('graph', 'plans', 'the part→PR observations the reconciler just made are the ones recorded');
  below('graduations', 'graph', 'it reads the graph, so above that line it acts on a merge a pulse late');
  below('pool', 'graduations', 'a claim that left for the repository is out of the document before it is derived');
});

test('the obstacle desks run below the voice that files their rows', () => {
  for (const id of ['obstacleDesk', 'obstacleNotices', 'obstacleOwnership', 'obstacleEndings'] as const)
    below(id, 'obstacleVoice', 'a row the harness filed is told, owned and watched on the pulse that saw it');
  below('obstacleOwnership', 'notices', 'an agent whose report was taken up is told so by the pulse that took it');
  below('obstacleOwnership', 'obstacleNotices', 'the notices go out above the ownership the pulse may write');
  below('obstacleEndings', 'obstacleOwnership', 'it reads the owner that desk may have just written');
});

test('the pull request register is tagged before it is linked', () => {
  below('prWorkItems', 'prWatch', 'one pass says the pull request is the fleet’s, the other which work item it is for');
});

function bareDeps(): PulseDeps {
  const store = {
    reviewWaits: { foldReviewWaits: () => [] },
    floor: { recordIssueRun: () => [] },
    prReviewExternals: { prsReviewedElsewhere: () => [], recordPrReviewedElsewhere: () => [] },
  } as unknown as Store;
  return { store, errors: { record: () => [] } as unknown as PulseDeps['errors'], review: DEFAULT_PR_REVIEW };
}

function sweepDeps(): { deps: PulseDeps; calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => (): [] => {
    calls.push(name);
    return [];
  };
  const store = {
    reviewWaits: { foldReviewWaits: note('reviewWaits') },
    floor: { recordIssueRun: note('issueRuns') },
    prReviewExternals: {
      prsReviewedElsewhere: note('reviewedElsewhere'),
      recordPrReviewedElsewhere: note('recordPrReviewedElsewhere'),
    },
  } as unknown as Store;
  const deps: PulseDeps = {
    store,
    errors: { record: note('errors') } as unknown as PulseDeps['errors'],
    review: { ...DEFAULT_PR_REVIEW, reviewedElsewhere: 'true' },
    reviewProber: { check: async () => ({ verdict: 'not-reviewed', detail: null }) },
    fleet: { resumeExpiredParks: note('parks'), completeExpiredStalls: note('stalls') },
    ejections: { sweepExpiries: note('ejectionExpiries') },
    burn: { run: note('burn') } as unknown as PulseDeps['burn'],
    escalations: { tidyDeadAgents: note('deadAgents'), tidySettledMerges: note('settledMerges') },
    appraisals: { announce: async () => void calls.push('appraisals') } as unknown as PulseDeps['appraisals'],
    areaPaths: { refresh: async () => void calls.push('areaPaths') } as unknown as PulseDeps['areaPaths'],
    localValidations: { sweep: note('localValidations') },
    tickets: { run: async () => void calls.push('tickets') },
  };
  return { deps, calls };
}

async function walkSweeps(deps: PulseDeps, readWorld: boolean): Promise<void> {
  await runPulse('open', deps, {}, readWorld);
  await runPulse('afterTasks', deps, { world: WORLD, tasks: [] }, readWorld);
  await runPulse('afterAgents', deps, { tasks: [], agents: [] }, readWorld);
  await runPulse('afterVerdicts', deps, { world: WORLD }, readWorld);
  await runPulse(
    'afterOrigins',
    deps,
    {
      world: WORLD,
      tasks: [],
      signals: { retrospectiveOrigins: [], conclusions: [], deliveries: [], shortfalls: [], plans: [], planParts: [] },
    },
    readWorld,
  );
  await runPulse('afterReviews', deps, { dispatchWorld: WORLD, prReviews: [], prReviewRoutes: [] }, readWorld);
  await runPulse('afterExecute', deps, {}, readWorld);
}

test('the pipeline is grouped by phase, in the phase order the cycle walks', () => {
  const phases = PULSE_PIPELINE.map((e) => e.phase);
  const reached = [...new Set(phases)];
  assert.deepEqual(
    reached,
    PULSE_PHASES.filter((p) => phases.includes(p)),
    'a phase whose passes are split across the list runs them out of the order the list states',
  );
  assert.equal(reached[0], 'reconcile', 'the desks run between the world read and everything read off the store');
});

test('a sweep needing a fresh world read is skipped on a local cycle, and no other is', async () => {
  const fresh = sweepDeps();
  await walkSweeps(fresh.deps, true);
  const local = sweepDeps();
  await walkSweeps(local.deps, false);
  const worldFacing = PULSE_PIPELINE.filter((e) => e.phase !== 'reconcile' && e.readWorld).map((e) => e.id);
  assert.deepEqual(worldFacing, ['appraisals', 'areaPaths', 'reviewedElsewhere', 'tickets']);
  for (const id of worldFacing) {
    assert.ok(fresh.calls.includes(id), `${id} runs on a cycle that read the world`);
    assert.ok(!local.calls.includes(id), `${id} is skipped on a local cycle, and the flag is what skips it`);
  }
  for (const id of ['parks', 'stalls', 'ejectionExpiries', 'reviewWaits', 'burn', 'deadAgents', 'settledMerges'])
    assert.ok(local.calls.includes(id), `${id} reads the store, so a local cycle runs it`);
});

test('a missing sweep dependency is skipped, never an error', async () => {
  await walkSweeps(bareDeps(), true);
});
