import type { Agent, QueueItem, WorldEventKind } from '../../types.js';
import type { IconName } from './components/Sprite.js';

/**
 * The translation layer: harness nouns in, factory nouns out.
 *
 * Kept pure and in one file so the mapping is stated once. A skin that decided
 * per-component what a `plan-part` looks like would drift — the belt would call
 * it one thing and the bay another — and the whole reason this treatment reads
 * as a machine rather than a costume is that the same work wears the same icon
 * wherever it appears.
 */

/** Which machine draws this piece of work, from its origin ref alone. */
export function iconForOrigin(origin: string | null): IconName {
  if (!origin) return 'chest';
  if (origin.startsWith('pr:')) return 'gear';
  if (origin.startsWith('job:')) return 'chest';
  if (origin.includes(':plan')) return 'blueprint';
  if (origin.includes(':part:')) return 'assembler';
  if (origin.startsWith('issue:')) return 'flask';
  return 'chest';
}

/**
 * Which machine a world event is about, so a signal wears the same icon as its work.
 *
 * The rocket belongs to `issue_closed` and to nothing else. It used to be spent on
 * `pr_merged`, which double-booked it against `iconForStage`'s launch and left the
 * one event that *is* a launch — the goal closing — falling through to a flask. A
 * merge loads a part into the silo; it wears the part's own mark.
 */
export function iconForEventKind(kind: WorldEventKind): IconName {
  if (kind === 'issue_closed') return 'rocket';
  if (kind === 'pr_merged') return 'pr';
  if (kind === 'pr_comment') return 'chest';
  if (kind.startsWith('pr_')) return 'gear';
  return 'flask';
}

/**
 * How a bay reads. `idle` is the only red thing on the floor, and it means
 * exactly one thing — the agent is parked on a question only you can answer.
 */
export function botState(agent: Agent): 'working' | 'idle' | 'spent' {
  if (agent.status === 'waiting') return 'idle';
  if (agent.status === 'running' || agent.status === 'starting') return 'working';
  return 'spent';
}

/**
 * How urgently a machine's status reads. `bad` is the red one, and stays rationed.
 *
 * `ghost` and `next` arrived with the Goal Floor and are not shades of the five
 * above: a ghost is *drawn but not built* — an unapproved decomposition, a part
 * whose prerequisite has not merged — which is neither a fault nor an idle
 * machine, and `next` is the one thing that could start now, which had been
 * reading as `warn` and so as a mild fault.
 */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle' | 'off' | 'ghost' | 'next';

/**
 * A tone's colour, for the SVG half of the floor.
 *
 * The HTML half styles tones by class, but SVG attributes want a value, and
 * having the two read the same token here is what stops a bay and a silo
 * disagreeing about what "warn" looks like.
 */
export function toneColor(tone: StatusTone): string {
  switch (tone) {
    case 'ok':
      return 'var(--green)';
    case 'warn':
      return 'var(--amber)';
    case 'bad':
      return 'var(--red)';
    case 'idle':
      return 'var(--blue)';
    case 'off':
      return 'var(--grey)';
    case 'ghost':
      return 'var(--fx-ghost)';
    case 'next':
      return 'var(--accent)';
  }
}

/**
 * The word painted on a machine, in the game's vocabulary rather than the
 * harness's.
 *
 * This replaces the old two-word `beltTag`, and the reason is that the game
 * already has a word for every one of these states — an assembler that has
 * nothing to consume says *no ingredients*, one whose output nobody is taking
 * says *output full* — and those words carry a diagnosis that "Cooling down"
 * does not. Both halves of the floor render through here, so a bay and a crate
 * can never describe the same condition two ways.
 */
export interface MachineStatus {
  word: string;
  tone: StatusTone;
}

/**
 * A bay's status. Paused wins over everything: a floor with no power is not
 * *also* meaningfully idle, and saying both would bury the one fact that
 * explains every other machine on screen.
 */
export function bayMachineStatus(agent: Agent | null, paused: boolean): MachineStatus {
  if (paused) return { word: 'No power', tone: 'off' };
  if (!agent) return { word: 'Awaiting an item', tone: 'idle' };
  if (agent.status === 'waiting') return { word: 'Output full', tone: 'bad' };
  if (agent.status === 'running' || agent.status === 'starting') return { word: 'Working', tone: 'ok' };
  return { word: 'Shift ended', tone: 'off' };
}

