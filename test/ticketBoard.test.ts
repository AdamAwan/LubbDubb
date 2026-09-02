import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { boardColumns, cardReason, dropWarning, type BoardColumn, type StateRules } from '../web/src/ticketBoard.js';
import type { Issue, TicketRow, TicketStateFacet } from '../web/src/types.js';

/**
 * Which columns the card view draws, in what order, and what it has to admit it is
 * not drawing.
 *
 * Pure over the facets the route already ships, because the whole question is a
 * statement about two inputs — an operator's order and the tracker's vocabulary —
 * and every way of getting it wrong is silent: a missing column hides work, and an
 * invented order reads as the board reordering itself.
 */

const facet = (state: string, count: number, live = count): TicketStateFacet => ({
  state,
  count,
  live,
  pickup: false,
});

const FACETS = [facet('Closed', 218, 0), facet('Ready', 14), facet('In Review', 5), facet('Removed', 7, 0)];

test('with no configured order the columns are the facets, in the order they arrive', () => {
  // The route sorts facets by count descending, and that is the fallback: a fresh
  // deployment gets a working board with nothing configured, in the order its own
  // State tier already shows.
  const { columns, unlisted } = boardColumns([], FACETS, ['Ready']);
  assert.deepEqual(
    columns.map((c) => c.state),
    ['Closed', 'Ready', 'In Review', 'Removed'],
  );
  assert.deepEqual(unlisted, [], 'nothing can be unlisted when nothing was listed');
});

test('a configured order is honoured exactly, including states with nothing in them', () => {
  const { columns } = boardColumns(['Ready', 'Doing', 'In Review', 'Closed'], FACETS, ['Ready', 'Doing']);
  assert.deepEqual(
    columns.map((c) => c.state),
    ['Ready', 'Doing', 'In Review', 'Closed'],
    'the operator’s order, not the counts',
  );
  const doing = columns.find((c) => c.state === 'Doing');
  // Naming a column is the operator saying they expect work there. Dropping it would
  // hide a state that is merely quiet today, and the board would silently differ
  // from the config file they are reading.
  assert.deepEqual(doing, { state: 'Doing', count: 0, live: 0, pickup: true, empty: true });
});

test('a state the mirror carries that the config omits is reported, never dropped in silence', () => {
  const { columns, unlisted } = boardColumns(['Ready', 'In Review'], FACETS, ['Ready']);
  assert.deepEqual(
    columns.map((c) => c.state),
    ['Ready', 'In Review'],
  );
  // Work vanishing off a board because a config list is short is the quiet loss this
  // reporting exists to refuse — and it is how a typo in the key becomes visible
  // rather than invisible.
  assert.deepEqual(
    unlisted.map((f) => [f.state, f.count]),
    [
      ['Closed', 218],
      ['Removed', 7],
    ],
    'in the facets’ own order, so the biggest omission reads first',
  );
});

test('the pickup mark on a column is the dispatcher’s effective set, for every column alike', () => {
  // Facet-backed and configured-but-empty columns resolve `pickup` the same way,
  // from one list. Preferring the facet's own flag where there is one and the list
  // where there is not is exactly the drift that would put two answers on a board.
  const { columns } = boardColumns(['Ready', 'Doing', 'Closed'], FACETS, ['Ready', 'Doing']);
  assert.deepEqual(
    columns.map((c) => [c.state, c.pickup]),
    [
      ['Ready', true],
      ['Doing', true],
      ['Closed', false],
    ],
  );
});

test('a configured state repeated or blank draws one column, and no blank one', () => {
  // The key is hand-editable, and a duplicate would give two columns one fetch and
  // one drop target each — two places to leave disagreeing about the same state.
  const { columns } = boardColumns(['Ready', 'Ready', '', '  '], FACETS, ['Ready']);
  assert.deepEqual(
    columns.map((c) => c.state),
    ['Ready'],
  );
});

// ---------------------------------------------------------------------------
// The sentence under a card
// ---------------------------------------------------------------------------

function row(over: Partial<TicketRow> & Pick<TicketRow, 'number'>): TicketRow {
  return {
    title: `Ticket ${over.number}`,
    state: 'open',
    watch: 'watched',
    labels: [],
    costUsd: null,
    outcome: null,
    addedAt: '2026-08-01T00:00:00.000Z',
    changedAt: '2026-08-01T00:00:00.000Z',
    tracking: 'live',
    workItemState: 'Ready',
    issueType: null,
    featureSlot: null,
    ...over,
  };
}

