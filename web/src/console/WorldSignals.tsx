import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { GoalArrival, WorldEvent } from '../types.js';
import { goalOfPr } from '../view/goalPage.js';
import { relTime } from '../components/util.js';
import { Ref, RefText, refLabel } from '../components/refs.js';
import { PanelRows } from './PanelRow.js';

/**
 * The world's changes, one row per `(kind, ref)` with a count — three review
 * comments on one pull request are one signal, not three unrelated rows. The
 * server's order (newest first) is kept: re-sorting by count would move the row
 * an operator is watching the moment it moves again.
 *
 * **A panel rather than a card on the overview.** It was the fourth card there
 * and it was the wrong altitude for that page: the overview answers *what is
 * happening*, and this is the log of what the world did to bring that about —
 * read when a queued row, or an empty queue, needs explaining, not glanced at on
 * every pulse. As a card it spent a full-width slot on ten rows nobody was
 * looking for; behind a name in the bar menu, and behind a way in from the Up
 * next band that is the thing it actually explains, it costs the overview
 * nothing and gains the whole feed instead of its head.
 *
 * Uncapped for that reason: the card drew ten because it was borrowing a page's
 * room, and a panel is the surface the rest was always going to need. The server
 * caps `worldEvents` at 100 and arrivals age out on {@link SIGNAL_WINDOW_MS}, so
 * the list is bounded without this one deciding where.
 *
 * → docs/spec/17-cockpit.md#world-signals
 */
export function WorldSignals({ view }: { view: CockpitView }): JSX.Element {
  const rows = signalRows(view);
  if (rows.length === 0) return <p className="cn-empty">The world has not moved.</p>;
  return (
    <PanelRows
      rows={rows.map((row) => ({
        key: row.key,
        title: <RefText text={row.summary} />,
        // The goal behind the signal, beside the sentence rather than inside
        // it. The summary's own `#412` already links out to the provider, so
        // repeating the pull request here would be one ref twice — what a
        // signal never offers is the way onto the goal page.
        refs: <Ref to={goalBehind(view, row.ref)} />,
        facts: [
          { label: 'kind', value: row.kind },
          { label: 'when', value: relTime(row.createdAt, view.now) },
          // The count is a fact with a name now, rather than the same slot a
          // fleet row puts a dollar figure in.
          ...(row.count > 1 ? [{ label: 'times', value: `×${row.count}` }] : []),
        ],
      }))}
    />
  );
}

/**
 * The feed itself — both halves of "what has happened", newest first: the world's
 * own transitions and the environments the work has arrived in.
 *
 * Its own function because the count is read elsewhere — the bar menu's row says
 * how big the feed is before it is opened — and a second way of counting the same
 * feed is how a row comes to disagree with the panel it opens.
 */
export function signalRows(view: CockpitView): Signal[] {
  return [
    ...groupSignals(view.state.worldEvents),
    ...arrivalSignals(view.state.environmentArrivals ?? [], view.now),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The goal a ref stands under: a goal ref names itself, a pull request resolves
 * through the ticket that owns it, and anything else — a ticketless PR, a `job:`
 * origin, a ref the world has forgotten — resolves to nothing and draws nothing.
 */
function goalBehind(view: CockpitView, ref: string | null): string | null {
  if (ref === null) return null;
  if (/^issue:\d+/.test(ref)) return ref;
  const pr = /^pr:(\d+)/.exec(ref);
  return pr ? goalOfPr(view.state, Number(pr[1])) : null;
}

/**
 * One row of the feed, flattened off whatever produced it.
 *
 * Flat rather than "a `WorldEvent` and a count" because the card draws two
 * different things now — the world's own transitions, and the environments a
 * goal's work has arrived in — and an arrival is deliberately not a world event
 * ({@link arrivalSignals}). Carrying one as the other would need a `kind` the
 * union does not have, cast into it at the one place the row then prints it.
 */
interface Signal {
  key: string;
  /** What kind of thing happened, as the row prints it. */
  kind: string;
  /** The world object it concerns, for the goal link beside the sentence. */
  ref: string | null;
  summary: string;
  createdAt: string;
  count: number;
}

function groupSignals(events: readonly WorldEvent[]): Signal[] {
  const rows = new Map<string, Signal>();
  for (const event of events) {
    const key = `${event.kind}|${event.ref ?? ''}`;
    const seen = rows.get(key);
    // The newest of its group — the server sends newest first, so it is the first seen.
    if (seen) seen.count += 1;
    else
      rows.set(key, {
        key,
        kind: event.kind,
        ref: event.ref,
        summary: event.summary,
        createdAt: event.createdAt,
        count: 1,
      });
  }
  return [...rows.values()];
}

/**
 * The environment arrivals, as signals — merged into the feed here rather than
 * carried in `worldEvents` from the server.
 *
 * **An arrival is deliberately not a `WorldEvent`.** Those are derived by diffing
 * consecutive world snapshots, and a standing delivery verdict is expired by
 * *any* world event on its issue ref (`deliveryHold`) — so an arrival written as
 * one would lift the delivery park on the very goal it announced and hand the
 * work back to the fleet to do again. Adapting it at the feed's own door costs
 * one function and has no such reader.
 *
 * One row per arrival rather than one per `(kind, ref)`: two environments
 * reaching one goal is two things that happened, and rolling them together would
 * hide the second under a count of the first.
 */
function arrivalSignals(arrivals: readonly GoalArrival[], now: number): Signal[] {
  const cutoff = now - SIGNAL_WINDOW_MS;
  return arrivals
    .filter((a) => Date.parse(a.arrivedAt) >= cutoff)
    .map((a) => ({
      key: `arrival|${a.goalRef}|${a.environment}`,
      kind: 'environment',
      ref: a.goalRef,
      summary: `${refLabel(a.goalRef)} reached ${a.environment}`,
      createdAt: a.arrivedAt,
      count: 1,
    }));
}

/**
 * How far back an arrival stays in the feed. The world events beside it are
 * capped at 100 rows by the server and thin out on their own; arrivals are rare
 * enough that a deployment with four environments would otherwise keep last
 * spring's on the card.
 */
const SIGNAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
