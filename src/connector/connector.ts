import type { MergeableState, WorldSnapshot } from '../types.js';
import type { ReadPlan } from '../world/readPlan.js';

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
  /**
   * The world as it is right now. Called at the start of every dispatch cycle.
   *
   * `plan` is what the pulse hands down about **cost**: which entities are worth a
   * per-entity fan-out this pulse, and how stale a hydration is acceptable for the
   * rest ([04](../../docs/spec/04-harness-cycle.md#hot-and-cold)). Omitted by every
   * caller outside the pulse — a route, the cockpit's snapshot — which knows
   * nothing about what the fleet is doing and so must not be the thing that
   * declares an entity cold; those read on the hot lane's terms. The world that
   * comes back is the same population either way.
   */
  getState(plan?: ReadPlan): Promise<WorldSnapshot>;
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
      headSha?: string;
      /** Who opened it, as a person is named — the fake's half of `PullRequest.author`. */
      author?: string;
      /**
       * Whether the harness's own credential opened it. Absent is the fake's usual
       * world — every pull request in a test is the fleet's unless a test says
       * otherwise — and `false` is how a test models a colleague's pull request
       * arriving because `ownWorkOnly` widened the fetch. → `src/prOwnership.ts`
       */
      viewerAuthored?: boolean;
    }
  // A push: the head moves. What a stale review pack is decided against.
  | { kind: 'pr_pushed'; prNumber: number; headSha: string }
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
