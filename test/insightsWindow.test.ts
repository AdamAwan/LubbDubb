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
import { windowButtonLabel } from '../web/src/components/InsightsPage.js';

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
    const window = resolveWindow(key, NOW, null);
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
  const window = resolveWindow('all', NOW, null);
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
  const all = resolveWindow('all', NOW, null);
  assert.equal(inWindow(all, 0), true, 'the first run the harness ever made is inside all time');
  assert.equal(inWindow(all, NOW), true);
  // The future is not history. A clock skew on a provider row must not land in a
  // bucket that has not happened yet.
  assert.equal(inWindow(all, NOW + HOUR), false);
  assert.equal(inWindow(all, Number.NaN), false);

  const day = resolveWindow('24h', NOW, null);
  assert.equal(inWindow(day, NOW - HOUR), true);
  assert.equal(inWindow(day, NOW - 25 * HOUR), false);
});

/**
 * Where a run counts, and it is the boundary the whole page's honesty rests on:
 * a nine-hour agent that finished twenty minutes ago belongs to the six-hour
 * window it in fact dominated, not to the one it started in.
 */
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

/**
 * The other half of the same sentence, and the half a cut has to read: a run
 * that has not ended is spending its money *now*, so it is inside every window
 * drawn now however long it has been out. Read at `runInstant` — its start,
 * which is the only end a live run has and the right place for it on a timeline
 * — an eight-hour agent fell out of the six-hour window it was spending in, and
 * the Economics tab drew "No agent ran in this window" over a working fleet.
 */
test('a run that is still out is inside every window, whatever its age', () => {
  const window = resolveWindow('6h', NOW, null);
  const old = { startedAt: new Date(NOW - 8 * HOUR).toISOString(), endedAt: null };
  assert.equal(inWindow(window, runInstant(old)), false, 'its start is genuinely outside');
  assert.equal(runInWindow(window, old), true, 'the money it is spending is not');

  const young = { startedAt: new Date(NOW - 20 * 60_000).toISOString(), endedAt: null };
  assert.equal(runInWindow(young && window, young), true);
  assert.equal(runInWindow(resolveWindow('all', NOW, null), old), true);

  // A run that ended is still cut where it ended: this widens nothing else.
  const longAgo = { startedAt: new Date(NOW - 9 * HOUR).toISOString(), endedAt: new Date(NOW - 8 * HOUR).toISOString() }; // prettier-ignore
  assert.equal(runInWindow(window, longAgo), false);
});

