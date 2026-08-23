import { z } from 'zod';
import type { ValidationCheck } from '../types.js';

/**
 * The desktop channel's pure layer: how a person names a check, when a claim has
 * gone stale, and what the operator's own Claude is handed when it takes one.
 *
 * ## What the channel is for
 *
 * The fleet cannot log into the test environment and cannot drive a browser. The
 * operator can, on their own machine, in a checkout they already have open — and
 * the whole point of a validation plan is that somebody actually carries the
 * procedure out. So the harness offers a second MCP socket that their *own*
 * Claude Code connects to: it reads the plan, takes the one check it is going to
 * run, and reports the reading back onto the same row the cockpit draws.
 *
 * ## Why the claim is one at a time and not one per check
 *
 * Because that is the operator's actual constraint, in their words: they can only
 * run a single branch at once, and two things reaching for it is the failure. A
 * per-check lock would happily let two desktop sessions take two checks and fight
 * over the same working copy, which is precisely the thing that was ruled out
 * when the priority-and-bench design was rejected.
 *
 * The claim also stops the *fleet* taking a check out from under a running
 * session — see the `validate-check` rule, which skips a live claim.
 */

/**
 * How a person names a check to their Claude: `284:C`, the shape the skill turns
 * `/lubbdubb 284:C` into. The letter is what a person reads off the plan sheet;
 * the id is what the row is keyed on and what a tool reports against.
 */
const CheckRefSchema = z.object({
  issue: z
    .number({
      required_error: 'issue is required — the goal number, e.g. 284',
      invalid_type_error: 'issue must be a number',
    })
    .int()
    .positive(),
  check: z
    .string({ required_error: 'check is required — a letter like "C", or the check id' })
    .trim()
    .min(1, 'check is required — a letter like "C", or the check id'),
});

type DesktopCheckRef = z.infer<typeof CheckRefSchema>;

/** The goal half alone, for the read that takes a whole plan rather than one check. */
export function desktopIssueRef(args: unknown): { ok: true; issue: number } | { ok: false; error: string } {
  const parsed = CheckRefSchema.pick({ issue: true }).safeParse(args);
  if (parsed.success) return { ok: true, issue: parsed.data.issue };
  const first = parsed.error.errors[0];
  return { ok: false, error: first ? first.message : 'the issue could not be read' };
}

export function desktopCheckRef(args: unknown): { ok: true; ref: DesktopCheckRef } | { ok: false; error: string } {
  const parsed = CheckRefSchema.safeParse(args);
  if (parsed.success) return { ok: true, ref: parsed.data };
  const first = parsed.error.errors[0];
  return { ok: false, error: first ? first.message : 'the check could not be read' };
}

/**
 * The check a `284:C` names, or null.
 *
 * Both handles are accepted because both are real: a person reads the letter off
 * the plan sheet, and an agent that has already called `validation_read` has the
 * id in front of it. Neither is guessed from the other — the letter is matched
 * case-insensitively because typing `284:c` is not a different request.
 */
export function findCheckByRef(checks: ValidationCheck[], ref: string): ValidationCheck | null {
  const wanted = ref.trim();
  return (
    checks.find((c) => c.id === wanted) ?? checks.find((c) => c.letter.toLowerCase() === wanted.toLowerCase()) ?? null
  );
}

/**
 * The instant before which a claim holds nothing.
 *
 * A claim is released when the session's socket closes and when the check is
 * reported, and neither survives a harness killed in between. Without an expiry
 * that leaves a check claimed by a session that no longer exists, which blocks
 * the fleet from it forever and gives the operator no way back short of editing
 * the database.
 */
export function claimStaleBefore(now: string, minutes: number): string {
  return new Date(new Date(now).getTime() - Math.max(1, minutes) * 60_000).toISOString();
}

/**
 * Whether a check's claim is still live at `now`, on {@link claimStaleBefore}'s
 * terms. The rule and the tools read this rather than `claimedBy !== null`, so
 * "claimed" means the same thing to a dispatch decision as it does to a person
 * trying to take one.
 */
export function claimIsLive(check: ValidationCheck, now: string, minutes: number): boolean {
  if (check.claimedBy === null || check.claimedAt === null) return false;
  return check.claimedAt > claimStaleBefore(now, minutes);
}

/**
 * A check as everything outside the store should see its claim: held only while
 * the claim is **live**.
 *
 * `claimIsLive` is the single definition of "claimed" — the rule reads it, the
 * desktop tools read it, and the cockpit gets this. Without it a claim whose
 * session died would go on being drawn as somebody running a check at the same
 * instant it stopped blocking `validate-check`, which is the one disagreement
 * having a single definition exists to prevent.
 */
export function withLiveClaim(check: ValidationCheck, now: string, minutes: number): ValidationCheck {
  if (check.claimedBy === null || claimIsLive(check, now, minutes)) return check;
  return { ...check, claimedBy: null, claimedAt: null };
}

/** How a check reads in a list an operator's Claude is choosing from. */
interface DesktopCheckSummary {
  letter: string;
  id: string;
  title: string;
  state: string;
  /** Who is expected to run it — `human` unless the operator handed it to the fleet. */
  actor: string;
  /** The current reading, and who took it. Null while unrun. */
  result: { note: string | null; by: string | null } | null;
  /** Set when an amendment changed this check and nobody has recorded a reading since. */
  amended: string | null;
  /** Why the last attempt gave it back, if one did. */
  handback: string | null;
  /** The label holding this check right now, if a claim is live. */
  claimedBy: string | null;
}

export function desktopCheckSummary(check: ValidationCheck, now: string, minutes: number): DesktopCheckSummary {
  return {
    letter: check.letter,
    id: check.id,
    title: check.title,
    state: check.state,
    actor: check.actor,
    result: check.state === 'unrun' ? null : { note: check.resultNote, by: check.resultBy },
    // Carried into the read rather than left on the row for the cockpit alone: a
    // session about to run a check needs to know the wording changed since the
    // last reading, which is the one thing the amber band exists to say.
    amended: check.amendedAt === null ? null : check.amendNote,
    // The same rule the goal line draws by: a note outlives a hand-over now, so a
    // check back with the fleet must not report the last attempt as standing.
    handback: check.actor === 'fleet' ? null : check.handbackNote,
    claimedBy: claimIsLive(check, now, minutes) ? check.claimedBy : null,
  };
}
