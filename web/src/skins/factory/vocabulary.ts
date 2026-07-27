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
  if (origin.startsWith('story:')) return 'flask';
  return 'chest';
}

/** Which machine a world event is about, so a signal wears the same icon as its work. */
export function iconForEventKind(kind: WorldEventKind): IconName {
  if (kind === 'pr_merged') return 'rocket';
  if (kind === 'pr_comment') return 'chest';
  if (kind.startsWith('pr_')) return 'gear';
  if (kind.startsWith('story_')) return 'flask';
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

/** How urgently a machine's status reads. `bad` is the red one, and stays rationed. */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle' | 'off';

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