/**
 * A queued item's status.
 *
 * Note the two different `waiting`s this keeps apart, which is most of the value
 * of routing both through one file: an *agent* that is waiting is parked on a
 * human, while an *item* that is waiting merely has no free bay. Red is reserved
 * for the first. `unapproved` earns it too — an undecided decomposition is
 * likewise parked on a question only the operator can answer.
 */
export function crateMachineStatus(item: QueueItem, paused: boolean): MachineStatus {
  if (paused) return { word: 'No power', tone: 'off' };
  switch (item.status) {
    case 'dispatching':
      return { word: 'Boarding', tone: 'ok' };
    case 'waiting':
      return { word: 'No bot free', tone: 'idle' };
    case 'cooldown':
      return { word: 'No ingredients', tone: 'warn' };
    case 'capped':
      return { word: 'Output backed up', tone: 'warn' };
    case 'unapproved':
      return { word: 'Not connected', tone: 'bad' };
    case 'superseded':
      // Not this station's turn rather than anything wrong with it: another one
      // upstream is still deciding what this goal even is, so `idle` like
      // `waiting` and not a warning.
      return { word: 'At inspection', tone: 'idle' };
  }
}

/** What an inserter is doing: moving an item, parked with nothing to move, or dead. */
export type InserterPhase = 'transfer' | 'rest' | 'off';

/**
 * An inserter swings when something *moves*, not while a bay happens to be
 * occupied — which is what it used to mean, and why every arm on the floor
 * swung continuously and said nothing.
 *
 * A transfer is a dispatch, so the swing lasts one heartbeat from the agent's
 * start and then rests. Reading the agent's own `startedAt` rather than the
 * decision log keeps this a property of the bay being drawn: an arm cannot swing
 * for a dispatch that landed in some other bay.
 */
export function inserterPhase(agent: Agent | null, now: number, intervalMs: number): InserterPhase {
  if (!agent) return 'off';
  if (agent.status !== 'running' && agent.status !== 'starting') return 'rest';
  const started = Date.parse(agent.startedAt);
  if (Number.isNaN(started)) return 'rest';
  return now - started < intervalMs ? 'transfer' : 'rest';
}

/** Which wire a signal travels on: did the world get better, worse, or merely move. */
export type SignalPolarity = 'up' | 'down' | 'neutral';

/**
 * Polarity from the event *kind* alone, never from its summary.
 *
 * The summary is prose written for a human — "CI failing on PR #142" — and
 * parsing it here would be a second reader of a string nobody promised to keep
 * stable, disagreeing with the event silently the first time the wording
 * changed. So `pr_ci` is neutral: the kind genuinely does not say which way CI
 * went, and a grey wire is honest where a guessed green one is not.
 */
export function signalPolarity(kind: WorldEventKind): SignalPolarity {
  switch (kind) {
    case 'pr_merged':
    case 'pr_approved':
    case 'pr_mergeable':
    case 'issue_closed':
      return 'up';
    case 'pr_closed':
      return 'down';
    default:
      return 'neutral';
  }
}

/**
 * SVG has no ellipsis and no wrapping, so text bound for the floor plan is cut
 * here rather than hoping it fits.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* ======================= the Goal Floor's own nouns =======================
 *
 * One arm per stage of `docs/workflow.md`, beside `bayMachineStatus` and
 * `crateMachineStatus` rather than inside the floor's component, for the reason
 * stated at the top of this file: the floor draws the same work in a rail, in a
 * plate and in the patch strip, and a stage that answered differently in two of
 * them would be a costume rather than a view.
 *
 * Each closed input set is a `Record`, not a `switch` with a default: a status
 * added to the harness then fails `typecheck:web` on the day it is written,
 * rather than rendering a blank word at 3am. The lookups are functions so the
 * exhaustive test has one thing to call.
 */

/** Whether a machine is built, drawn-but-not-built, or never reached at all. */
export type MachinePresence = 'built' | 'ghost' | 'unbuilt';

