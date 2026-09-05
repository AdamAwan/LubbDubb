import type { UpgradeIntent } from '../types.js';
import type { BuildStanding } from './buildStanding.js';

/**
 * Whether an update can be taken, and what taking it costs right now — the pure
 * half of self-upgrade. Nothing here reads the store, the clock or git; it folds
 * a {@link BuildStanding}, a live-agent count and the intent row into the one
 * verdict the gauge, the panel and the route all quote.
 *
 * **Every refusal is words, not a boolean.** "Why is the button off" is the whole
 * of what an operator asks a screen that will not upgrade, and a disabled control
 * with no reason is the version of this feature that gets ignored.
 */

/**
 * The four states, in the order an upgrade passes through them:
 *
 * - `idle` — none in progress. The resting state, and what a finished one returns to.
 * - `draining` — dispatch is paused and the fleet is being allowed to finish. No
 *   agent is interrupted.
 * - `ready` — the drain finished: nothing is live, and the handoff is safe.
 * - `applying` — the handoff was asked for and this process is going down for it.
 *   This is the marker the *next* boot reads: agents it finds interrupted under
 *   this state were interrupted deliberately, and their verdict is already decided.
 *
 * The type itself lives in `src/types.ts` with the rest of the domain.
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
  /**
   * Take an update on the fleet's behalf: drain when one lands, hand off when the
   * drain runs dry. One key rather than two, because a drain nobody ever applies
   * is a fleet that paused itself and stopped.
   */
  autoUpdate: boolean;
  /**
   * How long an automatic drain waits for the fleet before it stops waiting and
   * interrupts what is left. Zero waits forever.
   */
  drainDeadlineMs: number;
  /**
   * Fast-forward the *worked* checkout on its own, whenever {@link projectPullability}
   * says it can.
   *
   * Separate from {@link autoUpdate} and defaulting the other way, because they are
   * different acts on different repositories: taking an update to the harness stops
   * a fleet and restarts a process, where this is a fast-forward of somebody's
   * clone that interrupts nothing. The reason it is worth doing unasked is that the
   * project config layer arrives by exactly this pull, so a clone days behind is a
   * harness running a policy the team has already changed.
   * → [02](docs/spec/02-configuration.md#the-project-layer)
   */
  projectAutoPull: boolean;
  /**
   * How long the rail's Snooze buys on either update ask. One key for both, so the
   * two cannot drift into meaning different lengths of "not now".
   */
  snoozeMs: number;
}

/**
 * `1 commit` / `2 commits`. These sentences are drawn on the rail now as well as on
 * the card, and `commit(s)` reads as a placeholder somebody left in on the surface
 * an operator answers things from.
 */
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
 * Can this build take what is waiting?
 *
 * The order is the order an operator would ask it in, and each arm makes the next
 * moot. Note what is deliberately *not* here: whether anything is running. That is
 * a question about when to apply, not whether — and it is the whole of what the
 * drain answers.
 *
 * **`ahead > 0` is a refusal, not a warning.** The supervisor applies an update
 * with `pull --ff-only`, which fails on a build carrying its own commits — a fork,
 * a hotfix, a branch someone left checked out. Offering a button that will fail in
 * a process the operator is no longer watching is worse than not offering it.
 */
