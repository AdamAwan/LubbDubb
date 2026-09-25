import type { AppState } from '../types.js';
import { goalIssue, goalOfPr, standsFor } from './goalPage.js';
import type { NeedDestination } from './needsYou.js';

// → docs/spec/17-cockpit.md

export function goalOf(ref: string | null | undefined, state: AppState): string | null {
  const origin = standsFor(state, ref ?? null);
  const m = /^(issue:\d+)/.exec(origin ?? '');
  // TECHDEBT: noUncheckedIndexedAccess makes a capture group read as possibly undefined even once `m`
  // is non-null; the regex guarantees it's set when `m` matches.
  if (m?.[1]) return m[1];
  const pr = /^pr:(\d+)/.exec(origin ?? '');
  return pr?.[1] ? goalOfPr(state, Number(pr[1])) : null;
}

export function agentLabelOf(agentId: string | null, state: AppState): string | null {
  if (agentId === null) return null;
  const agent = state.agents.find((a) => a.id === agentId);
  const title = agent === undefined ? null : (state.tasks.find((t) => t.id === agent.taskId)?.title ?? null);
  const line = title?.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

export function askLine(summary: string, goalRef: string | null, state: AppState): string {
  const issue = goalRef === null ? undefined : goalIssue(state, goalRef);
  if (issue === undefined) return summary;
  const named = new RegExp(`#${issue.number}(?!\\d)`).test(summary);
  return `${summary}${named ? '' : ` for #${issue.number}`} · ${issue.title}`;
}

const MAX_SUMMARY = 110;

/**
 * A summary's first line, clamped. Exported because an ask *body* indexing what is
 * waiting — the threads on an assigned pull request — is asking the same question
 * of the same kind of text, and two clamps drift into two different summaries of
 * one comment.
 *
 * @public shared with the ask bodies in `web/src/console/NeedsBand.tsx`
 */
export function oneLine(text: string | null | undefined): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? '';
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

export function opensAt(goalRef: string | null, state: AppState): NeedDestination {
  return goalRef !== null && goalIssue(state, goalRef) !== undefined ? 'goal' : 'ask';
}

export function predictionOpensAt(goalRef: string | null, state: AppState): NeedDestination {
  return opensAt(goalRef, state) === 'goal' ? 'prediction' : 'ask';
}

export function prAddress(state: AppState, number: number): string | undefined {
  return state.refUrls[`pr:${number}`] ?? state.refUrls[`#${number}`];
}
