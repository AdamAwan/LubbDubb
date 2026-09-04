/**
 * Surface reach: what an operator looked at, what they did there, and — the
 * reason this exists — what a surface nobody touched actually means.
 *
 * ## It ships verdicts, never counts for a panel to interpret
 *
 * "Nobody opened the feature board this week" is at least four different facts
 * wanting four different actions, and which one it is cannot be recovered from a
 * count. That trap is stated in full at `src/mcpInsights.ts` for the tool channel
 * and transfers here without amendment, so this fold ships
 * {@link SurfaceVerdict} with the evidence behind it rather than three numbers.
 * A cockpit re-deriving the verdict would be a second opinion drawn inches from
 * the first.
 *
 * ## The pairing is the reading this tier exists for
 *
 * A ranking of surfaces is what this produces on the way. What it is *for* is the
 * pairing with the ledger beside it: **an ask answered, against whether the
 * surface the ask is about was ever reached before it was answered.** "Two in
 * five plan approvals happen without the plan ever being opened" is a finding
 * about whether plans are read that no dwell threshold can give, it is a
 * partition rather than an estimate, and it comes free from a fold across the two
 * halves. {@link buildSurfaceReach} ships the reach half keyed on the registry's
 * subject, which is the key `OperatorRow` already carries.
 *
 * **Whether something was *read* is not observable here**, and no column is added
 * to pretend otherwise. Dwell says a surface was open, not that anybody looked;
 * scroll depth is refused outright as the session recording
 * `docs/spec/33-usage-metrics.md#what-this-is-not` will not become.
 *
 * → `docs/spec/33-usage-metrics.md#surface-reach`
 */

import type { SurfaceReach } from './types.js';
import { SUBJECT_LABEL, USAGE_SUBJECTS, VERB_LABEL, type UsageSubject, type UsageVerb } from './usage/events.js';
import { inWindow, type ResolvedWindow } from './insightsWindow.js';

/**
 * What a surface's silence means. The five facts, told apart rather than summed.
 *
 * - `console-dark` — nobody used the cockpit at all in this window, and then no
 *   per-surface reading in it means anything. It outranks every other verdict for
 *   exactly that reason: a page of `linked-never-visited` drawn over a week the
 *   operator was on holiday is four findings' worth of noise.
 * - `never-linked` — the harness has never once carried anybody here from inside
 *   itself. Nobody *could* have reached it except by address, which is a verdict
 *   about the cockpit's own navigation rather than about the operator.
 * - `linked-never-visited` — a link to it exists and has been taken before; in
 *   this window nobody went. The entry point is not landing, or the job never
 *   came up.
 * - `visited-never-operated` — reached, and nothing was done there. The one case
 *   where the silence is the surface's own fault.
 * - `operated` — somebody did something here.
 */
export type SurfaceVerdict =
  | 'console-dark'
  | 'never-linked'
  | 'linked-never-visited'
  | 'visited-never-operated'
  | 'operated';

/** One subject's reading, with the evidence the verdict was drawn from. */
export interface SurfaceRow {
  subject: UsageSubject;
  /**
   * The subject's name, from the registry — shipped rather than looked up, for
   * `CAUSE_COPY`'s reason: `src/wire.ts` carries no runtime, so a cockpit that
   * spelled these itself would be a second copy of a vocabulary the server owns.
   */
  label: string;
  verdict: SurfaceVerdict;
  /** The verdict in the operator's words, and the evidence sentence under it. */
  verdictLabel: string;
  verdictBlurb: string;
  /** `view` rows in the window — the surface was reached this many times. */
  views: number;
  /** Everything that was not a `view`: what was actually done there. */
  operations: number;
  /** How many of the views arrived by a link inside the cockpit, in this window. */
  linkedViews: number;
  /** What was done, by verb, in the window — non-zero only, each with its label. */
  byVerb: { verb: UsageVerb; label: string; count: number }[];
}

