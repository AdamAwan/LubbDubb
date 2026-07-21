import type { WorldSnapshot } from '../types.js';

/**
 * The seam between the harness and the outside world.
 *
 * v1 ships only `FakeConnector`, but the entire harness depends on nothing more
 * than this interface — a real Azure DevOps / GitHub / calendar / Gmail adapter
 * drops in here without any other module changing.
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
  | { kind: 'new_pr'; number: number; title: string; branch: string }
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
