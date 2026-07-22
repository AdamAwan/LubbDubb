import type { MergeableState, WorldSnapshot } from '../types.js';

/**
 * The seam between the harness and the outside world.
 *
 * The harness depends on nothing more than this interface. Behind it the world is
 * assembled from many small, per-capability integrations (see `src/integrations/`),
 * each with an interchangeable provider chosen in config — so a real Azure DevOps
 * / GitHub / calendar / Gmail adapter drops in for one capability without any
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
  | { kind: 'new_pr'; number: number; title: string; branch: string; baseBranch?: string; labels?: string[] }
  // PR-monitoring signals that walk a PR toward mergeable.
  | { kind: 'pr_approved'; prNumber: number }
  | { kind: 'pr_mergeable'; prNumber: number; mergeable?: boolean; mergeableState?: MergeableState }
  // GitHub-issue signals.
  | { kind: 'new_issue'; number: number; title: string; body?: string; labels?: string[] }
  | { kind: 'issue_state'; number: number; state: 'open' | 'closed' }
  | { kind: 'issue_linked_pr'; number: number; prNumber: number }
  | {
      kind: 'new_story';
      title: string;
      priority?: number;
      description?: string;
      acceptanceCriteria?: string;
      wafPillars?: string[];
    }
  | { kind: 'story_state'; storyId: string; state: 'ready' | 'in_progress' | 'blocked' | 'done' }
  | { kind: 'meeting'; title: string; startsAt: string; prepDocs?: string[] };
