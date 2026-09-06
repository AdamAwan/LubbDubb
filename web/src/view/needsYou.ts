import type {
  AppState,
  CockpitDecision,
  Escalation,
  HumanTask,
  PlanPart,
  Proposal,
  SetupCheck,
  SetupPayload,
  SetupVerdict,
  OpenPullRequest,
  ViewerAssignment,
} from '../types.js';
import { goalIssue, goalOfPr, standsFor } from './goalPage.js';
import { updateAskRows } from './updateAsks.js';
import { watchBucket } from '../worldBuckets.js';

// → docs/spec/17-cockpit.md

export type NeedKind =
  | 'config'
  | 'config_gap'
  | 'recovery'
  | 'escalation'
  | 'permission'
  | 'plan'
  | 'reply'
  | 'merge'
  | 'shortfall'
  | 'intake'
  | 'profile'
  | 'placement'
  | 'bench'
  | 'close_out'
  | 'validate'
  | 'watch'
  | 'burn'
  | 'limit'
  | 'supply'
  | 'dispatch'
  | 'assigned'
  | 'upgrade'
  | 'project_pull';

export type NeedGroup = 'blocking' | 'yours';

function assignedPrRows(state: AppState): NeedRow[] {
  const rows: NeedRow[] = [];
  for (const pr of state.world.pullRequests) {
    const assignment = pr.attention?.assignedToYou;
    if (assignment === undefined) continue;
    const goalRef = goalOfPr(state, pr.number);
    rows.push({
      id: `assigned:pr:${pr.number}`,
      kind: 'assigned',
      group: 'yours',
      title: askLine(assignedLine(pr), goalRef, state),
      ...(REVIEWER_NOTE[assignment] === undefined ? {} : { note: REVIEWER_NOTE[assignment] }),
      goalRef,
      originRef: `pr:${pr.number}`,
      opens: prAddress(state, pr.number) === undefined ? opensAt(goalRef, state) : 'provider',
      details: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: pr.attention?.reviewWaitingSince ?? '',
    });
  }
  return rows;
}

const REVIEWER_NOTE: Partial<Record<ViewerAssignment, string>> = {
  'reviewer-required': 'Required reviewer',
  'reviewer-optional': 'Optional reviewer',
};

function assignedLine(pr: OpenPullRequest): string {
  const lead = pr.attention?.reasons[0] ?? '';
  const sentence = lead === '' ? `PR #${pr.number} is yours` : `${lead[0]?.toUpperCase() ?? ''}${lead.slice(1)}`;
  const title = pr.title.trim();
  return oneLine(title === '' ? sentence : `${sentence} on “${title}”`);
}

type NeedDestination = 'goal' | 'ask' | 'config' | 'build' | 'provider' | null;

export interface NeedRow {
  id: string;
  kind: NeedKind;
  group: NeedGroup;
  title: string;
  goalRef: string | null;
  originRef: string | null;
  opens: NeedDestination;
  details?: NeedDestination;
  agentId: string | null;
  agentLabel: string | null;
  note?: string;
  holding: number;
  raisedAt: string;
  check?: SetupCheck;
  applied?: AppliedFix;
}

export interface AppliedFix {
  checkId: string;
  summary: string;
  file: string;
}

export function partHolding(planId: string, slug: string, parts: readonly PlanPart[]): number {
  return parts.filter((p) => p.status !== 'retired' && p.planId === planId && p.dependsOn.includes(slug)).length;
}

function goalOf(ref: string | null | undefined, state: AppState): string | null {
  const origin = standsFor(state, ref ?? null);
  const m = /^(issue:\d+)/.exec(origin ?? '');
  // TECHDEBT: noUncheckedIndexedAccess makes a capture group read as possibly undefined even once `m`
  // is non-null; the regex guarantees it's set when `m` matches.
  if (m?.[1]) return m[1];
  const pr = /^pr:(\d+)/.exec(origin ?? '');
  return pr?.[1] ? goalOfPr(state, Number(pr[1])) : null;
}

