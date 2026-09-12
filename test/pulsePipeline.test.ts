import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PULSE_DESKS, PULSE_PIPELINE, runPulseDesks, type PulseDeskId, type PulseReading } from '../src/pulseDesks.js';
import type { WorldSnapshot } from '../src/types.js';

const WORLD: WorldSnapshot = { takenAt: '2026-09-12T00:00:00.000Z', pullRequests: [], issues: [] };
const PREV: WorldSnapshot = { takenAt: '2026-09-11T00:00:00.000Z', pullRequests: [], issues: [] };
const AT: PulseReading = { world: WORLD, previousWorld: PREV };

function position(id: PulseDeskId): number {
  const at = PULSE_PIPELINE.indexOf(id);
  assert.notEqual(at, -1, `${id} takes a position in the pipeline`);
  return at;
}

function below(lower: PulseDeskId, upper: PulseDeskId, why: string): void {
  assert.ok(position(lower) > position(upper), `${lower} runs below ${upper}: ${why}`);
}

function stubs(): { deps: Record<string, unknown>; calls: { id: string; args: unknown[] }[] } {
  const calls: { id: string; args: unknown[] }[] = [];
  const deps: Record<string, unknown> = {};
  for (const id of Object.keys(PULSE_DESKS)) {
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
  return { deps, calls };
}

test('every declared desk takes exactly one position, and the pipeline names nothing else', () => {
  const declared = Object.keys(PULSE_DESKS).sort();
  const walked = [...PULSE_PIPELINE].sort();
  assert.deepEqual(walked, declared, 'a desk declared and never walked is a desk that is silently dead');
  assert.equal(new Set(PULSE_PIPELINE).size, PULSE_PIPELINE.length, 'no desk is walked twice');
});

test('every desk in the registry is reached, in the declared order', async () => {
  const { deps, calls } = stubs();
  await runPulseDesks(deps, AT, true);
  assert.deepEqual(
    calls.map((c) => c.id),
    [...PULSE_PIPELINE],
    'each entry calls the dependency it declares — a registry naming a desk it never runs is the same dead desk',
  );
});

test('a desk needing a fresh world read is skipped on a local cycle, and no other is', async () => {
  const { deps, calls } = stubs();
  await runPulseDesks(deps, AT, false);
  const ran = new Set(calls.map((c) => c.id));
  for (const id of PULSE_PIPELINE)
    assert.equal(ran.has(id), !PULSE_DESKS[id].readWorld, `${id} on a local cycle follows its own readWorld flag`);
});

test('a missing desk is skipped, never an error — every dependency is optional', async () => {
  await runPulseDesks({}, AT, true);
  await runPulseDesks({}, AT, false);
});

test('the desks handed the diff are handed the pair the diff was taken from', async () => {
  const { deps, calls } = stubs();
  await runPulseDesks(deps, AT, true);
  for (const id of ['notices', 'obstacleVoice'] as const) {
    const call = calls.find((c) => c.id === id);
    assert.deepEqual(call?.args, ['run', PREV, WORLD], `${id} reads the previous world and this one`);
  }
});

test('the obstacle reading desk is the one desk the pulse does not wait on', () => {
  for (const id of PULSE_PIPELINE)
    assert.equal(
      PULSE_DESKS[id].awaited,
      id !== 'obstacleDesk',
      `${id}: a model round trip is the only thing the pulse declines to block on`,
    );
});

test('the validation chain runs in the order the bench is read in', () => {
  below('environments', 'graph', 'merge attribution walks the graph, so a stale graph resolves nothing');
  below('remoteValidation', 'environments', 'a sheet is assembled off the arrivals the environment desk records');
  below('validationReady', 'remoteValidation', "the validate row's detail carries this pulse's sheet");
  below('closeOuts', 'validationReady', 'the bench asks for one thing at a time');
  below('validationReady', 'validationAsks', 'the resources are asked for before the obligation they are for');
  assert.equal(
    PULSE_PIPELINE[position('graph') + 1],
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