export function upgradability(standing: BuildStanding, project?: BuildStanding | null): Upgradability {
  if (standing.unavailable) return { can: false, blocked: standing.unavailable };
  if (standing.behind === 0) return { can: false, blocked: 'this build is current — there is nothing to take' };
  if (standing.dirty)
    return {
      can: false,
      blocked: 'the install directory has uncommitted changes to tracked files; commit or stash them before upgrading',
    };
  // The *worked* repository, on the same terms. An upgrade is a restart, and a
  // restart interrupts agents whose worktrees were cut from this checkout — so
  // uncommitted work sitting in it is work nobody has claimed and the upgrade is
  // about to walk over. Untracked files are not counted here for the same reason
  // they are not counted above: `readBuildStanding` reads tracked changes only,
  // and a stray file is not a change to anything.
  //
  // A project reading that could not be taken is **not** a refusal. The install's
  // own `unavailable` is, because it is the thing being upgraded; this one is a
  // second opinion about a different repository, and letting an unreachable
  // project remote take the upgrade button away would park a fleet over a fact
  // that has nothing to do with the build.
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
 * Can the **project** checkout take what is waiting on its remote?
 *
 * The same four questions as {@link upgradability} asked of a different
 * repository, and worded for it rather than shared with it: "this build is
 * current" is a sentence about the wrong thing on a card about the worked repo,
 * and the wording *is* the product on a control that will not run.
 *
 * One arm has no counterpart above, because the install directory cannot be in
 * this state and `repoRoot` routinely is: **the checkout must be on the branch
 * being pulled.** `git pull --ff-only origin main` on a clone sitting on some
 * other branch does not fast-forward `main` — it tries to merge `origin/main`
 * into whatever is checked out, which is a different and unasked-for operation.
 *
 * `behind`, `ahead` and `dirty` are all read against that same HEAD, so this arm
 * is checked before any conclusion is drawn from them.
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
  /**
   * The gauge's own state. `unknown` and `current` are the quiet ones; the rest
   * each mean something is in progress or waiting.
   */
  state: 'unknown' | 'current' | 'behind' | 'draining' | 'ready';
  /** The value on the gauge — "current", "3 behind", "draining 2". */
  label: string;
  /** Agents still running, which is what a drain is waiting for. */
  live: number;
  upgradable: boolean;
  blocked: string | null;
  /**
   * Whether a supervisor is there to relaunch this process. False means the panel
   * offers the command instead of a button — see `scripts/serve.ts`.
   */
  supervised: boolean;
  standing: BuildStanding;
  intent: UpgradeIntent;
  /**
   * The *worked* repository's standing — `repoRoot` against its own
   * `defaultBranch` — read on the same timer as the build's and by the same
   * reader, or null where none was configured or taken.
   *
   * Here rather than on a wire field of its own because the two are one reading
   * in every place that matters: they are taken together, the cockpit draws them
   * side by side, and {@link upgradability} folds them into one verdict. A second
   * top-level field would let a cockpit show one without the other, which is the
   * state neither answer is true in.
   *
   * It carries `behind`, `commits` and `dirty` for the same reasons the build's
   * does. It carries `ahead` too, and nothing reads it: an integration branch this
   * clone is ahead of is a fact about somebody's local work, not a refusal.
   */
  project: BuildStanding | null;
  /**
   * Whether the project checkout can be fast-forwarded, and why not when it
   * cannot — {@link projectPullability}, folded here so the card draws the
   * server's verdict rather than re-deriving one from the standing beside it.
   */
  projectPull: Upgradability;
  /**
   * Whether the harness fast-forwards the worked checkout on its own —
   * `selfUpdate.projectAutoPull`.
   *
   * The rail reads it to decide whether a blocked pull is worth an ask at all: a
   * deployment that turned auto-pull off has said it pulls by hand, and telling it
   * every day that auto-pull is disabled would be the harness reporting the
   * operator's own decision back to them as news.
   */
  projectAutoPull: boolean;
  /**
   * When each update ask stops being hidden, or null when it is not snoozed.
   *
   * Held by the desk in memory rather than in the store, on `RuntimeControl`'s
   * terms: a snooze is read only by the process that holds it, and thirty minutes
   * of "not now" is not a decision worth carrying across a restart — a boot is a
   * fresh look at the world, and the one restart this most often follows is the
   * upgrade itself.
   */
  snoozedUntil: SnoozeStamps;
}

/** Which update ask a snooze is on. Two asks, one length — see `SelfUpdatePolicy.snoozeMs`. */
export type SnoozeTarget = 'upgrade' | 'projectPull';

/** When each ask comes back, ISO, or null for one that is not snoozed. */
export type SnoozeStamps = Record<SnoozeTarget, string | null>;

/**
 * Fold the reading, the fleet and the intent into what the gauge shows.
 *
 * **A drain in progress outranks the standing**, because it is the thing that is
 * happening: an operator who asked to drain wants the count of what is left, not
 * a restatement of how far behind they were when they asked. The standing is
 * still carried whole for the panel.
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
      // The count is what is *left*, so it ticks down to the handoff. At zero the
      // desk moves the intent to `ready` on the next pulse, so this reads
      // "draining 0" for at most one beat rather than sitting there.
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
 * The state machine, as a fold: current intent plus a request gives the next
 * intent, or a refusal. Pure, so the route and the desk share one account of what
 * is legal rather than each checking a subset.
 *
 * **`apply` with agents live is a refusal by default, and `interrupt` is how an
 * operator overrides it.** Interrupting is not lossy — the shutdown path leaves
 * every agent resumable and the next boot restores them — but it *is* a decision,
 * and one taken on the operator's behalf silently is one they find out about from
 * the fleet coming back different.
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
        // A drain with an empty fleet is already finished, and making the operator
        // wait a pulse to be told so would be a state that exists only to be left.
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
      // The sha the operator accepted, kept even on a straight-to-apply where no
      // drain recorded one.
      targetSha: intent.targetSha ?? ctx.targetSha,
      requestedAt: intent.requestedAt ?? ctx.now,
      // From `idle` there was no drain to inherit the answer from, and inheriting
      // the resting `false` would say the operator had paused the fleet themselves.
      // It is read on the way back up to decide whether they get it back paused,
      // so getting it wrong here parks a fleet nobody parked.
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
 * pulse instead. Pure, so what the fleet does unattended is asserted without a
 * clock, a store or a process to lose.
 *
 * **Nothing at all without a supervisor.** The handoff is an exit, and an exit
 * with nothing in front of it to relaunch is the fleet going down and staying
 * down — the one failure an unattended feature must not have. The manual button
 * degrades to a printed command here ([21](../../docs/spec/21-self-update.md#an-unsupervised-deployment));
 * this degrades to doing nothing, which is the same answer.
 *
 * **The deadline forces the handoff, it does not cancel it.** An automatic drain
 * that waits on one long agent holds dispatch paused for as long as that agent
 * runs, which is its own interruption and a quieter one — the fleet stops, the
 * gauge says `draining`, and nothing is wrong. Past the deadline the drain stops
 * waiting: the interrupt is not lossy, because every agent it stops is restored on
 * the way back up by the same intent that stopped it.
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
