import type { CockpitState } from '../wire.js';
import type { SetupReading } from '../setup/reading.js';
import type { AskGroup, AskKind, AskRow, AskUrgency } from './askRow.js';
import { updateAskRows } from './updateAsks.js';
import { intakeRows, placementRows, profileRows, sittingRows } from './issueAsks.js';
import { refusedDispatchRows } from './refusedDispatches.js';
import { assignAskRows, assignedPrRows, botPrRows, descriptionFeedbackRows, undescribedPartRows } from './prAsks.js';
import { configRows, escalationRows, humanTaskRows, limitRows, recoveryRows } from './inboxAsks.js';

// → docs/spec/17-cockpit.md#one-list-for-the-cockpit-and-for-claude-code

/** The snapshot fields the queue is derived from — a full `CockpitState` is one. */
export type AskInputs = Pick<
  CockpitState,
  | 'build'
  | 'recovery'
  | 'escalations'
  | 'proposals'
  | 'tasks'
  | 'agents'
  | 'parkedOnLimit'
  | 'humanTasks'
  | 'decisions'
  | 'refUrls'
  | 'jobs'
  | 'plans'
  | 'planParts'
  | 'undescribedParts'
  | 'descriptionFeedback'
  | 'archivedPullRequests'
  | 'retainedRuns'
> & {
  world: Pick<CockpitState['world'], 'takenAt' | 'pullRequests' | 'closedPullRequests' | 'issues'>;
  config: Pick<CockpitState['config'], 'watchLabel' | 'desktopFolder'>;
};

/** The standing asks in the one-at-a-time order, beside the inputs they were derived from. */
export interface AskSnapshot {
  queue: AskRow[];
  inputs: AskInputs;
}

/** A row as its source writes it; the tier, the standing and the Focus rank are added in one pass. */
export type AskDraft = Omit<AskRow, 'urgency' | 'focusRank' | 'standing'> & { standing?: boolean };

/** Total over {@link AskKind}, so a new kind is placed deliberately. → docs/spec/17-cockpit.md#urgency-is-the-rails-first-cut */
const KIND_URGENCY: Record<AskKind, AskUrgency> = {
  recovery: 'now',
  escalation: 'now',
  permission: 'now',
  dispatch: 'now',
  config: 'now',
  plan: 'now',
  merge: 'now',
  reply: 'next',
  // → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer
  describe: 'next',
  // → docs/spec/07-pull-requests.md#what-the-check-raises
  description_wrong: 'next',
  description_note: 'later',
  shortfall: 'next',
  intake: 'next',
  sitting: 'now',
  profile: 'next',
  close_out: 'next',
  validate: 'next',
  validation_plan: 'next',
  bench: 'next',
  config_gap: 'next',
  supply: 'next',
  limit: 'later',
  watch: 'later',
  unwatched: 'next',
  burn: 'later',
  placement: 'later',
  assigned: 'later',
  // → docs/spec/07-pull-requests.md#asking-who-should-look-at-it
  assign: 'next',
  // → docs/spec/37-bot-prs.md#one-put-on-you-that-is-in-trouble
  bot_pr: 'next',
  upgrade: 'later',
  project_pull: 'later',
};

/** Parts held downstream promote any ask to `now`, whatever its kind. */
function urgencyOf(row: AskDraft): AskUrgency {
  return row.holding > 0 ? 'now' : KIND_URGENCY[row.kind];
}

/**
 * How far along the work behind the ask is — a part's own life run backwards — which breaks a tie
 * between two asks holding the same number of parts in the one-at-a-time order.
 * → docs/spec/17-cockpit.md#one-ask-at-a-time
 */
const STAGE_RANK: Record<AskKind, number> = {
  merge: 0,
  describe: 1,
  description_wrong: 1,
  description_note: 1,
  reply: 1,
  assigned: 1,
  assign: 1,
  bot_pr: 1,
  validate: 2,
  validation_plan: 2,
  bench: 2,
  close_out: 2,
  shortfall: 2,
  escalation: 3,
  permission: 3,
  recovery: 3,
  plan: 3,
  dispatch: 3,
  limit: 3,
  burn: 3,
  intake: 4,
  sitting: 3,
  profile: 4,
  placement: 4,
  unwatched: 4,
  watch: 4,
  supply: 4,
  config: 5,
  config_gap: 5,
  upgrade: 5,
  project_pull: 5,
};

const GROUP_RANK: Record<AskGroup, number> = { blocking: 0, yours: 1 };
const URGENCY_RANK: Record<AskUrgency, number> = { now: 0, next: 1, later: 2 };

type Ranked = Omit<AskRow, 'focusRank'>;

function railOrder(a: Ranked, b: Ranked): number {
  if ((a.kind === 'recovery') !== (b.kind === 'recovery')) return a.kind === 'recovery' ? -1 : 1;
  if (a.urgency !== b.urgency) return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
  if (a.holding !== b.holding) return b.holding - a.holding;
  return a.raisedAt.localeCompare(b.raisedAt);
}

/** @public the order Focus mode walks, pinned by `test/overviewAskOrder.test.ts`. */
export function focusOrder(a: Ranked, b: Ranked): number {
  if (a.urgency !== b.urgency) return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (a.holding !== b.holding) return b.holding - a.holding;
  const stage = STAGE_RANK[a.kind] - STAGE_RANK[b.kind];
  if (stage !== 0) return stage;
  return a.raisedAt.localeCompare(b.raisedAt);
}

/**
 * Every ask on the deployment, in the rail's order, each carrying its place in the one-at-a-time
 * order as `focusRank`. Pure over the snapshot, so the cockpit, Claude Code and the demo read one
 * derivation. → docs/spec/17-cockpit.md#one-list-for-the-cockpit-and-for-claude-code
 */
export function buildAskQueue(
  state: AskInputs,
  setup: SetupReading | null = null,
  nowIso: string = new Date().toISOString(),
): AskRow[] {
  const drafts: AskDraft[] = [
    ...configRows(setup),
    ...updateAskRows(state, nowIso),
    ...refusedDispatchRows(state),
    ...assignedPrRows(state),
    ...botPrRows(state),
    ...assignAskRows(state),
    ...undescribedPartRows(state),
    ...descriptionFeedbackRows(state),
    ...recoveryRows(state),
    ...escalationRows(state),
    ...limitRows(state),
    ...intakeRows(state),
    ...sittingRows(state),
    ...profileRows(state),
    ...placementRows(state),
    ...humanTaskRows(state),
  ];
  const rail: Ranked[] = drafts
    .map((row) => ({ ...row, standing: row.standing ?? true, urgency: urgencyOf(row) }))
    .sort(railOrder);
  const focus = new Map([...rail].sort(focusOrder).map((row, i) => [row, i]));
  return rail.map((row) => ({ ...row, focusRank: focus.get(row) ?? 0 }));
}
