import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../web/src/types.js';
import {
  fireNotifications,
  notifiableChanges,
  notifySnapshot,
  sendTestNotification,
} from '../web/src/cockpit/notify.js';

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

/** One notification the stubbed engine was asked to raise. */
interface Raised {
  title: string;
  tag: string | undefined;
  /** The engine's own late refusal, so a test can play the `error` event back. */
  fireError: () => void;
}

/**
 * The browser half, under a stubbed engine.
 *
 * `notifiableChanges` decides *what* is worth saying and is covered above; this
 * covers *whether it gets said*, which is the half that reaches nobody when it
 * is wrong — and does it silently, since a notification that never fires looks
 * exactly like a fleet with nothing to report.
 *
 * `defineProperty` rather than assignment: `Notification` and `document` are
 * read off the global by `fireNotifications` at call time, and this is the way
 * to stand one up in node without restating the DOM's constructor type.
 */
function withEngine(
  engine: {
    permission: NotificationPermission;
    visibility: DocumentVisibilityState;
    focused: boolean;
    /** Engines that throw from the constructor rather than resolving to a no-op. */
    throws?: boolean;
    /** No Notification API at all, which is a different answer from a refusal. */
    absent?: boolean;
  },
  body: () => void,
): Raised[] {
  const raised: Raised[] = [];
  class StubNotification {
    static permission = engine.permission;
    onerror: (() => void) | null = null;
    constructor(title: string, opts?: { tag?: string }) {
      if (engine.throws) throw new TypeError('Illegal constructor');
      raised.push({ title, tag: opts?.tag, fireError: () => this.onerror?.() });
    }
  }
  const before = { notification: globalThis.Notification, document: globalThis.document };
  Object.defineProperty(globalThis, 'Notification', {
    value: engine.absent ? undefined : StubNotification,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: { visibilityState: engine.visibility, hasFocus: () => engine.focused },
    configurable: true,
  });
  try {
    body();
  } finally {
    Object.defineProperty(globalThis, 'Notification', { value: before.notification, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: before.document, configurable: true });
  }
  return raised;
}

const ON = { enabled: true, categories: { needsYou: true, errors: true, agents: true } };
const ONE_ITEM = [{ id: 'esc_1', kind: 'escalation' as const, title: 'Which database?' }];
const oneChange = () => notifiableChanges(snap(), snap({ needsYou: ONE_ITEM }));

test('a cockpit sitting behind another window still notifies', () => {
  // The regression. A document is `hidden` only when its tab is not the selected
  // one or its window is minimized — a window merely behind another, or on
  // another virtual desktop, reads `visible` in every engine. Gating on
  // visibility alone therefore suppressed exactly the case the feature exists
  // for: the operator who is working in their editor with the cockpit open
  // behind it.
  const raised = withEngine({ permission: 'granted', visibility: 'visible', focused: false }, () => {
    fireNotifications(oneChange(), ON);
  });
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.tag, 'need:esc_1');
});

test('a backgrounded tab notifies', () => {
  const raised = withEngine({ permission: 'granted', visibility: 'hidden', focused: false }, () => {
    fireNotifications(oneChange(), ON);
  });
  assert.equal(raised.length, 1);
});

test('the cockpit in front of the operator stays quiet', () => {
  // Both halves. A notification for a row on the screen you are reading is noise.
  const raised = withEngine({ permission: 'granted', visibility: 'visible', focused: true }, () => {
    fireNotifications(oneChange(), ON);
  });
  assert.deepEqual(raised, []);
});

test('nothing fires without the switch or the grant', () => {
  const off = withEngine({ permission: 'granted', visibility: 'hidden', focused: false }, () => {
    fireNotifications(oneChange(), { ...ON, enabled: false });
  });
  assert.deepEqual(off, []);

  const ungranted = withEngine({ permission: 'default', visibility: 'hidden', focused: false }, () => {
    fireNotifications(oneChange(), ON);
  });
  assert.deepEqual(ungranted, []);
});

test('a switched-off category is dropped and its siblings are not', () => {
  const changes = notifiableChanges(
    snap({ agents: [{ id: 'a1', status: 'running' }] }),
    snap({ needsYou: ONE_ITEM, agents: [{ id: 'a1', status: 'done' }] }),
  );
  const raised = withEngine({ permission: 'granted', visibility: 'visible', focused: false }, () => {
    fireNotifications(changes, { ...ON, categories: { ...ON.categories, agents: false } });
  });
  assert.deepEqual(
    raised.map((r) => r.tag),
    ['need:esc_1'],
  );
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

/**
 * The test notification, which exists because the feature is otherwise
 * unfalsifiable: a grant that was never given, an engine that refuses the
 * constructor and a fleet with nothing to say all present to an operator as no
 * notification. These cover that it answers, and that its two deliberate
 * departures from `fireNotifications` hold — neither the focus gate nor the
 * switch may suppress a diagnostic, since both are what is being diagnosed.
 */
test('a test notification fires with the cockpit in front of the operator', () => {
  // The focus gate cannot survive a button: a press means the window is focused,
  // so keeping it here would make the test unpassable and prove nothing.
  const raised = withEngine({ permission: 'granted', visibility: 'visible', focused: true }, () => {
    assert.equal(sendTestNotification(), 'sent');
  });
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.tag, 'lubbdubb:test');
});

test('a test notification does not consult the switch it is there to vouch for', () => {
  // `enabled` is off in `localStorage` until a grant lands, and an operator
  // diagnosing this has not committed to it yet.
  const raised = withEngine({ permission: 'granted', visibility: 'visible', focused: true }, () => {
    assert.equal(sendTestNotification(), 'sent');
  });
  assert.equal(raised.length, 1);
});

test('a test notification reports the grant it is missing rather than failing quietly', () => {
  const denied = withEngine({ permission: 'denied', visibility: 'hidden', focused: false }, () => {
    assert.equal(sendTestNotification(), 'blocked');
  });
  assert.deepEqual(denied, []);

  // `default` is the Firefox case: a request closed without an answer, and a
  // browser blocking new requests outright answers it that way with no prompt.
  const unanswered = withEngine({ permission: 'default', visibility: 'hidden', focused: false }, () => {
    assert.equal(sendTestNotification(), 'blocked');
  });
  assert.deepEqual(unanswered, []);
});

test('a test notification separates an absent API from a refused one', () => {
  withEngine({ permission: 'granted', visibility: 'hidden', focused: false, absent: true }, () => {
    assert.equal(sendTestNotification(), 'unsupported');
  });
});

test('an engine that throws from the constructor is reported, not swallowed', () => {
  // Firefox for Android is the live example: no `Notification` constructor, a
  // `TypeError` instead. `fireNotifications` swallows this by design; a
  // diagnostic that swallowed it would be worse than useless.
  withEngine({ permission: 'granted', visibility: 'hidden', focused: false, throws: true }, () => {
    assert.equal(sendTestNotification(), 'failed');
  });
});

test('a notification the desktop drops after accepting it comes back as undelivered', () => {
  // The one signal that separates "your desktop refused it" from "it worked and
  // you were not looking" — late, and off the engine rather than the return.
  let late: string | null = null;
  const raised = withEngine({ permission: 'granted', visibility: 'hidden', focused: false }, () => {
    assert.equal(
      sendTestNotification(() => (late = 'undelivered')),
      'sent',
    );
  });
  assert.equal(late, null, 'nothing is undelivered until the engine says so');
  raised[0]!.fireError();
  assert.equal(late, 'undelivered');
});
