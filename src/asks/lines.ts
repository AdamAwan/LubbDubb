import type { Issue, PullRequest } from '../wire.js';
import type { AskDestination } from './askRow.js';
import type { AskInputs } from './queue.js';

// → docs/spec/17-cockpit.md#a-row-is-one-factual-line

const STANDS_FOR_DEPTH = 4;
const MAX_SUMMARY = 110;

/** A `job:<id>` origin read through to the work it redoes. → docs/spec/17-cockpit.md#a-job-origin-stands-in-for-other-work */
function standsFor(state: AskInputs, originRef: string | null): string | null {
  let ref = originRef;
  for (let hop = 0; ref !== null && hop < STANDS_FOR_DEPTH; hop++) {
    const id = /^job:(.+)$/.exec(ref)?.[1];
    if (id === undefined) return ref;
    const job = state.jobs.find((j) => j.id === id);
    if (!job || job.originRef === null) return ref;
    ref = job.originRef;
  }
  return ref;
}

function closedPrs(state: AskInputs): PullRequest[] {
  const byNumber = new Map<number, PullRequest>();
  for (const pr of state.archivedPullRequests ?? []) byNumber.set(pr.number, pr);
  for (const pr of state.world.closedPullRequests ?? []) byNumber.set(pr.number, pr);
  return [...byNumber.values()];
}

function branchGoal(branch: string): string | null {
  const m = /^issue\/(\d+)(?:\/|$)/.exec(branch);
  return m ? `issue:${m[1]}` : null;
}

export function goalOfPr(state: AskInputs, prNumber: number): string | null {
  const part = (state.planParts ?? []).find((p) => p.prNumber === prNumber);
  const plan = part ? (state.plans ?? []).find((pl) => pl.id === part.planId) : undefined;
  if (plan) return plan.originRef;

  const linked = state.world.issues.find((i) => i.linkedPrNumber === prNumber);
  if (linked) return `issue:${linked.number}`;

  const pr = [...state.world.pullRequests, ...closedPrs(state)].find((p) => p.number === prNumber);
  return pr ? branchGoal(pr.branch) : null;
}

function goalIssue(state: AskInputs, ref: string): Issue | undefined {
  const number = Number(/^issue:(\d+)$/.exec(ref)?.[1]);
  if (!Number.isFinite(number)) return undefined;
  return (
    state.world.issues.find((i) => i.number === number) ?? (state.retainedRuns ?? []).find((i) => i.number === number)
  );
}

export function goalOf(ref: string | null | undefined, state: AskInputs): string | null {
  const origin = standsFor(state, ref ?? null);
  const m = /^(issue:\d+)/.exec(origin ?? '');
  if (m?.[1]) return m[1];
  const pr = /^pr:(\d+)/.exec(origin ?? '');
  return pr?.[1] ? goalOfPr(state, Number(pr[1])) : null;
}

export function agentLabelOf(agentId: string | null, state: AskInputs): string | null {
  if (agentId === null) return null;
  const agent = state.agents.find((a) => a.id === agentId);
  const title = agent === undefined ? null : (state.tasks.find((t) => t.id === agent.taskId)?.title ?? null);
  const line = title?.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

export function askLine(summary: string, goalRef: string | null, state: AskInputs): string {
  const issue = goalRef === null ? undefined : goalIssue(state, goalRef);
  if (issue === undefined) return summary;
  const named = new RegExp(`#${issue.number}(?!\\d)`).test(summary);
  return `${summary}${named ? '' : ` for #${issue.number}`} · ${issue.title}`;
}

export function oneLine(text: string | null | undefined): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? '';
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

/** Only a goal with a page is a destination, asked through the same lookup the goal page is built on. */
export function opensAt(goalRef: string | null, state: AskInputs): AskDestination {
  return goalRef !== null && goalIssue(state, goalRef) !== undefined ? 'goal' : 'ask';
}

export function predictionOpensAt(goalRef: string | null, state: AskInputs): AskDestination {
  return opensAt(goalRef, state) === 'goal' ? 'prediction' : 'ask';
}

export function prAddress(state: AskInputs, number: number): string | undefined {
  return state.refUrls[`pr:${number}`] ?? state.refUrls[`#${number}`];
}
