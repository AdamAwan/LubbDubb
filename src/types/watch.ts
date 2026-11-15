export type GoalWatchKind = 'signal' | 'measure';

/** The query language a watch source answers in. → docs/spec/29-post-deploy-watch.md#what-a-language-changes */
export type WatchSourceLanguage = 'kql' | 'sql' | 'promql' | 'other';

/** Who can put a query to a watch source: the harness on a schedule, or only a person. */
export type WatchSourceRunner = 'harness' | 'operator';

/** One of an environment's watch sources as it is declared: a name, a language and who runs it. */
export interface WatchSourceDeclaration {
  name: string;
  language: WatchSourceLanguage;
  runBy: WatchSourceRunner;
}

export type WatchReadingVerdict = 'fires' | 'zero' | 'unknown';

export type GoalWatchDeclaration =
  | {
      kind: 'signal';
      id: string;
      title: string;
      query: string;
      presence: string;
      tolerate: number;
      why?: string;
      source?: string;
    }
  | {
      kind: 'measure';
      id: string;
      title: string;
      query: string;
      expect: { under?: number; over?: number; noWorseThan?: 'baseline' };
      unit?: string;
      why?: string;
      source?: string;
    };

export interface GoalWatchInput {
  id: string;
  seq: number;
  kind: GoalWatchKind;
  title: string;
  query: string;
  presence: string | null;
  tolerate: number;
  expectUnder: number | null;
  expectOver: number | null;
  expectBaseline: boolean;
  unit: string | null;
  why: string | null;
  /** The environment source it reads, by name; null reads the environment's only source. */
  source: string | null;
}

export interface GoalWatch extends GoalWatchInput {
  originRef: string;
  dryRunEnvironment: string | null;
  dryRunAt: string | null;
  dryRunVerdict: WatchReadingVerdict | null;
  dryRunPresence: WatchReadingVerdict | null;
  dryRunRows: number | null;
  dryRunDetail: string | null;
  baselineValue: number | null;
  baselineAt: string | null;
  /** False while the assessor's set awaits the operator's accept. */
  live: boolean;
  authored: GoalWatchAuthor;
  /**
   * The assessor's own account of where this check departs from the plan's hint, or null where it
   * says it does not. Drawn as the "changed from plan" chip. → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set
   */
  changedFromHint: string | null;
}

type GoalWatchAuthor = 'plan' | 'operator' | 'assessor';

/**
 * A goal's post-deploy watch as the assessor wrote it, and what the operator did with it.
 * → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks
 */
export interface WatchPlanRecord {
  goalRef: string;
  /** Null is *owed*: asked for and not written yet, or sent back. No record at all is *never asked*. */
  authoredAt: string | null;
  note: string | null;
  emptyReason: string | null;
  /** Null on an authored watch is a set still proposed: nothing in it runs on a schedule. */
  acceptedAt: string | null;
  /** The operator's words on the last send-back, handed to the next author; null where it was never sent back. */
  sentBackWords: string | null;
}

export interface WatchWindow {
  goalRef: string;
  environment: string;
  openedAt: string;
  settlesAt: string;
  settledAt: string | null;
  extendedAt: string | null;
  /** When the rollout first cleared the environment's exposure floor; null before, and where none is declared. */
  exposedAt: string | null;
}

export type WatchCheckVerdict = 'clean' | 'regressed' | 'unknown';

export interface WatchReading {
  goalRef: string;
  environment: string;
  checkId: string;
  readAt: string;
  verdict: WatchCheckVerdict;
  rows: number | null;
  value: number | null;
  detail: string | null;
  /** Who took it: the harness's own observation, or a person's answer to an ask. */
  readBy: WatchSourceRunner;
}

/**
 * One reading only a person can take: the baseline before the merge, or the window's closing reading.
 * → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run
 */
export type WatchAskKind = 'baseline' | 'closing';

/** A `watch_reading` bench row and what it asks: one check, on one environment, over one period. */
export interface WatchAsk {
  taskId: string;
  goalRef: string;
  checkId: string;
  environment: string;
  ask: WatchAskKind;
  since: string;
  until: string;
}

/**
 * A goal's watch rolled up to one answer. `watching` is no window settled yet; `none` is a watch
 * that was decided to measure nothing. → docs/spec/29-post-deploy-watch.md#the-outcome
 */
type WatchOutcomeKind = 'worked' | 'worse' | 'unknown' | 'none' | 'unwritten' | 'watching';

export interface WatchOutcomeCheck {
  checkId: string;
  title: string;
  kind: GoalWatchKind;
  /** Regressed on any settled window, else clean on one, else unknown. */
  verdict: WatchCheckVerdict;
  /** The environment the verdict was read on; null where no settled window read it. */
  environment: string | null;
  /** A measure's baseline, or the rows a signal's dry run read before the merge. */
  before: number | null;
  /** The environment `before` was read on — the dry run's, which may not be `environment`; null with no `before`. */
  beforeEnvironment: string | null;
  /** A measure's last value, or the rows a signal's window read. */
  after: number | null;
  unit: string | null;
  /** How long the window that read it ran: whole hours (`48h`), or minutes under an hour (`20m`). */
  windowSpan: string | null;
  /** Why it is `unknown` or `regressed`, in words; null where it read clean. */
  reason: string | null;
}

export interface WatchOutcome {
  goalRef: string;
  outcome: WatchOutcomeKind;
  /** The answer in words, as the card and the discussion note both say it. */
  headline: string;
  /** Every check, whatever it settled as — a regressed one never hides a clean one. */
  checks: WatchOutcomeCheck[];
  /** Why nothing was measured, for `none`. */
  reason: string | null;
  /** Environments whose window is still open. */
  watching: string[];
  /** `worse` or `unknown`: an answer a person decides the meaning of, which Discuss in Claude is offered for. */
  discussable: boolean;
  /** Environments whose settled window Extend re-opens: every settled one, for `unknown`; none otherwise. */
  extendable: string[];
}
