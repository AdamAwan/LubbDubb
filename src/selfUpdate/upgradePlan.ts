import type { UpgradeIntent } from '../types.js';
import type { BuildStanding } from './buildStanding.js';

/**
 * Whether an update can be taken, and what taking it costs right now — the pure
 * half of self-upgrade. Nothing here reads the store, the clock or git. Every
 * refusal is words, not a boolean. `UpgradeIntent` runs `idle` → `draining` →
 * `ready` → `applying`; `applying` is the marker the *next* boot reads, so
 * agents it finds interrupted under it were interrupted deliberately.
 * → `docs/spec/21-self-update.md`
 */

/** How the harness watches its own build. See `Config.selfUpdate`. */
export interface SelfUpdatePolicy {
  /** Off means no check, no gauge and no upgrade route — the behaviour before this existed. */
  enabled: boolean;
  /** The remote the install directory's updates come from. */
  remote: string;
  /** The branch on it that releases land on. Not `defaultBranch`, which is the *worked* repo's. */
  branch: string;
  /** A floor on how often the remote is touched, not on how fresh the answer is served. */
  checkIntervalMs: number;
  /** Take an update on the fleet's behalf: drain when one lands, hand off when the drain runs dry. */
  autoUpdate: boolean;
  /**
   * How long an automatic drain waits for the fleet before it stops waiting and
   * interrupts what is left. Zero waits forever.
   */
  drainDeadlineMs: number;
  /**
   * Fast-forward the *worked* checkout on its own, whenever {@link projectPullability}
   * says it can. Separate from {@link autoUpdate}: a different repository and an act
   * that interrupts nothing. The project config layer arrives by exactly this pull.
   * → [02](docs/spec/02-configuration.md#the-project-layer)
   */
  projectAutoPull: boolean;
  /** How long the rail's Snooze buys on either update ask. One key for both, so the two cannot drift. */
  snoozeMs: number;
}

/** `1 commit` / `2 commits` — these sentences are drawn on the rail, where `commit(s)` reads as a stray placeholder. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The resting intent — what a database with no row, and a finished upgrade, both read as. */
export const IDLE_INTENT: UpgradeIntent = { state: 'idle', targetSha: null, requestedAt: null, pausedByDrain: false };

/**
 * Whether an update can be applied at all, and why not when it cannot.
 *
 * @public shipped on {@link BuildReading.projectPull}, which the build panel's
 * project section reads to decide whether to draw its Pull control and what to say
 * instead.
 */
export interface Upgradability {
  /** There is something to take, and taking it is a clean fast-forward. */
  can: boolean;
  blocked: string | null;
}

/**
 * Can this build take what is waiting? Deliberately says nothing about whether
 * anything is running — that is the drain's question. **`ahead > 0` is a refusal,
 * not a warning**: the supervisor applies with `pull --ff-only`, which fails on a
 * build carrying its own commits.
 */
export function upgradability(standing: BuildStanding, project?: BuildStanding | null): Upgradability {
  if (standing.unavailable) return { can: false, blocked: standing.unavailable };
  if (standing.behind === 0) return { can: false, blocked: 'this build is current — there is nothing to take' };
  if (standing.dirty)
    return {
      can: false,
      blocked: 'the install directory has uncommitted changes to tracked files; commit or stash them before upgrading',
    };
  // The *worked* repository, on the same terms: an upgrade restarts the harness and
  // walks over uncommitted work in the checkout its worktrees were cut from. A
  // project reading that could not be *taken* is not a refusal — an unreachable
  // project remote must never take the upgrade button away.
  if (project?.dirty === true)
    return {
      can: false,
      blocked:
        'the project checkout has uncommitted changes to tracked files — an upgrade restarts the harness and ' +
        'interrupts the agents working from it; commit or stash them first',
    };
  if (standing.ahead > 0)
    return {
      can: false,
      blocked:
        `this build carries ${plural(standing.ahead, 'commit')} of its own, so the update is not a fast-forward — ` +
        'merge or rebase it by hand',
    };
  return { can: true, blocked: null };
}

/**
 * Can the **project** checkout take what is waiting on its remote? The same
 * questions as {@link upgradability}, worded for a different repository. One arm
 * has no counterpart there: **the checkout must be on the branch being pulled** —
 * a `--ff-only` pull from another branch merges instead of fast-forwarding. It is
 * checked first, because `behind`, `ahead` and `dirty` are read against that HEAD.
 */
