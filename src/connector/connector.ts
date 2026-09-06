import type { MergeableState, WorldSnapshot } from '../types.js';
import type { ReadPlan } from '../world/readPlan.js';

// → docs/spec/03-world-model.md

export interface Connector {
  getState(plan?: ReadPlan): Promise<WorldSnapshot>;
}

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
      author?: string;
      viewerAuthored?: boolean;
    }
  | { kind: 'pr_pushed'; prNumber: number; headSha: string }
  | { kind: 'pr_approved'; prNumber: number }
  | { kind: 'pr_mergeable'; prNumber: number; mergeable?: boolean; mergeableState?: MergeableState }
  | { kind: 'pr_closed'; prNumber: number; merged?: boolean; mergeCommitSha?: string }
  | { kind: 'new_issue'; number: number; title: string; body?: string; labels?: string[] }
  | { kind: 'issue_state'; number: number; state: 'open' | 'closed' }
  | { kind: 'issue_linked_pr'; number: number; prNumber: number };
