import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeys, gateKeys, type ObstacleWorld } from '../src/obstacles/keys.js';
import { matchObstacle, nearMatches, resolvingKeys } from '../src/obstacles/match.js';

function world(over: Partial<ObstacleWorld> = {}): ObstacleWorld {
  return {
    checks: ['test (windows)', 'lint', 'test (linux)'],
    dispatchChecks: ['test (windows)'],
    hasPath: (path) => ['src/claims.ts', 'test/obstacleMatch.test.ts', 'src/store/schema.ts'].includes(path),
    branchPaths: [],
    ...over,
  };
}

test('a check key is extracted from the dispatch, not from a form', () => {
  const keys = gateKeys(
    extractKeys({ what: "there's a flakey test", evidence: 'it went red twice.', world: world() }),
    world(),
  );
  assert.deepEqual(
    keys.filter((k) => k.kind === 'check'),
    [{ kind: 'check', value: 'test (windows)', binds: true }],
  );
});

test('a key that does not resolve is dropped and the claim is kept', () => {
  const candidates = extractKeys({
    what: 'check nightly-smoke is wedged',
    evidence: 'src/does/not/exist.ts is where I looked.',
    world: world(),
    declared: [{ kind: 'check', value: 'nightly-smoke' }],
  });
  const keys = gateKeys(candidates, world());
  assert.deepEqual(
    keys.map((k) => k.value).filter((v) => v === 'nightly-smoke' || v.includes('does/not')),
    [],
  );
});

test('a bare check files fresh, however many rows already hold that check name', () => {
  const keys = gateKeys([{ kind: 'check', value: 'test (windows)' }], world());
  assert.equal(keys[0]?.binds, true, 'the check is grounded — it is the dispatch itself');
  assert.deepEqual(resolvingKeys(keys), [], 'and it still resolves nothing on its own');
  assert.equal(
    matchObstacle(keys, (value) => (value === 'test (windows)' ? 'obs-existing' : null)),
    null,
  );
});

test('a check binds once a test or a path key co-occurs', () => {
  const keys = gateKeys(
    [
      { kind: 'check', value: 'test (windows)' },
      { kind: 'test', value: 'test/obstacleMatch.test.ts > corroboration' },
    ],
    world(),
  );
  assert.deepEqual(
    matchObstacle(keys, (value) => (value === 'test (windows)' ? 'obs-existing' : null)),
    { obstacleId: 'obs-existing', matchedBy: 'check:test (windows)' },
  );
});

test('a signature does not rescue a bare check, and never binds beside one either', () => {
  const keys = gateKeys(
    [
      { kind: 'check', value: 'test (windows)' },
      { kind: 'signature', value: 'assertionerror: expected <n> to equal <n>' },
    ],
    world(),
  );
  assert.deepEqual(resolvingKeys(keys), []);
  assert.equal(
    matchObstacle(keys, () => 'obs-existing'),
    null,
  );
});

test('the value is the identity and the kind is a column beside it', () => {
  const asCheck = gateKeys(
    [
      { kind: 'check', value: 'test (windows)' },
      { kind: 'path', value: 'src/claims.ts' },
    ],
    world({ branchPaths: ['src/claims.ts'] }),
  );
  const lookup = (value: string): string | null => (value === 'test (windows)' ? 'obs-one' : null);
  assert.equal(matchObstacle(asCheck, lookup)?.obstacleId, 'obs-one');
});

test('matching is exact and never a prefix', () => {
  const keys = gateKeys(
    [
      { kind: 'check', value: 'test (linux)' },
      { kind: 'path', value: 'src/claims.ts' },
    ],
    world({ branchPaths: ['src/claims.ts'] }),
  );
  assert.equal(
    matchObstacle(keys, (value) => (value === 'test (windows)' ? 'obs-one' : null)),
    null,
  );
});

test('a validated key outside what the harness knows about the dispatch suggests and does not bind', () => {
  const keys = gateKeys([{ kind: 'path', value: 'src/store/schema.ts' }], world({ dispatchChecks: [] }));
  assert.deepEqual(keys, [{ kind: 'path', value: 'src/store/schema.ts', binds: false }]);
  assert.deepEqual(resolvingKeys(keys), [], 'plausible is not grounded');
});

test('the prose matcher is kept, and only to fill near[]', () => {
  const keys = gateKeys([{ kind: 'signature', value: 'econnrefused connecting to the registry' }], world());
  const rows = [
    { id: 'obs-one', what: 'the package registry refuses installs from the runner' },
    { id: 'obs-two', what: 'the docs index is out of date' },
  ];
  const near = nearMatches({
    what: 'the package registry refuses installs from the runner',
    keys,
    rows,
    lookup: (value) => (value === 'econnrefused connecting to the registry' ? 'obs-two' : null),
  });
  assert.deepEqual(near.map((r) => r.id).sort(), ['obs-one', 'obs-two']);
  assert.equal(
    matchObstacle(keys, () => 'obs-two'),
    null,
  );
});
