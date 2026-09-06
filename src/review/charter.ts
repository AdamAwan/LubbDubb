import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { reviewModeNames, type PrReviewCharters } from './prReview.js';
import type { PrReviewPolicy } from './policy.js';

// → docs/spec/31-review-packs.md

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
