import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRack } from '../web/src/view/rack.js';
import type { AppState } from '../web/src/types.js';

const { buildDemoState } = await import('../web/src/demo/fixtures.js');

function state(): AppState {
  return buildDemoState().state;
}

test('every open pull request is drawn exactly once, in a chain or beside one', () => {
  const s = state();
  const rack = buildRack(s);
  const drawn = [...rack.chains.flatMap((c) => c.prs.map((pr) => pr.number)), ...rack.loose.map((pr) => pr.number)];
  assert.deepEqual(
    [...drawn].sort((a, b) => a - b),
    s.world.pullRequests.map((pr) => pr.number).sort((a, b) => a - b),
    'a PR drawn twice carries two ignore toggles, and the second is a different answer to one question',
  );
  assert.equal(new Set(drawn).size, drawn.length);
});

test('a chain quotes the server’s readiness rather than deriving one', () => {
  const s = state();
  for (const chain of buildRack(s).chains) {
    const shipped = s.stackLandings.find((l) => l.ref === chain.stack.ref) ?? null;
    assert.deepEqual(chain.landing, shipped, 'the fold carries the snapshot’s verdict through untouched');
  }
});

test('a chain missing a rung from the open list is not a chain', () => {
  const s = state();
  const stack = s.stacks[0];
  assert.ok(stack, 'the demo fixtures must carry a stack');
  const dropped = stack.rungs[0]?.prNumber;
  assert.ok(dropped !== undefined);

  const rack = buildRack({
    ...s,
    world: { ...s.world, pullRequests: s.world.pullRequests.filter((pr) => pr.number !== dropped) },
  });
  assert.ok(
    !rack.chains.some((c) => c.stack.ref === stack.ref),
    'a header over a partial chain claims a rung the operator cannot see',
  );
  // The rungs that remain are still drawn — losing the chain must not lose them.
  for (const rung of stack.rungs.slice(1)) {
    assert.ok(
      rack.loose.some((pr) => pr.number === rung.prNumber),
      `#${rung.prNumber} fell off the rack entirely`,
    );
  }
});

test('rungs keep the stack’s own bottom-first order', () => {
  for (const chain of buildRack(state()).chains) {
    assert.deepEqual(
      chain.prs.map((pr) => pr.number),
      chain.stack.rungs.map((r) => r.prNumber),
      'merge order is the server’s, and the rack must not re-sort it',
    );
  }
});