/** Every stage of the workflow that is a machine. Fixtures are not in here. */
export type FloorStage =
  | 'patch'
  | 'assay'
  | 'furnace'
  | 'assembler'
  | 'pr'
  | 'silo'
  | 'satellite'
  | 'manifest'
  | 'signal'
  | 'launch';

const STAGE_ICONS: Record<FloorStage, IconName> = {
  patch: 'patch',
  assay: 'drill',
  furnace: 'furnace',
  assembler: 'assembler',
  pr: 'pr',
  silo: 'chest',
  satellite: 'satellite',
  manifest: 'doc',
  signal: 'signal',
  launch: 'rocket',
};

/** Which machine draws a stage. One mapping, so the strip and the floor agree. */
export function iconForStage(stage: FloorStage): IconName {
  return STAGE_ICONS[stage];
}

/**
 * A plan part's progress, folded from `PlanPart.status` by `partProgress` — the
 * structural half, so this file decides only what it is *called*.
 */
export type PartProgress = 'shipped' | 'building' | 'ready' | 'locked' | 'blocked';

/** Every `issuePickupStatus` verdict, as the ore patch reads it. */
type PickupStatus =
  | 'done'
  | 'has_pr'
  | 'active'
  | 'ignored'
  | 'unwatched'
  | 'planning'
  | 'delivered'
  | 'assay'
  | 'cooldown'
  | 'escalated'
  | 'blocked'
  | 'eligible';

const PATCH_WORDS: Record<PickupStatus, MachineStatus> = {
  // "Worked out" rather than "empty": a delivered goal is a patch that gave up
  // everything it had, which is the good ending, not an absence.
  done: { word: 'Worked out', tone: 'ok' },
  delivered: { word: 'Worked out', tone: 'ok' },
  has_pr: { word: 'Being mined', tone: 'ok' },
  active: { word: 'Being mined', tone: 'ok' },
  planning: { word: 'Being mined', tone: 'ok' },
  eligible: { word: 'Ready to mine', tone: 'next' },
  // The patch is untouched *because a drill said so* — the drill carries the
  // reason, so the patch says only that nothing has been taken out of it.
  assay: { word: 'Untouched', tone: 'idle' },
  cooldown: { word: 'Between shifts', tone: 'warn' },
  escalated: { word: 'Needs you', tone: 'bad' },
  blocked: { word: 'No power', tone: 'off' },
  ignored: { word: 'Left alone', tone: 'off' },
  unwatched: { word: 'No claim staked', tone: 'off' },
};

/**
 * The ore patch — a ticket, and the head of every floor.
 *
 * An unknown status falls back rather than rendering blank: the snapshot is a
 * wire format and a cockpit may be a version behind its server.
 */
export function patchStatus(status: string): MachineStatus {
  return PATCH_WORDS[status as PickupStatus] ?? { word: 'Unsurveyed', tone: 'off' };
}

/**
 * The assay drill (rule `issue-assay`).
 *
 * There are only two verdicts because the third — nobody has judged this goal —
 * is drawn by there being **no drill on the floor at all**. That is the whole
 * point of #158 having given intake a verdict, and a third word here would put
 * the feature back: an absent machine and a stopped one must not be told apart
 * by reading their captions.
 */
export function assayStatus(verdict: 'workable' | 'unclear'): MachineStatus {
  return verdict === 'workable' ? { word: 'Cleared', tone: 'ok' } : { word: 'Stopped', tone: 'bad' };
}

/** Every `Plan.status`, as the furnace reads it. */
type PlanStatus = 'planning' | 'single' | 'awaiting_approval' | 'active' | 'complete' | 'abandoned';

const FURNACE_WORDS: Record<PlanStatus, MachineStatus> = {
  planning: { word: 'Smelting', tone: 'idle' },
  // A `single` verdict is a decision, not an absence: the planner read the
  // repository and said one pull request will do. Nothing drew that before.
  single: { word: 'No splitter', tone: 'ok' },
  awaiting_approval: { word: 'Blueprint on the desk', tone: 'ghost' },
  active: { word: 'Plan active', tone: 'ok' },
  complete: { word: 'Plan complete', tone: 'ok' },
  abandoned: { word: 'Gone cold', tone: 'off' },
};

/** The furnace — the planner (rule `issue-plan`). A floor with no plan draws it unbuilt. */
export function furnaceStatus(status: string): MachineStatus {
  return FURNACE_WORDS[status as PlanStatus] ?? { word: 'Gone cold', tone: 'off' };
}

