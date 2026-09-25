import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SlotProcess } from './slotProcesses.js';

// → docs/spec/09-execution.md#a-lock-left-behind-in-a-slot

/**
 * The lock files a git refusal names, absolute. Git reports `Unable to create '<path>.lock': File
 * exists.` for the index and for every ref it could not take, and that path is the whole question
 * the staleness check asks.
 *
 * @public the pool asks about these, and its test reads them back
 */
export function lockPaths(dir: string, detail: string): string[] {
  const paths: string[] = [];
  for (const named of detail.matchAll(/[Uu]nable to create '(.+?\.lock)'/g)) {
    const path = named[1];
    if (path === undefined || path.trim() === '') continue;
    const full = resolve(dir, path.trim());
    if (!paths.includes(full)) paths.push(full);
  }
  return paths;
}

/**
 * What an operator is told when a lock older than any git command was cleared out of the way. It is
 * a repair, not a failure, so the sentence says what was removed, how old it was, and what the
 * harness had already established about it before removing it.
 *
 * @public the pool records this to the error log, and its test reads the sentence back
 */
export function staleLockCleared(dir: string, path: string, ageMs: number, held: SlotProcess[] | null): string {
  const who =
    held === null
      ? 'the harness could not read the process table, so nothing was named as holding it — its age is what says ' +
        'it is stale'
      : 'nothing the harness can see was holding it';
  return (
    `Removed the stale git lock ${path} from worktree slot ${dir}: it was ${hours(ageMs)} old, which is longer ` +
    `than any git command the harness or an agent runs, and ${who}. A lock file is what a git process that died ` +
    `mid-command leaves behind, and nothing removes it on its own — git says so and then waits for a person. The ` +
    `slot handover was retried once and the slot stays in the pool. A slot needing this after every dispatch is a ` +
    `git process being killed mid-write in it, which is the thing to go and find.`
  );
}

/**
 * What an operator is told when the switch is refused anyway. The slot leaves the pool like one
 * whose wipe was refused, and for the same reason: retrying it on the next pulse cannot change it.
 *
 * @public the pool records this to the error log, and its test reads the sentence back
 */
export function slotNotSwitchable(dir: string, onto: string, detail: string, blockers: string[]): string {
  const why =
    blockers.length === 0
      ? 'Nothing the harness knows how to clear is named in the refusal, so the slot is left exactly as git left it.'
      : `Still in the way: ${blockers.join('; ')} — a lock too young to call stale, or one something is holding. ` +
        'The slot is offered again once it is gone.';
  return (
    `Worktree slot ${dir} cannot be handed to ${onto} and has been taken out of the pool: ${detail} The slot was ` +
    `swept and emptied first, so this is the checkout itself refusing rather than anything left in the working ` +
    `tree. ${why} The dispatch went to a different slot, so nothing is queued behind it — the pool is simply one ` +
    `slot smaller until this clears.`
  );
}

function hours(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 2) return `${Math.floor(h)} hours`;
  return `${Math.max(1, Math.floor(ms / 60_000))} minutes`;
}

/**
 * How old a git lock must be before the harness will call it stale and remove it. Longer than any
 * single git command the harness or an agent runs, and shorter by orders of magnitude than the
 * lifetime of one left by a process that died mid-write.
 */
export const STALE_LOCK_MS = 10 * 60_000;

export function lockAge(path: string): number | null {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    return age < 0 ? 0 : age;
  } catch {
    return null;
  }
}