test('the last bucket keeps the reading taken at `now`', () => {
  const span = timelineSpan(resolveWindow('24h', NOW, null), null);
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
    const window = resolveWindow(key, NOW, null);
    const span = trendSpan(window, null);
    assert.equal(span.buckets, 8);
    assert.equal(span.bucketMs, window.spanMs, `a ${key} period must be a ${key} window`);
    // The route must fetch eight periods, never one: asking with the window's own
    // `since` draws one bar and seven empty ones.
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
  // `startsAt` is the timeline's, not the window's, and the two differ for `all`
  // — a page that read one for the other would label its first bar with a date
  // no bucket covers.
  const all = resolveWindow('all', NOW, null);
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

/**
 * The session window: the one span here that is not measured from `now`.
 *
 * What is asserted is the pair of failures that have no other symptom. Anchoring
 * on a reading it should have refused puts the breakdown over five hours that are
 * not the account's, and the page says they are; falling back where it should
 * have anchored answers a question nobody asked, in a label that claims
 * otherwise. Both draw a full, plausible page either way, which is why the label
 * is asserted alongside the arithmetic in every case below.
 */

const FIVE_HOURS = 5 * HOUR;

/** A reading of the five-hour window, captured `agoMs` ago and resetting `inMs` from now. */
function limits(inMs: number, agoMs = 60_000, usedPercentage = 62) {
  return {
    fiveHour: { usedPercentage, resetsAt: new Date(NOW + inMs).toISOString() },
    sevenDay: null,
    capturedAt: new Date(NOW - agoMs).toISOString(),
  };
}

test('the session window opens where the account says the last one reset', () => {
  // Ninety minutes to go, so the window opened three and a half hours ago — which
  // is emphatically not "the last five hours", and is the whole reason this key
  // exists rather than reusing `6h`.
  const window = resolveWindow('session', NOW, limits(90 * 60_000));
  assert.equal(window.startMs, NOW + 90 * 60_000 - FIVE_HOURS);
  assert.equal(window.spanMs, FIVE_HOURS - 90 * 60_000, 'the span is what has elapsed, never the whole window');
  assert.equal(window.label, '5h session');
  assert.equal(window.session?.kind, 'anchored');

  // The timeline starts at the anchor rather than back from `now`, and stops at
  // `now` rather than at the reset: the unspent part of the window holds nothing
  // by construction, and empty bars on the right read as a fleet that stopped.
  const span = timelineSpan(window, null);
  assert.equal(span.startMs, window.startMs);
  assert.ok(span.startMs + span.bucketMs * span.buckets >= NOW);
  assert.ok(span.startMs + span.bucketMs * (span.buckets - 1) < NOW, 'no bucket may open after now');
});

test('a reading the harness cannot anchor to falls back, and the label says so', () => {
  // The window turned over since an agent last took a turn, so where the current
  // one began was never observed. Anchoring anyway would date the breakdown from
  // an instant nothing reported.
  const expired = resolveWindow('session', NOW, limits(-60_000));
  assert.equal(expired.session?.kind, 'stale');
  assert.equal(expired.startMs, NOW - FIVE_HOURS);
  assert.equal(expired.label, 'Last 5h', 'a span that is not the account’s must not be lettered as though it were');

  // A reset further off than a window is long cannot be describing one.
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
  // A whole five hours per bar, never the elapsed part every other reading
  // measures — bars whose width moved with the clock would be compared against
  // each other as though it had not.
  assert.equal(span.bucketMs, FIVE_HOURS);
  assert.equal(span.buckets, 8);
  // Ending at the reset, so each bar is one window the limit was actually applied
  // over rather than a stretch straddling two.
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
    // The percentage rides with the anchor rather than being read off the chip:
    // the chip is the freshest reading whenever it was taken, and this is the one
    // the fold beneath it actually measured against.
    assert.equal(view.session.capturedAt, new Date(NOW - 5 * 60_000).toISOString());
  }
  assert.equal(view.bucketLabel, '9m buckets', 'the caption must state the resolution the buckets were cut at');

  // Every other key carries `null`, so nothing can read an anchor into a span
  // that never had one.
  for (const key of [...BOUNDED, 'all'] as InsightsWindow[]) {
    const other = resolveWindow(key, NOW, limits(2 * HOUR));
    assert.equal(other.session, null, `${key} must not acquire an anchor`);
    assert.equal(windowView(other, timelineSpan(other, NOW - DAY)).session, null);
  }
});

test('the session key is one the routes accept', () => {
  assert.equal(InsightsQuery.parse({ window: 'session' }).window, 'session');
});

/**
 * The one decision the cockpit makes about the window, isolated because it is the
 * one that can silently lie.
 *
 * `resolveSession` changes the label when it cannot anchor, and the note under the
 * control says why — but a reader takes the span's *name* off the button they
 * pressed, and a note under a button still reading `5h session` is a caveat that
 * has already been skimmed past. This is that pairing held together from the
 * cockpit's end.
 */
test('the window control letters the chosen button with what the server answered', () => {
  const session = { key: 'session' as const, label: '5h session' };
  const week = { key: '7d' as const, label: '7d' };
  const view = (window: ReturnType<typeof resolveWindow>) => windowView(window, timelineSpan(window, null));

  const anchored = view(resolveWindow('session', NOW, limits(90 * 60_000)));
  assert.equal(windowButtonLabel(session, 'session', anchored), '5h session');

  // Could not anchor: the control must stop calling it the session, not merely
  // footnote it.
  const loose = view(resolveWindow('session', NOW, null));
  assert.equal(windowButtonLabel(session, 'session', loose), 'Last 5h');

  // A button that is not the chosen one has no payload to draw from and keeps its
  // own label — including the session button while some other window is open.
  assert.equal(windowButtonLabel(session, '7d', view(resolveWindow('7d', NOW, null))), '5h session');
  assert.equal(windowButtonLabel(week, '7d', view(resolveWindow('7d', NOW, null))), '7d');
  assert.equal(windowButtonLabel(week, '7d', null), '7d', 'a page still loading letters its buttons statically');
});