const ASSEMBLER_WORDS: Record<PartProgress, MachineStatus> = {
  shipped: { word: 'Shipped', tone: 'ok' },
  building: { word: 'Working', tone: 'idle' },
  ready: { word: 'Ready to start', tone: 'next' },
  locked: { word: 'Locked', tone: 'ghost' },
  blocked: { word: 'Jammed', tone: 'bad' },
};

/**
 * An assembly machine — one plan part.
 *
 * `ahead` is how many merges are still owed before it can start, and it is a
 * count rather than a name because a merger waits on several: "locked · 2 ahead"
 * is the one reading a chain never had to give.
 *
 * A part of an unapproved plan says **not connected** whatever its own status —
 * every part of such a plan is `ready`, and drawing five ready machines that no
 * bot will ever reach is the invisibility `unapproved` was added to `QueueItem`
 * to fix.
 */
export function assemblerStatus(progress: PartProgress, opts: { ghost?: boolean; ahead?: number }): MachineStatus {
  if (opts.ghost) return { word: 'Not connected', tone: 'ghost' };
  const base = ASSEMBLER_WORDS[progress];
  if (progress === 'locked' && (opts.ahead ?? 0) > 0) {
    return { word: `Locked · ${opts.ahead} ahead`, tone: base.tone };
  }
  return base;
}

/** What a pull request machine is doing, from the verdicts already on the PR. */
export type PrMachineReading = 'shipped' | 'scrapped' | 'repairing' | 'held' | 'blocked' | 'on_the_pad';

const PR_WORDS: Record<PrMachineReading, MachineStatus> = {
  shipped: { word: 'Shipped', tone: 'ok' },
  // Closed without merging. Never inferred from a PR disappearing — the server
  // only sets `state: 'closed'` on an abandonment it actually observed.
  scrapped: { word: 'Scrapped', tone: 'off' },
  repairing: { word: 'Repair en route', tone: 'bad' },
  held: { word: 'Held — not ours', tone: 'warn' },
  blocked: { word: 'Held', tone: 'warn' },
  on_the_pad: { word: 'On the pad', tone: 'ok' },
};

export function prMachineStatus(reading: PrMachineReading): MachineStatus {
  return PR_WORDS[reading];
}

/**
 * One scanner on the belt — a quality gate.
 *
 * The states are the arms of the CI classification verdict plus the two a
 * *passing* or *pending* gate needs, and never a check's name: a floor running
 * against a config naming any check at all renders correctly with no code change
 * here, which is why no check name from any workplace appears in this repository.
 */
export type ScannerState = 'pass' | 'damaged' | 'not_ours' | 'muted' | 'awaiting';

const SCANNER_WORDS: Record<ScannerState, MachineStatus> = {
  pass: { word: 'pass', tone: 'ok' },
  damaged: { word: 'damaged', tone: 'bad' },
  // The rule for this check says wait, so no bot is sent — and the reason
  // travels to the one that is (`ciFailureNote`), which is why it is named here
  // rather than hidden.
  not_ours: { word: 'not ours', tone: 'warn' },
  muted: { word: 'muted', tone: 'off' },
  awaiting: { word: 'awaiting', tone: 'idle' },
};

export function scannerStatus(state: ScannerState): MachineStatus {
  return SCANNER_WORDS[state];
}

/** The silo — the goal filling with delivered parts. */
export function siloStatus(filled: number, total: number): MachineStatus {
  if (total === 0) return { word: 'No recipe', tone: 'off' };
  if (filled >= total) return { word: 'Full', tone: 'ok' };
  return filled === 0 ? { word: 'Empty', tone: 'idle' } : { word: 'Filling', tone: 'idle' };
}

/**
 * What the goal check (rule `issue-assess`) has said, if anything.
 *
 * Three readings, because rule `issue-assess` writes exactly two rows — a delivery and a
 * shortfall — and the third reading is their absence. There was a fourth,
 * `more_work`, and it was unreachable: it was gated on the *conclusion* fold
 * returning `by: 'assessor'`, which only ever comes back out of the shortfall
 * arm, and a shortfall reads `returned` before that arm is consulted. Two words
 * for one row is two answers to one question, so it is gone rather than kept
 * against a future that already has a word for it.
 */
