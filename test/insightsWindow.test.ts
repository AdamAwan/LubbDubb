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
} from '../src/insightsWindow.js';

/**
 * The window every insights reading is measured over.
 *
 * The whole point of this module is that five readings which used to pick their
 * own spans now share one, so what is asserted here is the arithmetic that keeps
 * them shareable — and, more than that, the two shapes that are easy to get
 * quietly wrong: the unbounded window, and where a run counts.
 */

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const BOUNDED: readonly InsightsWindow[] = ['6h', '24h', '7d', '30d'];

test('a bounded window opens a whole number of buckets before now', () => {
  for (const key of BOUNDED) {
    const window = resolveWindow(key, NOW);
    assert.equal(window.now, NOW);
    assert.notEqual(window.startMs, null, `${key} must have a lower bound`);
    assert.equal(window.since, new Date(window.startMs ?? 0).toISOString());

    const span = timelineSpan(window, null);
    // The count is declared rather than derived, so this is the assertion that
    // catches a shape whose two halves disagree: a span that is not a whole
    // number of buckets draws a last bar covering less time than the rest, for a
    // reason nothing on the glass gives.
    assert.equal(span.buckets * span.bucketMs, window.spanMs, `${key}'s buckets must tile its span exactly`);
    assert.equal(span.startMs, window.startMs);
  }
});

test('`all` has no lower bound, and its timeline spans the history that exists', () => {
  const window = resolveWindow('all', NOW);
  assert.equal(window.startMs, null, 'the reading the panels gave by default must not become a long fixed span');
  assert.equal(window.since, null);
  assert.equal(window.spanMs, null);

  // A deployment three months old draws three months. One that started this
  // morning draws the floor rather than twenty-six buckets of four minutes.
  const old = timelineSpan(window, NOW - 90 * DAY);
  assert.equal(old.startMs, NOW - 90 * DAY);
  assert.equal(old.buckets, 26);

  const young = timelineSpan(window, NOW - 2 * HOUR);
  assert.equal(young.startMs, NOW - 7 * DAY, 'a harness with two hours of history has no eight-week story');

  // No data at all is the same floor, and never a division by nothing.
  assert.equal(timelineSpan(window, null).startMs, NOW - 7 * DAY);
});

test('everything is inside `all`, and only the window is inside a bounded one', () => {
  const all = resolveWindow('all', NOW);
  assert.equal(inWindow(all, 0), true, 'the first run the harness ever made is inside all time');
  assert.equal(inWindow(all, NOW), true);
  // The future is not history. A clock skew on a provider row must not land in a
  // bucket that has not happened yet.
  assert.equal(inWindow(all, NOW + HOUR), false);
  assert.equal(inWindow(all, Number.NaN), false);

  const day = resolveWindow('24h', NOW);
  assert.equal(inWindow(day, NOW - HOUR), true);
  assert.equal(inWindow(day, NOW - 25 * HOUR), false);
});

/**
 * Where a run counts, and it is the boundary the whole page's honesty rests on:
 * a nine-hour agent that finished twenty minutes ago belongs to the six-hour
 * window it in fact dominated, not to the one it started in.
 */
test('a run counts where it ended, and where it started only while it is out', () => {
  const window = resolveWindow('6h', NOW);
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

/**
 * The other half of the same sentence, and the half a cut has to read: a run
 * that has not ended is spending its money *now*, so it is inside every window
 * drawn now however long it has been out. Read at `runInstant` — its start,
 * which is the only end a live run has and the right place for it on a timeline
 * — an eight-hour agent fell out of the six-hour window it was spending in, and
 * the Economics tab drew "No agent ran in this window" over a working fleet.
 */
test('a run that is still out is inside every window, whatever its age', () => {
  const window = resolveWindow('6h', NOW);
  const old = { startedAt: new Date(NOW - 8 * HOUR).toISOString(), endedAt: null };
  assert.equal(inWindow(window, runInstant(old)), false, 'its start is genuinely outside');
  assert.equal(runInWindow(window, old), true, 'the money it is spending is not');

  const young = { startedAt: new Date(NOW - 20 * 60_000).toISOString(), endedAt: null };
  assert.equal(runInWindow(young && window, young), true);
  assert.equal(runInWindow(resolveWindow('all', NOW), old), true);

  // A run that ended is still cut where it ended: this widens nothing else.
  const longAgo = { startedAt: new Date(NOW - 9 * HOUR).toISOString(), endedAt: new Date(NOW - 8 * HOUR).toISOString() }; // prettier-ignore
  assert.equal(runInWindow(window, longAgo), false);
});

test('the last bucket keeps the reading taken at `now`', () => {
  const span = timelineSpan(resolveWindow('24h', NOW), null);
  // A run reporting at `now` lands exactly one bucket past the end. Dropping it
  // would lose the most recent point on the graph on every single draw.
  assert.equal(bucketIndexIn(span, NOW), span.buckets - 1);
  assert.equal(bucketIndexIn(span, NOW - HOUR - 1), span.buckets - 2);
  assert.equal(bucketIndexIn(span, span.startMs - 1), null, 'an instant before the window is dropped, not clamped');
  assert.equal(bucketIndexIn(span, Number.NaN), null);
});

/**
 * The trend's axis is eight of whatever window is set, which is what keeps one
 * control meaningful on the one tab that is inherently about change.
 */
test('the trend axis is eight windows of the chosen length', () => {
  for (const key of BOUNDED) {
    const window = resolveWindow(key, NOW);
    const span = trendSpan(window, null);
    assert.equal(span.buckets, 8);
    assert.equal(span.bucketMs, window.spanMs, `a ${key} period must be a ${key} window`);
    // The route must fetch eight periods, never one: asking with the window's own
    // `since` draws one bar and seven empty ones.
    assert.equal(Date.parse(trendSince(window) ?? ''), span.startMs);
  }
  assert.equal(trendSince(resolveWindow('all', NOW)), null, 'the unbounded axis cannot know its span before the rows');
  assert.equal(trendSpan(resolveWindow('all', NOW), NOW - 200 * DAY).buckets, 8);
});

test('the window ships back as the page reads it, timeline and all', () => {
  const window = resolveWindow('7d', NOW);
  const view = windowView(window, timelineSpan(window, null));
  assert.equal(view.key, '7d');
  assert.equal(view.bucketLabel, '6h buckets');
  assert.equal(view.since, window.since);
  assert.equal(view.buckets, 28);
  // `startsAt` is the timeline's, not the window's, and the two differ for `all`
  // — a page that read one for the other would label its first bar with a date
  // no bucket covers.
  const all = resolveWindow('all', NOW);
  const allView = windowView(all, timelineSpan(all, NOW - 90 * DAY));
  assert.equal(allView.since, null);
  assert.equal(Date.parse(allView.startsAt), NOW - 90 * DAY);
});

test('a store read spells "no lower bound" as the epoch, once', () => {
  assert.equal(sinceOrEpoch(null), new Date(0).toISOString());
  assert.equal(sinceOrEpoch('2026-08-01T00:00:00.000Z'), '2026-08-01T00:00:00.000Z');
});

/**
 * The query parameter is the one input here an operator can hand-edit, and the
 * page can only ask with the union — so an unrecognised key came from the
 * address bar and is refused rather than quietly answered for some other stretch.
 */
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