export function projectPullability(standing: BuildStanding | null, branch: string): Upgradability {
  if (standing === null) return { can: false, blocked: 'no project checkout is being watched' };
  if (standing.unavailable) return { can: false, blocked: standing.unavailable };
  if (standing.branch !== branch)
    return {
      can: false,
      blocked:
        `the project checkout is on ${standing.branch === null ? 'a detached HEAD' : standing.branch}, not ${branch} — ` +
        'a pull here would merge into that instead of fast-forwarding, so switch it by hand first',
    };
  if (standing.behind === 0)
    return { can: false, blocked: 'the project checkout is up to date — there is nothing to pull' };
  if (standing.dirty)
    return {
      can: false,
      blocked: 'the project checkout has uncommitted changes to tracked files; commit or stash them before pulling',
    };
  if (standing.ahead > 0)
    return {
      can: false,
      blocked:
        `the project checkout carries ${plural(standing.ahead, 'commit')} of its own, so the pull is not a ` +
        'fast-forward — merge or rebase it by hand',
    };
  return { can: true, blocked: null };
}

/** What the cockpit draws, and the only thing the gauge reads. */
export interface BuildReading {
  /** The gauge's own state. `unknown` and `current` are the quiet ones. */
  state: 'unknown' | 'current' | 'behind' | 'draining' | 'ready';
  /** The value on the gauge — "current", "3 behind", "draining 2". */
  label: string;
  /** Agents still running, which is what a drain is waiting for. */
  live: number;
  upgradable: boolean;
  blocked: string | null;
  /** Whether a supervisor is there to relaunch this process. False means the panel offers the command instead. */
  supervised: boolean;
  standing: BuildStanding;
  intent: UpgradeIntent;
  /**
   * The *worked* repository's standing — `repoRoot` against its own `defaultBranch`,
   * read on the same timer and by the same reader — or null where none was taken.
   * Here rather than on a wire field of its own so a cockpit cannot draw one without
   * the other. Its `ahead` is carried and read by nothing: local work is not a refusal.
   */
  project: BuildStanding | null;
  /**
   * Whether the project checkout can be fast-forwarded, and why not — folded here so
   * the card draws the server's verdict rather than re-deriving one.
   */
  projectPull: Upgradability;
  /**
   * Whether the harness fast-forwards the worked checkout on its own. The rail reads
   * it to decide whether a blocked pull is worth asking about at all.
   */
  projectAutoPull: boolean;
  /**
   * When each update ask stops being hidden, or null when it is not snoozed. Held in
   * the desk's memory, never the store: a snooze does not survive a restart.
   */
  snoozedUntil: SnoozeStamps;
}

/** Which update ask a snooze is on. Two asks, one length — see `SelfUpdatePolicy.snoozeMs`. */
export type SnoozeTarget = 'upgrade' | 'projectPull';

/** When each ask comes back, ISO, or null for one that is not snoozed. */
export type SnoozeStamps = Record<SnoozeTarget, string | null>;

/**
 * Fold the reading, the fleet and the intent into what the gauge shows. **A drain in
 * progress outranks the standing**, which is still carried whole for the panel.
 */
export function buildReading(opts: {
  standing: BuildStanding;
  intent: UpgradeIntent;
  live: number;
  supervised: boolean;
  project?: BuildStanding | null;
  /** The branch the project checkout is pulled onto — `config.defaultBranch`. */
  projectBranch?: string;
  projectAutoPull?: boolean;
  snoozedUntil?: SnoozeStamps;
}): BuildReading {
  const { standing, intent, live, supervised } = opts;
  const project = opts.project ?? null;
  const { can, blocked } = upgradability(standing, project);
  const projectPull = projectPullability(project, opts.projectBranch ?? '');
  const base = {
    live,
    upgradable: can,
    blocked,
    supervised,
    standing,
    intent,
    project,
    projectPull,
    projectAutoPull: opts.projectAutoPull ?? false,
    snoozedUntil: opts.snoozedUntil ?? NO_SNOOZE,
  };

  if (intent.state === 'draining')
    return {
      ...base,
      state: 'draining',
      // The count is what is *left*. At zero the desk moves to `ready` next pulse.
      label: live > 0 ? `draining ${live}` : 'draining',
    };
  if (intent.state === 'ready' || intent.state === 'applying')
    return { ...base, state: 'ready', label: intent.state === 'applying' ? 'applying' : 'ready' };
  if (standing.unavailable) return { ...base, state: 'unknown', label: 'unknown' };
  if (standing.behind === 0) return { ...base, state: 'current', label: 'current' };
  return { ...base, state: 'behind', label: `${standing.behind} behind` };
}

/** Nothing snoozed — what a desk that has never been asked to snooze reports. */
const NO_SNOOZE: SnoozeStamps = { upgrade: null, projectPull: null };

