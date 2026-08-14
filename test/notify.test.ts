import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../web/src/types.js';
import { notifiableChanges, notifySnapshot } from '../web/src/cockpit/notify.js';

// The demo seed is a whole, coherent snapshot — the same one `needsYou.test.ts`
// builds on — so these read against a state with real escalations and agents in
// it rather than an empty object that would pass any diff.
const { buildDemoState: buildDemoSeed } = await import('../web/src/demo/fixtures.js');
const buildDemoState = () => buildDemoSeed().state;

/** The snapshot slice, with the three lists overridable per case. */
function snap(over: Partial<ReturnType<typeof notifySnapshot>> = {}) {
  return { needsYou: [], errors: [], agents: [], ...over };
}

test('the first snapshot notifies nothing, however much is already waiting', () => {
  // The seeding rule. Without it, opening the cockpit on a deployment with a
  // backlog announces the whole backlog at once — worst on exactly the
  // deployments with the most waiting for them.
  const state = buildDemoState();
  const first = notifySnapshot(state);
  assert.ok(first.needsYou.length > 0, 'the demo seed should carry needs-you rows for this to prove anything');
  assert.deepEqual(notifiableChanges(null, first), []);
});

test('an unchanged snapshot notifies nothing', () => {
  const state = buildDemoState();
  const before = notifySnapshot(state);
  assert.deepEqual(notifiableChanges(before, notifySnapshot(state)), []);
});

test('a new needs-you row notifies once, titled by its kind', () => {
  const before = snap();
  const after = snap({ needsYou: [{ id: 'esc_1', kind: 'escalation', title: 'Which database?' }] });
  const items = notifiableChanges(before, after);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.category, 'needsYou');
  assert.equal(items[0]!.title, 'An agent is asking you');
  assert.equal(items[0]!.body, 'Which database?');
  // Tagged per subject so a reconnect replaces rather than repeats.
  assert.equal(items[0]!.tag, 'need:esc_1');

  // And it does not fire a second time once seen.
  assert.deepEqual(notifiableChanges(after, after), []);
});

test('a new error notifies, and an existing one does not', () => {
  const before = snap({ errors: [{ id: 'e1', message: 'old' }] });
  const after = snap({
    errors: [
      { id: 'e2', message: 'provider snapshot failed' },
      { id: 'e1', message: 'old' },
    ],
  });
  const items = notifiableChanges(before, after);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.body, 'provider snapshot failed');
});

test('an agent notifies when it ends, not when it appears', () => {
  // An agent is in the list from the moment it spawns, so a new id is a run
  // starting — the thing the operator did not ask to hear about.
  const spawned = notifiableChanges(snap(), snap({ agents: [{ id: 'a1', status: 'running' }] }));
  assert.deepEqual(spawned, []);

  const ended = notifiableChanges(
    snap({ agents: [{ id: 'a1', status: 'running' }] }),
    snap({ agents: [{ id: 'a1', status: 'done' }] }),
  );
  assert.equal(ended.length, 1);
  assert.equal(ended[0]!.category, 'agents');
  assert.equal(ended[0]!.title, 'Agent finished');
});

test('an agent already terminal in the previous snapshot does not re-notify', () => {
  // The transition is the event. Without this the whole graveyard re-fires on
  // every poll, since a dead agent stays in the list.
  const done = snap({ agents: [{ id: 'a1', status: 'done' }] });
  assert.deepEqual(notifiableChanges(done, done), []);
});

test('an unhappy ending says which', () => {
  const items = notifiableChanges(
    snap({ agents: [{ id: 'a1', status: 'running' }] }),
    snap({ agents: [{ id: 'a1', status: 'crashed' }] }),
  );
  assert.equal(items[0]!.title, 'Agent crashed');
});

test('notifySnapshot reduces a whole AppState to the three lists', () => {
  const state = buildDemoState();
  const reduced = notifySnapshot(state);
  assert.equal(reduced.agents.length, state.agents.length);
  assert.equal(reduced.errors.length, state.errors.length);
  // The needs-you rows are the *rendered* queue, not a raw list off the state —
  // which is the point of diffing them: they cover the four sources that arrive
  // as one coarse `dirty` and never announce themselves individually.
  assert.deepEqual(
    reduced.needsYou.map((r) => r.id).sort(),
    (state as AppState).escalations
      .filter((e) => e.status === 'open')
      .map((e) => e.id)
      .concat((state.humanTasks ?? []).filter((t) => t.status === 'open').map((t) => t.id))
      .concat((state.recovery ?? []).length > 0 ? ['recovery'] : [])
      .sort(),
  );
});