export interface SurfaceReachInsights {
  rows: SurfaceRow[];
  /** Every row the window holds, of any subject — the console-dark test. */
  total: number;
  /**
   * Distinct places reached in the window.
   *
   * Shipped because it is the one number that says *how much cockpit* this
   * reading is drawn over: one place and four hundred rows is a reading about one
   * screen, however many subjects it names.
   */
  places: number;
}

interface SurfaceReachRead {
  rows: readonly SurfaceReach[];
  /**
   * Subjects ever reached by a link, over **all time** — the store's unwindowed
   * read, and the whole of what tells `never-linked` from `linked-never-visited`.
   */
  everLinked: ReadonlySet<string>;
  window: ResolvedWindow;
}

export function buildSurfaceReach({ rows, everLinked, window }: SurfaceReachRead): SurfaceReachInsights {
  const inside = rows.filter((r) => inWindow(window, Date.parse(r.at)));
  const dark = inside.length === 0;
  const places = new Set(inside.map((r) => r.place)).size;
  return {
    rows: USAGE_SUBJECTS.map((subject) => row(subject, inside, everLinked, dark)),
    total: inside.length,
    places,
  };
}

function row(
  subject: UsageSubject,
  inside: readonly SurfaceReach[],
  everLinked: ReadonlySet<string>,
  dark: boolean,
): SurfaceRow {
  const mine = inside.filter((r) => r.subject === subject);
  const views = mine.filter((r) => r.verb === 'view');
  const operations = mine.length - views.length;
  const linkedViews = views.filter((r) => r.arrival === 'linked').length;
  const counts = new Map<UsageVerb, number>();
  for (const r of mine) if (r.verb !== 'view') counts.set(r.verb, (counts.get(r.verb) ?? 0) + 1);
  const reading = verdict({ dark, views: views.length, operations, linked: everLinked.has(subject) });
  return {
    subject,
    label: SUBJECT_LABEL[subject],
    verdict: reading,
    verdictLabel: SURFACE_VERDICT_COPY[reading].label,
    verdictBlurb: SURFACE_VERDICT_COPY[reading].blurb,
    views: views.length,
    operations,
    linkedViews,
    byVerb: [...counts].map(([verb, count]) => ({ verb, label: VERB_LABEL[verb], count })),
  };
}

/**
 * The ladder, and its order is the whole of it.
 *
 * `console-dark` first, because a per-surface verdict drawn over a window nobody
 * was in is a finding manufactured out of an absent operator. `never-linked`
 * before `linked-never-visited`, because the two are only ever distinguished by
 * the arrival evidence and the unlinked case is the one that is the harness's own
 * fault. Then whether anything was *done*, which is the question the ranking is
 * actually for.
 */
function verdict(ev: { dark: boolean; views: number; operations: number; linked: boolean }): SurfaceVerdict {
  if (ev.dark) return 'console-dark';
  if (ev.operations > 0) return 'operated';
  if (ev.views > 0) return 'visited-never-operated';
  return ev.linked ? 'linked-never-visited' : 'never-linked';
}

/**
 * What each verdict means, in the operator's words — the server's copy, for
 * `MCP_QUIET_COPY`'s reason: the cockpit never restates a claim about what the
 * harness did.
 */
const SURFACE_VERDICT_COPY: Record<SurfaceVerdict, { label: string; blurb: string }> = {
  'console-dark': {
    label: 'Console dark',
    blurb: 'Nothing was reached at all in this window, so no reading of this surface in it means anything',
  },
  'never-linked': {
    label: 'Never linked',
    blurb: 'Nothing in the cockpit has ever carried anybody here — it is reachable only by address',
  },
  'linked-never-visited': {
    label: 'Linked, never visited',
    blurb: 'A link to it exists and has been taken before; in this window nobody went',
  },
  'visited-never-operated': {
    label: 'Visited, never operated',
    blurb: 'Reached, and nothing was done there — the one case where the silence is the surface’s own',
  },
  operated: { label: 'Operated', blurb: 'Somebody did something here' },
};
