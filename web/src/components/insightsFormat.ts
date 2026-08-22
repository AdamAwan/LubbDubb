import type { SpendInsights } from '../types.js';

/**
 * The formatting, geometry and one-line readings the Insights tabs share.
 *
 * These were declared twice — once in the spend panel and once in the
 * reliability one — with identical bodies, which was harmless while the two were
 * separate modals and stops being so now that their tabs sit a click apart on
 * one page: a share rounded one way on Economics and another on Causes is the
 * kind of disagreement a reader attributes to the data rather than to the code.
 */

/**
 * A part of a whole, **as a percentage rather than a fraction**, because every
 * caller spends it on a CSS width.
 *
 * A whole of zero is a real state on a young harness and not a fault, so it
 * answers `0` rather than dividing: `NaN%` is a width the browser drops, which
 * draws a category that cost nothing exactly like one that cost everything and
 * failed to render.
 */
export function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** `12%`, and `<1%` rather than `0%` for a slice that is small but not absent. */
export function fmtShare(part: number, whole: number): string {
  const pct = share(part, whole);
  if (pct === 0) return '0%';
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/** A rate as a percentage, or an em dash where there was no denominator at all. */
export function fmtRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/**
 * A span in the largest unit that still reads as a measurement.
 *
 * Minutes below an hour and hours below a day, because these are *waits* — how
 * long a pull request sat red, how long a run took — and "218m" is a number a
 * reader has to convert before it means anything.
 */
export function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

/**
 * How long ago an instant was, in the largest unit that still reads as one.
 *
 * `relTime` is the cockpit's usual answer and stops at hours, which is right
 * everywhere it is used: an agent's note, a world event, a run that ended — all
 * things a page is showing because they are recent. The MCP tab asks the question
 * of an instant that is deliberately **outside** the window ("nothing called this
 * in the last week, and the last call was…"), and that is the first surface in the
 * cockpit where the honest answer is nineteen days. `456h ago` is a number a
 * reader has to convert before it means anything.
 *
 * Deferred to {@link fmtDuration} rather than written again, so an age and a wait
 * on one page are cut at the same units.
 */
export function fmtSince(iso: string, now: number = Date.now()): string {
  return `${fmtDuration(Math.max(0, now - Date.parse(iso)))} ago`;
}

/**
 * The plot box every timeline on the page draws into.
 *
 * One box rather than one per chart, because the tabs are now read against each
 * other: a CI timeline and a cost timeline at different left margins put the
 * same instant at two different x positions, and a reader who spots a spike on
 * one and looks for it on the other finds it somewhere else.
 */
export const PLOT = { left: 34, right: 596, top: 10, bottom: 152 };

/**
 * What local runs came to — the `local` phase's own figure, read off the phase
 * table rather than summed again, so the two cannot disagree.
 *
 * Shared because two tabs need it and neither owns it: Economics puts it in the
 * export, and Work mix says it out loud, because the task-type table is keyed on
 * the dispatch rule that sent the agent and **nothing dispatched a local run** —
 * so that money is in the total above the table and in none of its rows.
 */
export function localPhaseCostUsd(insights: SpendInsights): number {
  return insights.phases.find((p) => p.phase === 'local')?.costUsd ?? 0;
}
