import type { MergeableState, WorldSnapshot } from '../types.js';

/**
 * The seam between the harness and the outside world.
 *
 * The harness depends on nothing more than this interface. Behind it the world is
 * assembled from many small, per-capability integrations (see `src/integrations/`),
 * each with an interchangeable provider chosen in config — so a real Azure DevOps
 * / GitHub adapter drops in for one capability without any
 * other module changing. `CompositeConnector` merges those slices into this seam,
 * and the outbound mirror lives in `src/sink/actionSink.ts`.
 */
export interface Connector {
  /** The world as it is right now. Called at the start of every dispatch cycle. */
  getState(): Promise<WorldSnapshot>;
}

/** Events that can be injected into the FakeConnector to simulate the world moving. */
export type InjectableEvent =
  | { kind: 'ci_failed'; prNumber: number }
  | { kind: 'ci_passed'; prNumber: number }
  | { kind: 'pr_comment'; prNumber: number; author: string; body: string }
  | {
      kind: 'new_pr';
      number: number;
      title: string;
      branch: string;
      baseBranch?: string;
      labels?: string[];
      /**
       * When it was opened, for a test that needs a pull request the harness did
       * *not* watch appear — the fleet review's backfill guard is the one thing
       * that reads it, and "already open when the review was switched on" cannot
       * be expressed any other way. Absent = now, which is what an injected pull
       * request otherwise is.
       */
      openedAt?: string;
    }
  // PR-monitoring signals that walk a PR toward mergeable.
  | { kind: 'pr_approved'; prNumber: number }
  | { kind: 'pr_mergeable'; prNumber: number; mergeable?: boolean; mergeableState?: MergeableState }
  // A PR leaving the open set. `merged` distinguishes a merge from an abandonment —
  // the distinction a real provider now reports and the fake has to be able to model.
  | { kind: 'pr_closed'; prNumber: number; merged?: boolean; mergeCommitSha?: string }
  // GitHub-issue signals.
  | { kind: 'new_issue'; number: number; title: string; body?: string; labels?: string[] }
  | { kind: 'issue_state'; number: number; state: 'open' | 'closed' }
  | { kind: 'issue_linked_pr'; number: number; prNumber: number };