/** Either a transition was applied, or it was refused with a reason. */
export type UpgradeTransition = { ok: true; intent: UpgradeIntent } | { ok: false; error: string };

/** What the operator asked the upgrade to do. */
export type UpgradeAction = 'drain' | 'cancel' | 'apply';

/**
 * The state machine, as a fold: current intent plus a request gives the next intent
 * or a refusal. Pure, so the route and the desk share one account of what is legal.
 * **`apply` with agents live is refused by default**; `interrupt` overrides it.
 */
export function applyUpgradeAction(
  intent: UpgradeIntent,
  request: { action: UpgradeAction; interrupt?: boolean },
  ctx: { upgradable: Upgradability; live: number; alreadyPaused: boolean; targetSha: string | null; now: string },
): UpgradeTransition {
  const { action } = request;

  if (action === 'cancel') {
    if (intent.state === 'idle') return { ok: false, error: 'no upgrade is in progress' };
    if (intent.state === 'applying')
      return { ok: false, error: 'this process is already going down for the upgrade; it is too late to cancel' };
    return { ok: true, intent: IDLE_INTENT };
  }

  if (action === 'drain') {
    if (intent.state !== 'idle') return { ok: false, error: `an upgrade is already ${intent.state}` };
    if (!ctx.upgradable.can) return { ok: false, error: ctx.upgradable.blocked ?? 'this build cannot be upgraded' };
    return {
      ok: true,
      intent: {
        // A drain with an empty fleet is already finished.
        state: ctx.live > 0 ? 'draining' : 'ready',
        targetSha: ctx.targetSha,
        requestedAt: ctx.now,
        // Only ours to undo if we are the ones about to set it.
        pausedByDrain: !ctx.alreadyPaused,
      },
    };
  }

  if (intent.state === 'applying') return { ok: false, error: 'the upgrade is already being applied' };
  if (!ctx.upgradable.can) return { ok: false, error: ctx.upgradable.blocked ?? 'this build cannot be upgraded' };
  if (ctx.live > 0 && !request.interrupt)
    return {
      ok: false,
      error:
        `${ctx.live} agent(s) are still running — drain first, or apply with interrupt to stop them now ` +
        '(they are restored automatically on the way back up)',
    };
  return {
    ok: true,
    intent: {
      state: 'applying',
      // The sha the operator accepted, kept even on a straight-to-apply.
      targetSha: intent.targetSha ?? ctx.targetSha,
      requestedAt: intent.requestedAt ?? ctx.now,
      // From `idle` there is no drain to inherit from, and the resting `false` would
      // read as the operator having paused the fleet — which parks a fleet nobody parked.
      pausedByDrain: intent.state === 'idle' ? !ctx.alreadyPaused : intent.pausedByDrain,
    },
  };
}

/** What an automatic upgrade does on this pulse, or nothing. */
interface AutoStep {
  action: UpgradeAction;
  interrupt?: boolean;
  /** Why, in the operator's words — the log line an unattended upgrade leaves. */
  why: string;
}

/**
 * The whole of `selfUpdate.autoUpdate`: the operator's two clicks, decided on a
 * pulse instead. **Nothing at all without a supervisor** — the handoff is an exit,
 * and an exit with nothing to relaunch is a fleet that stays down. The deadline
 * forces the handoff rather than cancelling it; the interrupt is not lossy, since
 * the same intent restores every agent on the way back up.
 * → [21](../../docs/spec/21-self-update.md#an-unsupervised-deployment)
 */
export function autoUpgradeStep(ctx: {
  intent: UpgradeIntent;
  upgradable: Upgradability;
  live: number;
  supervised: boolean;
  drainDeadlineMs: number;
  /** Milliseconds the current drain has been waiting, or null when none is. */
  drainingForMs: number | null;
}): AutoStep | null {
  if (!ctx.supervised) return null;
  if (ctx.intent.state === 'applying') return null;
  if (ctx.intent.state === 'idle') return ctx.upgradable.can ? { action: 'drain', why: 'an update is waiting' } : null;
  if (ctx.intent.state === 'ready') return { action: 'apply', why: 'the fleet is clear' };
  // Draining, with something still running.
  if (ctx.drainDeadlineMs <= 0 || ctx.drainingForMs === null) return null;
  if (ctx.drainingForMs < ctx.drainDeadlineMs) return null;
  return {
    action: 'apply',
    interrupt: true,
    why:
      `the drain has waited ${Math.round(ctx.drainingForMs / 60_000)}m for ${ctx.live} agent(s) — ` +
      'interrupting them, and they are restored on the way back up',
  };
}
