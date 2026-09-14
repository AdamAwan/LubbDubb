import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketIndexIn,
  InsightsQuery,
  inWindow,
  resolveWindow,
  runInstant,
  runInWindow,
  sinceOrEpoch,
  timelineSpan,
  trendSince,
  trendSpan,
  windowView,
  type InsightsWindow,
} from '../src/insights/insightsWindow.js';
import { windowButtonLabel } from '../web/src/components/InsightsPage.js';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const BOUNDED: readonly InsightsWindow[] = ['6h', '24h', '7d', '30d'];

test('a bounded window opens a whole number of buckets before now', () => {
  for (const key of BOUNDED) {
    const window = resolveWindow(key, NOW, null);
    assert.equal(window.now, NOW);
    assert.notEqual(window.startMs, null, `${key} must have a lower bound`);
    assert.equal(window.since, new Date(window.startMs ?? 0).toISOString());

    const span = timelineSpan(window, null);
    assert.equal(span.buckets * span.bucketMs, window.spanMs, `${key}'s buckets must tile its span exactly`);
    assert.equal(span.startMs, window.startMs);
  }
});

test('`all` has no lower bound, and its timeline spans the history that exists', () => {
  const window = resolveWindow('all', NOW, null);
  assert.equal(window.startMs, null, 'the reading the panels gave by default must not become a long fixed span');
  assert.equal(window.since, null);
  assert.equal(window.spanMs, null);

  const old = timelineSpan(window, NOW - 90 * DAY);
  assert.equal(old.startMs, NOW - 90 * DAY);
  assert.equal(old.buckets, 26);

  const young = timelineSpan(window, NOW - 2 * HOUR);
  assert.equal(young.startMs, NOW - 7 * DAY, 'a harness with two hours of history has no eight-week story');

  assert.equal(timelineSpan(window, null).startMs, NOW - 7 * DAY);
});

test('everything is inside `all`, and only the window is inside a bounded one', () => {
  const all = resolveWindow('all', NOW, null);
  assert.equal(inWindow(all, 0), true, 'the first run the harness ever made is inside all time');
  assert.equal(inWindow(all, NOW), true);
  assert.equal(inWindow(all, NOW + HOUR), false);
  assert.equal(inWindow(all, Number.NaN), false);

  const day = resolveWindow('24h', NOW, null);
  assert.equal(inWindow(day, NOW - HOUR), true);
  assert.equal(inWindow(day, NOW - 25 * HOUR), false);
});

test('a run counts where it ended, and where it started only while it is out', () => {
  const window = resolveWindow('6h', NOW, null);
  const finished = { startedAt: new Date(NOW - 9 * HOUR).toISOString(), endedAt: new Date(NOW - 20 * 60_000).toISOString() }; // prettier-ignore
  assert.equal(inWindow(window, runInstant(finished)), true, 'money spent inside the window is inside the window');

  const stillOut = { startedAt: new Date(NOW - 20 * 60_000).toISOString(), endedAt: null };
  assert.equal(inWindow(window, runInstant(stillOut)), true);

  const longAgo = {
    startedAt: new Date(NOW - 9 * HOUR).toISOString(),
    endedAt: new Date(NOW - 8 * HOUR).toISOString(),
  };
  assert.equal(inWindow(window, runInstant(longAgo)), false);
});

test('a run that is still out is inside every window, whatever its age', () => {
  const window = resolveWindow('6h', NOW, null);
  const old = { startedAt: new Date(NOW - 8 * HOUR).toISOString(), endedAt: null };
  assert.equal(inWindow(window, runInstant(old)), false, 'its start is genuinely outside');
  assert.equal(runInWindow(window, old), true, 'the money it is spending is not');

  const young = { startedAt: new Date(NOW - 20 * 60_000).toISOString(), endedAt: null };
  assert.equal(runInWindow(young && window, young), true);
  assert.equal(runInWindow(resolveWindow('all', NOW, null), old), true);

  const longAgo = { startedAt: new Date(NOW - 9 * HOUR).toISOString(), endedAt: new Date(NOW - 8 * HOUR).toISOString() }; // prettier-ignore
  assert.equal(runInWindow(window, longAgo), false);
});

test('the last bucket keeps the reading taken at `now`', () => {
  const span = timelineSpan(resolveWindow('24h', NOW, null), null);
  assert.equal(bucketIndexIn(span, NOW), span.buckets - 1);
  assert.equal(bucketIndexIn(span, NOW - HOUR - 1), span.buckets - 2);
  assert.equal(bucketIndexIn(span, span.startMs - 1), null, 'an instant before the window is dropped, not clamped');
  assert.equal(bucketIndexIn(span, Number.NaN), null);
});

test('the trend axis is eight windows of the chosen length', () => {
  for (const key of BOUNDED) {
    const window = resolveWindow(key, NOW, null);
    const span = trendSpan(window, null);
    assert.equal(span.buckets, 8);
    assert.equal(span.bucketMs, window.spanMs, `a ${key} period must be a ${key} window`);
    assert.equal(Date.parse(trendSince(window) ?? ''), span.startMs);
  }
  assert.equal(
    trendSince(resolveWindow('all', NOW, null)),
    null,
    'the unbounded axis cannot know its span before the rows',
  );
  assert.equal(trendSpan(resolveWindow('all', NOW, null), NOW - 200 * DAY).buckets, 8);
});

test('the window ships back as the page reads it, timeline and all', () => {
  const window = resolveWindow('7d', NOW, null);
  const view = windowView(window, timelineSpan(window, null));
  assert.equal(view.key, '7d');
  assert.equal(view.bucketLabel, '6h buckets');
  assert.equal(view.since, window.since);
  assert.equal(view.buckets, 28);
  const all = resolveWindow('all', NOW, null);
  const allView = windowView(all, timelineSpan(all, NOW - 90 * DAY));
  assert.equal(allView.since, null);
  assert.equal(Date.parse(allView.startsAt), NOW - 90 * DAY);
});

