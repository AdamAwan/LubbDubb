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
}

/** The resting intent — what a database with no row, and a finished upgrade, both read as. */
export const IDLE_INTENT: UpgradeIntent = { state: 'idle', targetSha: null, requestedAt: null, pausedByDrain: false };

/** Whether an update can be applied at all, and why not when it cannot. */
interface Upgradability {
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
export function upgradability(standing: BuildStanding): Upgradability {
  if (standing.unavailable) return { can: false, blocked: standing.unavailable };
  if (standing.behind === 0) return { can: false, blocked: 'this build is current — there is nothing to take' };
  if (standing.dirty)
    return {
      can: false,
      blocked: 'the install directory has uncommitted changes; commit or stash them before upgrading',
    };
  if (standing.ahead > 0)
    return {
      can: false,
      blocked:
        `this build carries ${standing.ahead} commit(s) of its own, so the update is not a fast-forward — ` +
        'merge or rebase it by hand',
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
}

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
}): BuildReading {
  const { standing, intent, live, supervised } = opts;
  const { can, blocked } = upgradability(standing);
  const base = { live, upgradable: can, blocked, supervised, standing, intent };

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
      pausedByDrain: intent.pausedByDrain,
    },
  };
}
