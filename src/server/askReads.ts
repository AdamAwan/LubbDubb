import type { System } from '../system/system.js';
import type { Late } from '../system/systemFoundation.js';
import type { SetupReading } from '../setup/reading.js';
import type { AskRow } from '../asks/askRow.js';
import { buildAskQueue, type AskSnapshot, type PrReadInputs } from '../asks/queue.js';
import { askInputs, prReadInputs } from './stateAsks.js';
import { snapshotReads } from './stateSnapshot.js';

// → docs/spec/17-cockpit.md#one-list-for-the-cockpit-and-for-claude-code

/**
 * The operator's asks as Claude Code walks them: standing rows only, in the one-at-a-time order the
 * Focus overview walks. The same derivation `/api/state` ships as `asks`.
 */
export function askQueue(system: System, setup: SetupReading | null = system.setupReading.latest): AskRow[] {
  return askSnapshot(system, setup).queue;
}

/** {@link askQueue} with the inputs it was derived from, which `ask_next`'s card reads the goal off. */
export function askSnapshot(system: System, setup: SetupReading | null = system.setupReading.latest): AskSnapshot {
  const r = snapshotReads(system, { setup });
  const inputs = askInputs(r, new Set(['asks']), { refUrls: r.refUrls });
  const queue = buildAskQueue(inputs, setup)
    .filter((row) => row.standing)
    .sort((a, b) => a.focusRank - b.focusRank);
  return { queue, inputs };
}

/** What `pr_read` reads, with no queue built. → docs/spec/44-needs-you.md#the-pull-request-skill */
export function prInputs(system: System): PrReadInputs {
  return prReadInputs(snapshotReads(system, undefined));
}

/** The reads the desktop channel takes late, once the system they read is built. */
export function lateReads(system: System): Pick<Late, 'askSnapshot' | 'prInputs'> {
  return { askSnapshot: () => askSnapshot(system), prInputs: () => prInputs(system) };
}
