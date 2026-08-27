import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { reviewModeNames, type PrReviewCharters } from './prReview.js';
import type { PrReviewPolicy } from './policy.js';

/**
 * Read the project's review charters — the one that says **how to choose** a mode
 * (read by the triage), and one per mode saying **what that mode looks for** (read
 * by the reviewer).
 *
 * **From the working tree at `repoRoot`, never from the branch under review.**
 * The project config layer is read the same way and for the same reason
 * ([02](docs/spec/02-configuration.md#the-project-layer)): a pull request that
 * could edit the file it is reviewed against is a gate that reviews whatever it
 * is told to, and a pull request from anywhere is a branch. What a team commits
 * takes effect once somebody merges it and the harness's checkout has it.
 *
 * **Read once at boot**, which is what `promptTemplatesDir` does with the
 * override files this sits beside, and stated in the spec rather than left to be
 * discovered: an edited charter is a restart, not a pulse.
 *
 * A missing or unreadable file reads as **no charter** rather than as an error
 * that stops the boot. The agent then reads the repository's own conventions,
 * which is what every deployment without a charter does — and the absence is
 * reported through the recorder rather than swallowed, so a team whose path is
 * wrong is not left believing their charter is in front of an agent.
 */
export function loadReviewCharters(
  repoRoot: string,
  policy: PrReviewPolicy,
  onError?: (error: unknown, path: string) => void,
): PrReviewCharters {
  const modes: Record<string, string | null> = {};
  for (const name of reviewModeNames(policy)) {
    modes[name] = readCharter(repoRoot, policy.modes[name]?.charterFile ?? null, onError);
  }
  return { routing: readCharter(repoRoot, policy.routingCharterFile, onError), modes };
}

function readCharter(
  repoRoot: string,
  charterFile: string | null,
  onError?: (error: unknown, path: string) => void,
): string | null {
  const named = charterFile?.trim() ?? '';
  if (named === '') return null;
  const path = isAbsolute(named) ? named : resolve(repoRoot, named);
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? null : text;
  } catch (error) {
    onError?.(error, path);
    return null;
  }
}