function issue(over: Record<string, unknown> = {}): Issue {
  return {
    id: 'issue_1',
    number: 40,
    title: 'Forty',
    state: 'open',
    labels: ['lubbdubb-watch'],
    pickup: { eligible: false, status: 'blocked', reasons: [] },
    ...over,
  } as unknown as Issue;
}

test('an intake hold outranks everything — it is the reading that stops dispatch', () => {
  const held = cardReason(
    row({ number: 40, outcome: 'delivered' }),
    issue({ appraisal: { verdict: 'unclear', summary: 'no acceptance criteria' } }),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(held.tone, 'held');
  assert.match(held.words, /held at intake/);
});

test('an unwatched item is never held, whatever a stale verdict says', () => {
  // Nothing appraises a goal nobody opted in, so a verdict on one is left over from
  // before it was dropped — and the drop outranks it. The table's own rule.
  const dropped = cardReason(
    row({ number: 40, watch: 'unwatched' }),
    issue({ labels: [], appraisal: { verdict: 'unclear', summary: 'stale' } }),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(dropped.tone, 'unwatched');
});

test('the outcome word wins over the dispatcher’s reason — the harness has finished deciding', () => {
  const done = cardReason(
    row({ number: 40, outcome: 'delivered' }),
    issue({ pickup: { eligible: false, status: 'blocked', reasons: ['a work agent is on this'] } }),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(done.tone, 'outcome');
  assert.match(done.words, /delivered/);
});

test('otherwise the dispatcher’s own first sentence is quoted, never re-derived', () => {
  const blocked = cardReason(
    row({ number: 40 }),
    issue({ pickup: { eligible: false, status: 'blocked', reasons: ['a work agent is on this'] } }),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(blocked.tone, 'pickup');
  assert.equal(
    blocked.words,
    'a work agent is on this',
    'quoted whole — a paraphrase would be the only account there is, and wrong',
  );
});

test('a frozen row with nothing else to say names its age', () => {
  const frozen = cardReason(row({ number: 40, tracking: 'frozen' }), null, 'lubbdubb-watch', '3d');
  assert.equal(frozen.tone, 'frozen');
  assert.match(frozen.words, /frozen/);
  assert.match(frozen.words, /3d/);
});

test('a watched item the dispatcher has said nothing about says exactly that', () => {
  // The absence is a reading too. A blank lane reads as a card that failed to draw,
  // which is the one thing an always-drawn lane exists to avoid.
  const quiet = cardReason(
    row({ number: 40 }),
    issue({ pickup: { eligible: true, status: 'ready', reasons: [] } }),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(quiet.tone, 'pickup');
  assert.match(quiet.words, /waiting to be picked up/);
});

test('the world wins over the mirror on the watch reading, as everywhere on this tab', () => {
  // `TicketRow.watch` is the mirror's, and the mirror is a record the tab does not
  // refetch on a click. Reading it first is a lane that goes on saying "not watched"
  // after the tag has landed (issue #417).
  const justWatched = cardReason(
    row({ number: 40, watch: 'unwatched' }),
    issue({ labels: ['lubbdubb-watch'], pickup: { eligible: true, status: 'ready', reasons: [] } }),
    'lubbdubb-watch',
    '3d',
  );
  assert.equal(justWatched.tone, 'pickup');
});

// ---------------------------------------------------------------------------
// What a drop would cost
// ---------------------------------------------------------------------------

const RULES: StateRules = {
  // The effective set: "Doing" is in it because `effectivePickupStates` folds the
  // in-progress state in, and src/config.ts says it should not be listed.
  pickup: ['Ready', 'Doing'],
  inProgress: 'Doing',
  inReview: 'In Review',
  returnsTo: 'Ready',
};

const column = (state: string, over: Partial<BoardColumn> = {}): BoardColumn => ({
  state,
  count: 5,
  live: 5,
  pickup: RULES.pickup.includes(state),
  empty: false,
  ...over,
});

test('the column a card is already in offers nothing — there is no move to describe', () => {
  const same = dropWarning(column('Ready'), 'Ready', RULES);
  assert.equal(same.tone, 'none');
  assert.match(same.words, /where it is now/);
});

test('a pickup state says the fleet can work it', () => {
  const ready = dropWarning(column('Ready'), 'In Review', RULES);
  assert.equal(ready.tone, 'ok');
  assert.match(ready.words, /a pickup state/);
});

test('the in-progress state reads as a pickup state, because the dispatcher folds it in', () => {
  // Built from the raw `issuePickupStates` this would say the fleet stops, which is
  // the opposite of true and the single wording most likely to get this wrong.
  const doing = dropWarning(column('Doing'), 'Ready', RULES);
  assert.equal(doing.tone, 'ok');
  assert.match(doing.words, /a pickup state/);
  assert.match(doing.words, /a rule moves items here itself/, 'and it says the rule will do this on its own');
});

test('leaving the pickup states says the fleet stops', () => {
  const parked = dropWarning(column('Blocked'), 'Ready', RULES);
  assert.equal(parked.tone, 'stop');
  assert.match(parked.words, /the fleet stops picking this up/);
});

test('the review state names the condition on the bounce, and never promises one', () => {
  // `work-item-back-to-pickup` fires only on an explicit `more_work` verdict, never
  // on the mere absence of a PR — that was changed deliberately, because a merged PR
  // used to bounce its ticket to "Ready" and put a fresh agent on merged work.
  const review = dropWarning(column('In Review'), 'Ready', RULES);
  assert.equal(review.tone, 'warn');
  assert.match(review.words, /the fleet stops picking this up/);
  assert.match(review.words, /"Ready"/, 'and where it would come back to');
  assert.match(review.words, /work outstanding/i, 'stated as a condition, not a certainty');
});

test('a column with nothing live states that fact, and claims nothing about closing', () => {
  // Whether a state maps to closed is the tracker's workflow, which the harness has
  // no reading of. Saying "closes it" would be a guess dressed as a warning.
  const closed = dropWarning(column('Closed', { live: 0, count: 218 }), 'Ready', RULES);
  assert.match(closed.words, /still in the tracker’s open set/);
  assert.doesNotMatch(closed.words, /closes it/i);
});

test('with no state gate configured a drop disturbs nothing the harness reads', () => {
  // All three work-item rules are switched out without `issuePickupStates`, so
  // implying otherwise would warn about a mechanism that is not running.
  const bare = dropWarning(column('Anything', { pickup: false }), 'Ready', null);
  assert.equal(bare.tone, 'none');
  assert.match(bare.words, /no state gate/);
});

/**
 * Where the tab's width cap sits, which is three statements and not one.
 *
 * **The chrome and the table are capped**, because both are read _across_ — a row's
 * id and its date are two ends of one fact, and let out to the width of a monitor the
 * eye loses the line between them.
 *
 * **The board is not**, because a column is read _down_ and is its own list: capped,
 * it drew a sideways scroll with a page of empty margin beside it on a wide monitor,
 * which is what #632 reported.
 *
 * **And the cap is on the children, not on the tab.** On the tab it bounded whichever
 * body was up *and* the head, the rail and the view toggle with it — so switching
 * views changed the width of the control that switched them, walking it out from under
 * the pointer that pressed it. Per-child, every block keeps its width in both views
 * and only the board differs.
 *
 * Asserted here because nothing else in `npm run check` reads this stylesheet, and
 * none of the three failures has anything to show for itself: the sheet stays valid,
 * both views render, and only a monitor wider than the cap tells them apart.
 * → docs/spec/17-cockpit.md#the-board-and-what-a-card-says
 */
test('the cap is on the tab’s children, and the board is the one exception', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/styles.css', import.meta.url)), 'utf8');
  const rule = (re: RegExp): string => re.exec(css)?.[1] ?? '';

  assert.match(
    rule(/^\.tickets > \*\s*\{([^}]*)\}/m),
    /max-width:\s*\d/,
    'the chrome and the table lost their cap: a row let out to the monitor puts its two ends past one glance',
  );
  assert.match(
    rule(/^\.tickets > \.tb\s*\{([^}]*)\}/m),
    /max-width:\s*none/,
    'the board is capped with everything else, which is the sideways scroll #632 reported',
  );
  assert.doesNotMatch(
    rule(/^\.tickets\s*\{([^}]*)\}/m),
    /max-width:\s*\d/,
    'the cap is back on the tab itself, which moves the view toggle on the click that presses it',
  );
});