test('a store read spells "no lower bound" as the epoch, once', () => {
  assert.equal(sinceOrEpoch(null), new Date(0).toISOString());
  assert.equal(sinceOrEpoch('2026-08-01T00:00:00.000Z'), '2026-08-01T00:00:00.000Z');
});

test('the window parameter defaults, and refuses what it does not know', () => {
  assert.equal(InsightsQuery.parse({}).window, '7d');
  assert.equal(InsightsQuery.parse({ window: '6h' }).window, '6h');

  const refused = InsightsQuery.safeParse({ window: 'fortnight' });
  assert.equal(refused.success, false);
  assert.match(
    refused.success ? '' : (refused.error.issues[0]?.message ?? ''),
    /window must be one of/,
    'a refusal names what it would have accepted',
  );
});

const FIVE_HOURS = 5 * HOUR;

function limits(inMs: number, agoMs = 60_000, usedPercentage = 62) {
  return {
    fiveHour: { usedPercentage, resetsAt: new Date(NOW + inMs).toISOString() },
    sevenDay: null,
    capturedAt: new Date(NOW - agoMs).toISOString(),
  };
}

test('the session window opens where the account says the last one reset', () => {
  const window = resolveWindow('session', NOW, limits(90 * 60_000));
  assert.equal(window.startMs, NOW + 90 * 60_000 - FIVE_HOURS);
  assert.equal(window.spanMs, FIVE_HOURS - 90 * 60_000, 'the span is what has elapsed, never the whole window');
  assert.equal(window.label, '5h session');
  assert.equal(window.session?.kind, 'anchored');

  const span = timelineSpan(window, null);
  assert.equal(span.startMs, window.startMs);
  assert.ok(span.startMs + span.bucketMs * span.buckets >= NOW);
  assert.ok(span.startMs + span.bucketMs * (span.buckets - 1) < NOW, 'no bucket may open after now');
});

test('a reading the harness cannot anchor to falls back, and the label says so', () => {
  const expired = resolveWindow('session', NOW, limits(-60_000));
  assert.equal(expired.session?.kind, 'stale');
  assert.equal(expired.startMs, NOW - FIVE_HOURS);
  assert.equal(expired.label, 'Last 5h', 'a span that is not the account’s must not be lettered as though it were');

  assert.equal(resolveWindow('session', NOW, limits(6 * HOUR)).session?.kind, 'stale');

  for (const none of [null, { fiveHour: null, sevenDay: null, capturedAt: new Date(NOW).toISOString() }]) {
    const window = resolveWindow('session', NOW, none);
    assert.equal(window.session?.kind, 'unreported');
    assert.equal(window.startMs, NOW - FIVE_HOURS);
    assert.equal(window.label, 'Last 5h');
  }
});

test('the session trend compares whole windows on the account’s own boundaries', () => {
  const window = resolveWindow('session', NOW, limits(90 * 60_000));
  const span = trendSpan(window, null);
  assert.equal(span.bucketMs, FIVE_HOURS);
  assert.equal(span.buckets, 8);
  assert.equal(span.startMs + 8 * FIVE_HOURS, NOW + 90 * 60_000);
  assert.equal(Date.parse(trendSince(window) ?? ''), span.startMs);
});

test('the anchor is shipped back, and only ever on the window that has one', () => {
  const window = resolveWindow('session', NOW, limits(2 * HOUR, 5 * 60_000, 86));
  const view = windowView(window, timelineSpan(window, null));
  assert.equal(view.session?.kind, 'anchored');
  assert.ok(view.session !== null && view.session.kind === 'anchored');
  if (view.session.kind === 'anchored') {
    assert.equal(Date.parse(view.session.startsAt), NOW + 2 * HOUR - FIVE_HOURS);
    assert.equal(view.session.usedPercentage, 86);
    assert.equal(view.session.capturedAt, new Date(NOW - 5 * 60_000).toISOString());
  }
  assert.equal(view.bucketLabel, '9m buckets', 'the caption must state the resolution the buckets were cut at');

  for (const key of [...BOUNDED, 'all'] as InsightsWindow[]) {
    const other = resolveWindow(key, NOW, limits(2 * HOUR));
    assert.equal(other.session, null, `${key} must not acquire an anchor`);
    assert.equal(windowView(other, timelineSpan(other, NOW - DAY)).session, null);
  }
});

test('the session key is one the routes accept', () => {
  assert.equal(InsightsQuery.parse({ window: 'session' }).window, 'session');
});

test('the window control letters the chosen button with what the server answered', () => {
  const session = { key: 'session' as const, label: '5h session' };
  const week = { key: '7d' as const, label: '7d' };
  const view = (window: ReturnType<typeof resolveWindow>) => windowView(window, timelineSpan(window, null));

  const anchored = view(resolveWindow('session', NOW, limits(90 * 60_000)));
  assert.equal(windowButtonLabel(session, 'session', anchored), '5h session');

  const loose = view(resolveWindow('session', NOW, null));
  assert.equal(windowButtonLabel(session, 'session', loose), 'Last 5h');

  assert.equal(windowButtonLabel(session, '7d', view(resolveWindow('7d', NOW, null))), '5h session');
  assert.equal(windowButtonLabel(week, '7d', view(resolveWindow('7d', NOW, null))), '7d');
  assert.equal(windowButtonLabel(week, '7d', null), '7d', 'a page still loading letters its buttons statically');
});
