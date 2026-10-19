import type { WatchWindow } from '../types.js';
import type { EnvironmentConfig } from './policy.js';

// → docs/spec/29-post-deploy-watch.md#exposure

export const EXPOSURE_ECHO_COLUMN = 'lubbdubbWatchCommits';

const DEFAULT_EXPOSURE_FLOOR = 1;

const DEFAULT_EXPOSURE_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** The share of traffic on a build carrying every commit asked about, 0–1, or why the probe did not answer. */
export type ExposureReading = { share: number; detail: null } | { share: null; detail: string };

export interface ExposureRequest {
  environment: string;
  command: string;
  commits: readonly string[];
}

export function exposureFloor(environment: EnvironmentConfig): number {
  return environment.watch?.exposure?.atLeast ?? DEFAULT_EXPOSURE_FLOOR;
}

export function exposureWaitMs(environment: EnvironmentConfig): number {
  return environment.watch?.exposure?.waitMs ?? DEFAULT_EXPOSURE_WAIT_MS;
}

/** The value `LUBBDUBB_WATCH_COMMITS` carries, and the one the probe must echo back. */
export function commitsVariable(commits: readonly string[]): string {
  return commits.join(' ');
}

/** The instant a window's queries are bounded by: exposure where one was reached, else the arrival. */
export function watchSince(window: WatchWindow): string {
  return window.exposedAt ?? window.openedAt;
}

export function parseExposure(stdout: string, commits: readonly string[]): ExposureReading {
  const text = stdout.trim();
  if (text === '') return unexposed('the exposure probe exited 0 and printed nothing');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return unexposed(`the exposure probe did not answer with JSON: ${(err as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return unexposed('the exposure probe answered with something other than one object');
  const row = json as Record<string, unknown>;
  if (row[EXPOSURE_ECHO_COLUMN] !== commitsVariable(commits))
    return unexposed('the exposure probe answered without the commits it was asked about');
  const share = row.share;
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1)
    return unexposed('the exposure probe answers with a numeric "share" between 0 and 1');
  return { share, detail: null };
}

export function unexposed(detail: string): ExposureReading {
  return { share: null, detail };
}

/**
 * Why a window is not read this pass, or null where its exposure clears the floor. Every arm of this
 * reads `unknown` — never `clean`, never `regressed` — because a reading taken on traffic that does
 * not run the change is about the previous build.
 */
export function exposureShortfall(environment: string, reading: ExposureReading, floor: number): string | null {
  if (reading.share === null)
    return `the watch could not tell how much of ${environment} runs this change — ${reading.detail}`;
  if (reading.share >= floor) return null;
  return (
    `${percent(reading.share)} of ${environment} runs a build carrying this change, below the ${percent(floor)} ` +
    'this environment reads at. A reading now would mostly be about the build before it.'
  );
}

function percent(share: number): string {
  return `${String(Math.round(share * 1000) / 10)}%`;
}
