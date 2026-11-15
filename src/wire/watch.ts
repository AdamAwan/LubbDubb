import type { GoalWatchKind, WatchAsk, WatchReading, WatchSourceLanguage, WatchWindow } from '../types.js';

export interface GoalWatchView extends WatchWindow {
  checks: GoalWatchCheckView[];
}

export interface GoalWatchCheckView {
  checkId: string;
  title: string;
  kind: GoalWatchKind;
  /** The source the check reads on this window's environment, by name; null reads its only one. */
  source: string | null;
  tolerate: number;
  expectUnder: number | null;
  expectOver: number | null;
  expectBaseline: boolean;
  unit: string | null;
  baselineValue: number | null;
  reading: WatchReading | null;
  /** This window's closing reading of the check is asked of a person, who has not answered yet. */
  waitingOnYou: boolean;
}

/**
 * An open `watch_reading` ask with everything needed to answer it: the query as it will be judged, with
 * the period filled in, in its source's language. → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run
 */
export interface WatchAskView extends WatchAsk {
  checkTitle: string;
  kind: GoalWatchKind;
  source: string;
  language: WatchSourceLanguage;
  query: string;
  /** A signal's presence query, period filled in: the person is asked both questions. Null for a measure. */
  presence: string | null;
  queryUrl: string | null;
  /** When an unanswered closing ask settles the check `unknown`; null for a baseline. */
  closesAt: string | null;
}