function agentLabelOf(agentId: string | null, state: AppState): string | null {
  if (agentId === null) return null;
  const agent = state.agents.find((a) => a.id === agentId);
  const title = agent === undefined ? null : (state.tasks.find((t) => t.id === agent.taskId)?.title ?? null);
  const line = title?.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

function askLine(summary: string, goalRef: string | null, state: AppState): string {
  const issue = goalRef === null ? undefined : goalIssue(state, goalRef);
  if (issue === undefined) return summary;
  const named = new RegExp(`#${issue.number}(?!\\d)`).test(summary);
  return `${summary}${named ? '' : ` for #${issue.number}`} · ${issue.title}`;
}

const MAX_SUMMARY = 110;

function oneLine(text: string | null | undefined): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? '';
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

function commentAuthor(state: AppState, prNumber: unknown, commentId: unknown): string | null {
  if (typeof prNumber !== 'number' || typeof commentId !== 'string') return null;
  const pr = state.world.pullRequests.find((p) => p.number === prNumber);
  return pr?.unresolvedComments.find((c) => c.id === commentId)?.author ?? null;
}

function escalationSummary(
  e: Escalation,
  proposal: Proposal | undefined,
  originRef: string | null,
  state: AppState,
): string {
  const { context } = e;
  const pr = typeof context.prNumber === 'number' ? ` for PR #${context.prNumber}` : '';
  if (proposal) {
    switch (proposal.kind) {
      case 'plan':
        return 'Plan ready';
      case 'plan_amendment':
        return 'Change to a running plan';
      case 'reply_draft': {
        const author = commentAuthor(state, context.prNumber, context.commentId);
        return `Draft reply${author === null ? '' : ` to ${author}`}${pr}`;
      }
      case 'merge':
        return `Merge waiting on your verdict${pr}`;
      case 'shortfall':
        return 'The delivered work did not reach the goal';
    }
  }
  if (context.permission) return oneLine(`${context.permission.toolName}: ${context.permission.summary}`);
  if (isShortfallAsk(originRef)) return 'Assessed as not delivered';
  const questions = Array.isArray(context.questions) ? context.questions.length : 0;
  if (questions > 0) return `${questions} questions from the agent`;
  return oneLine(e.prompt);
}

function holdingForTask(task: HumanTask, parts: readonly PlanPart[]): number {
  if (!task.partId) return 0;
  const step = parts.find((p) => p.id === task.partId);
  return step ? partHolding(step.planId, step.slug, parts) : 0;
}

function holdingForEscalation(e: Escalation, state: AppState): number {
  const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
  const m = /^issue:\d+:part:(.+)$/.exec(originRef ?? '');
  if (!m) return 0;
  const step = (state.planParts ?? []).find((p) => p.slug === m[1]);
  return step ? partHolding(step.planId, step.slug, state.planParts ?? []) : 0;
}

const PROPOSAL_KIND: Record<Proposal['kind'], NeedKind> = {
  plan: 'plan',
  plan_amendment: 'plan',
  reply_draft: 'reply',
  merge: 'merge',
  shortfall: 'shortfall',
};

function isShortfallAsk(originRef: string | null): boolean {
  return /^issue:\d+:shortfall$/.test(originRef ?? '');
}

function kindOf(e: Escalation, proposal: Proposal | undefined, originRef: string | null): NeedKind {
  if (e.context.permission) return 'permission';
  if (proposal) return PROPOSAL_KIND[proposal.kind];
  return isShortfallAsk(originRef) ? 'shortfall' : 'escalation';
}

const TASK_KIND: Record<HumanTask['kind'], NeedKind> = {
  ask: 'bench',
  close_out: 'close_out',
  validate: 'validate',
  watch: 'watch',
  burn: 'burn',
  supply: 'supply',
};

function needKindOfTask(kind: HumanTask['kind']): NeedKind {
  return TASK_KIND[kind];
}

function opensAt(goalRef: string | null, state: AppState): NeedDestination {
  return goalRef !== null && goalIssue(state, goalRef) !== undefined ? 'goal' : 'ask';
}

function prAddress(state: AppState, number: number): string | undefined {
  return state.refUrls[`pr:${number}`] ?? state.refUrls[`#${number}`];
}

const KIND_FOR_VERDICT: Record<SetupVerdict, NeedKind | null> = {
  bad: 'config',
  warn: 'config_gap',
  ok: null,
  unknown: null,
};

function configRows(setup: SetupPayload | null, applied: readonly AppliedFix[]): NeedRow[] {
  if (setup === null) return [];
  return setup.checks
    .filter((check) => {
      if (KIND_FOR_VERDICT[check.verdict] !== null) return true;
      return applied.some((entry) => entry.checkId === check.id);
    })
    .map((check) => ({
      id: `setup:${check.id}`,
      kind: KIND_FOR_VERDICT[check.verdict] ?? 'config_gap',
      group: 'yours' as const,
      title: check.detail,
      goalRef: null,
      originRef: null,
      opens: 'config' as const,
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: '',
      check,
      applied: applied.find((entry) => entry.checkId === check.id),
    }));
}

const REFUSAL_PULSES = 3;

/**
 * A dispatch the executor has refused on every recent pulse, and what the last refusal said.
 *
 * @public read back by the needs band, which draws the refusal in full under the row
 */
export interface RefusedDispatch {
  key: string;
  originRef: string | null;
  branch: string | null;
  pulses: number;
  detail: string;
  rule: string | null;
  since: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function refusedDispatches(state: AppState): RefusedDispatch[] {
  const runs = new Map<string, CockpitDecision[]>();
  const settled = new Set<string>();
  for (const d of state.decisions ?? []) {
    if (d.action.type !== 'dispatch_code_agent' && d.action.type !== 'dispatch_desk_agent') continue;
    const key = d.subjectRef ?? str(d.action.branch);
    if (key === null || settled.has(key)) continue;
    if (d.outcome !== 'rejected') {
      settled.add(key);
      continue;
    }
    const run = runs.get(key);
    if (run) run.push(d);
    else runs.set(key, [d]);
  }
  const out: RefusedDispatch[] = [];
  for (const [key, run] of runs) {
    const pulses = new Set(run.map((d) => d.cycleId)).size;
    if (pulses < REFUSAL_PULSES) continue;
    const newest = run[0];
    const oldest = run[run.length - 1];
    if (!newest || !oldest) continue;
    out.push({
      key,
      originRef: newest.subjectRef,
      branch: str(newest.action.branch),
      pulses,
      detail: newest.detail,
      rule: newest.rule,
      since: oldest.createdAt,
    });
  }
  return out;
}

/**
 * One refused run by its row id, through the same derivation the rail's row came from.
 *
 * @public the needs band resolves the row it was handed back to its refusal
 */
export function refusedDispatchFor(state: AppState, id: string): RefusedDispatch | null {
  return refusedDispatches(state).find((r) => `dispatch:${r.key}` === id) ?? null;
}

function refusalLine(detail: string): string {
  const stop = detail.indexOf('. ');
  if (stop > 0 && stop < 200) return detail.slice(0, stop + 1);
  return detail.length > 200 ? `${detail.slice(0, 199)}…` : detail;
}

function refusedDispatchRows(state: AppState): NeedRow[] {
  return refusedDispatches(state).map((r) => {
    const goalRef = goalOf(r.originRef, state);
    return {
      id: `dispatch:${r.key}`,
      kind: 'dispatch' as const,
      group: 'yours' as const,
      title: askLine(`Refused on ${r.pulses} pulses running — ${refusalLine(r.detail)}`, goalRef, state),
      goalRef,
      originRef: r.originRef ?? r.branch,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: r.since,
    };
  });
}

const GROUP_RANK: Record<NeedGroup, number> = { blocking: 0, yours: 1 };

export function buildNeedsYou(
  state: AppState,
  setup: SetupPayload | null = null,
  applied: readonly AppliedFix[] = [],
  nowIso: string = new Date().toISOString(),
): NeedRow[] {
  const parts = state.planParts ?? [];
  const proposals = state.proposals ?? [];
  const rows: NeedRow[] = [];

  rows.push(...configRows(setup, applied));
  rows.push(...updateAskRows(state, nowIso));
  rows.push(...refusedDispatchRows(state));
  rows.push(...assignedPrRows(state));

  if ((state.recovery ?? []).length > 0) {
    rows.push({
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: `${state.recovery.length} runs were orphaned by a restart`,
      goalRef: null,
      originRef: null,
      opens: null,
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: '',
    });
  }

  for (const e of state.escalations.filter((x) => x.status === 'open')) {
    const proposal = proposals.find((p) => p.escalationId === e.id);
    const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: e.id,
      kind: kindOf(e, proposal, originRef),
      group: 'blocking',
      title: askLine(escalationSummary(e, proposal, originRef, state), goalRef, state),
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId: e.agentId,
      agentLabel: agentLabelOf(e.agentId, state),
      holding: holdingForEscalation(e, state),
      raisedAt: e.createdAt,
    });
  }

  for (const agentId of state.parkedOnLimit) {
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) continue;
    const originRef = state.tasks.find((t) => t.id === agent.taskId)?.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: agentId,
      kind: 'limit',
      group: 'blocking',
      title: askLine(oneLine(agent.waitingReason ?? 'Parked: no usage allowance left right now.'), goalRef, state),
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId,
      agentLabel: agentLabelOf(agentId, state),
      holding: 0,
      raisedAt: agent.startedAt,
    });
  }

  for (const issue of state.world.issues) {
    if (issue.state !== 'open' || issue.appraisal?.verdict !== 'unclear') continue;
    if (watchBucket(issue.labels, state.config.watchLabel) !== 'watched') continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      id: `intake:${goalRef}`,
      kind: 'intake',
      group: 'yours',
      title: askLine('Held at intake', goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: issue.appraisal.decidedAt,
    });
  }

  for (const issue of state.world.issues) {
    const appraisal = issue.appraisal;
    if (!appraisal?.awaitingProfileAnswer || appraisal.proposedProfile === null) continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      id: `profile:${goalRef}`,
      kind: 'profile',
      group: 'yours',
      title: askLine(`Wants to run on “${appraisal.proposedProfile}”`, goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: appraisal.decidedAt,
    });
  }

  for (const issue of state.world.issues) {
    for (const ask of issue.appraisal?.placement ?? []) {
      const goalRef = `issue:${issue.number}`;
      rows.push({
        id: `placement:${ask.field}:${goalRef}`,
        kind: 'placement',
        group: 'yours',
        title: askLine(
          ask.field === 'parent'
            ? ask.proposedParent === null
              ? 'No parent Feature'
              : `No parent — #${ask.proposedParent} proposed`
            : `On no team's board — “${ask.proposedAreaPath}” proposed`,
          goalRef,
          state,
        ),
        goalRef,
        originRef: goalRef,
        opens: opensAt(goalRef, state),
        agentId: null,
        agentLabel: null,
        holding: 0,
        raisedAt: issue.appraisal?.decidedAt ?? '',
      });
    }
  }

  for (const t of (state.humanTasks ?? []).filter((x) => x.status === 'open')) {
    const goalRef = goalOf(t.originRef, state);
    rows.push({
      id: t.id,
      kind: needKindOfTask(t.kind),
      group: 'yours',
      title: askLine(oneLine(t.title), goalRef, state),
      goalRef,
      originRef: t.originRef ?? null,
      opens: opensAt(goalRef, state),
      agentId: t.kind === 'burn' ? t.agentId : null,
      agentLabel: t.kind === 'burn' ? agentLabelOf(t.agentId, state) : null,
      holding: holdingForTask(t, parts),
      raisedAt: t.createdAt,
    });
  }

  return rows.sort((a, b) => {
    if ((a.kind === 'recovery') !== (b.kind === 'recovery')) return a.kind === 'recovery' ? -1 : 1;
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (a.holding !== b.holding) return b.holding - a.holding;
    return a.raisedAt.localeCompare(b.raisedAt);
  });
}
