import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USAGE_COPY,
  USAGE_SUBJECTS,
  VERBS_BY_SUBJECT,
  usageEventSource,
  type UiUsageEvent,
  type UsageEvent,
  type UsageEventSource,
  type UsageSubject,
  type UsageVerb,
} from '../src/usage/events.js';

/**
 * The vocabulary, asserted where it can be: the matrix, the copy over it, and the
 * `ui`/`record` split that keeps stage 1 and stage 2 from counting one act twice.
 *
 * The typing is what carries most of this — `plan.defer` does not compile — so
 * what is asserted here is only what a type cannot say: that the three registries
 * describe the *same* set, so an event added to one and forgotten in another is a
 * failure rather than a silent hole.
 */

function everyEvent(): UsageEvent[] {
  return USAGE_SUBJECTS.flatMap((subject) =>
    (VERBS_BY_SUBJECT[subject] as readonly UsageVerb[]).map((verb) => `${subject}.${verb}` as UsageEvent),
  );
}

test('the copy registry covers the matrix exactly, in both directions', () => {
  const events = everyEvent();
  for (const event of events) {
    const copy = USAGE_COPY[event];
    assert.ok(copy.label.length > 0, `${event} has no label`);
    assert.ok(copy.blurb.length > 0, `${event} has no blurb`);
  }
  // The other direction is the one a `Record` cannot catch on its own: a subject
  // dropped from the matrix leaves its copy behind, and the panel then draws a
  // label for a control that no longer exists.
  assert.deepEqual(new Set(Object.keys(USAGE_COPY)), new Set(events));
});

test('every subject offers at least one verb, and never the same one twice', () => {
  for (const subject of USAGE_SUBJECTS) {
    const verbs = VERBS_BY_SUBJECT[subject] as readonly UsageVerb[];
    assert.ok(verbs.length > 0, `${subject} offers nothing`);
    assert.equal(new Set(verbs).size, verbs.length, `${subject} repeats a verb`);
  }
});

test('every reaching verb is `ui`, because no table records that a page was opened', () => {
  for (const event of everyEvent()) {
    const [, verb] = event.split('.') as [UsageSubject, UsageVerb];
    const source: UsageEventSource = usageEventSource(event);
    if (verb === 'view' || verb === 'expand' || verb === 'filter')
      assert.equal(source, 'ui', `${event} claims a record that cannot exist`);
  }
});

test('a settle the harness already stores is swept, never logged from the call site', () => {
  // The four the ledger folds. Marked `record` here is what stops stage 2's
  // batcher logging them a second time — a double count by two readings that
  // disagree quietly is the failure the split exists to make unreachable.
  assert.equal(usageEventSource('plan.accept'), 'record');
  assert.equal(usageEventSource('human-task.reject'), 'record');
  assert.equal(usageEventSource('validation.waive'), 'record');
  assert.equal(usageEventSource('agent.stop'), 'record');
  // And the three the ledger has no row for, because nothing writes them down.
  assert.equal(usageEventSource('plan.reject'), 'ui');
  assert.equal(usageEventSource('config.edit'), 'ui');
  assert.equal(usageEventSource('validation.undo'), 'ui');
});

test('`UiUsageEvent` is the ui subset, and a record event is not assignable to it', () => {
  const reached: UiUsageEvent = 'pr.view';
  assert.equal(usageEventSource(reached), 'ui');
  // @ts-expect-error a `record` event may never reach the call-site helper
  const swept: UiUsageEvent = 'plan.accept';
  assert.equal(usageEventSource(swept), 'record');
});