export type SatelliteReading = 'unbuilt' | 'verified' | 'returned';

const SATELLITE_WORDS: Record<SatelliteReading, MachineStatus> = {
  unbuilt: { word: 'Not yet built', tone: 'off' },
  verified: { word: 'Verified', tone: 'ok' },
  returned: { word: 'Sent it back', tone: 'bad' },
};

export function satelliteStatus(reading: SatelliteReading): MachineStatus {
  return SATELLITE_WORDS[reading];
}

/**
 * The manifest — the run's own write-up, off `issue.retrospective`.
 *
 * It reads the retrospective rather than the working agent's conclusion note
 * because the station's name is a claim about the *run*: a note saying "done" is a
 * verdict on the goal, not an account of how it was reached. The note still draws,
 * beneath the summary — two different claims, both worth having.
 */
export function manifestStatus(hasRetro: boolean): MachineStatus {
  return hasRetro ? { word: 'Filed', tone: 'ok' } : { word: 'Nothing written', tone: 'off' };
}

/**
 * Whether the plan's status comment has been written, has not been yet, or could
 * never have been.
 *
 * Three readings rather than two, and the third is the point: an unplanned issue
 * has no plan row at all, so there is nothing that *could* have written a
 * comment, while a plan whose reconciler has not written one yet has a writer
 * that has not spoken. Folding them together would report the funnel being off
 * as a machine that fell silent.
 */
export type StatusCommentReading = 'written' | 'unwritten' | 'no_plan';

/**
 * A word per combination, as a closed fold: the two signals the harness can put
 * on a ticket are the state move and the status comment, and every pairing of
 * them is a real reading that gets said out loud. An arm rendering blank because
 * a combination went unconsidered is the failure this shape removes.
 */
const SIGNAL_WORDS: Record<'moved' | 'no_state', Record<StatusCommentReading, MachineStatus>> = {
  moved: {
    written: { word: 'Posted', tone: 'ok' },
    // The state went out and no notice did — not a fault, since the reconciler
    // writes only when there is news, so this is a partial post rather than a jam.
    unwritten: { word: 'State posted', tone: 'ok' },
    // Nothing was owed a notice, so moving the state is the whole of the job.
    no_plan: { word: 'Posted', tone: 'ok' },
  },
  no_state: {
    written: { word: 'Notice posted', tone: 'ok' },
    // Something could have gone out and nothing did.
    unwritten: { word: 'Nothing posted', tone: 'off' },
    // Nothing could have: no workflow state on this provider, and no plan.
    no_plan: { word: 'Nothing to post', tone: 'off' },
  },
};

/**
 * The signal post — update the ticket.
 *
 * It claims **both** signals the harness actually sends: the work item's state
 * move, and the plan's one living status comment (#171). A plan that has written
 * no comment says so rather than falling silent — with `statusCommentRef` on the
 * wire both states are real readings, where before a second line here would have
 * been a machine reading a field the cockpit could not see.
 *
 * Quality-pillar commentary is still not drawn, for the stronger version of that
 * older reason — nothing in the harness writes it at all.
 */
export function signalPostStatus(
  workItemState: string | null | undefined,
  comment: StatusCommentReading,
): MachineStatus {
  return SIGNAL_WORDS[workItemState ? 'moved' : 'no_state'][comment];
}

/** The launch — `delivered`, or a launch that failed verification. */
export function launchStatus(returned: boolean): MachineStatus {
  return returned ? { word: 'Returned', tone: 'bad' } : { word: 'Away', tone: 'ok' };
}

/**
 * Where a shortfall sends the work back to, in the floor's own terms.
 *
 * The cause is *declared* by the assessor, never derived — deriving it would
 * route every shortfall to a replan — so the three arms stay three, and a
 * shortfall naming nothing is a fourth answer rather than a guessed `goal`.
 */
export function returnRoute(cause: 'plan' | 'part' | 'goal' | null): string {
  switch (cause) {
    case 'plan':
      return 'back to the furnace';
    case 'part':
      return 'one more assembler';
    case 'goal':
      return 'back to the patch';
    default:
      return 'no route named';
  }
}
