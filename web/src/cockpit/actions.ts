import type { RecoveryVerdict } from '../types.js';

/**
 * Every mutation the cockpit can perform, pre-bound and refetching on completion.
 *
 * This exists so that **no skin imports `api.js`**. A skin that reached the network
 * directly could grow a capability the other skins lack, and the difference would
 * only show up as a button that exists in one theme — so the surface is enumerated
 * here once, and `test/cockpitSkins.test.ts` asserts structurally that `skins/`
 * never imports the client. Selection is on here too: which drawer is open is
 * cockpit state, not skin state, or closing the drawer would lose the subscription.
 */
export interface CockpitActions {
  refresh(): Promise<void>;
  pulse(): Promise<void>;
  /** Drop the fault log — the rows go, for every cockpit. */
  clearErrors(): Promise<void>;

  select(agentId: string | null): void;

  killAgent(agentId: string): Promise<void>;
  completeAgent(agentId: string): Promise<void>;
  interruptAgent(agentId: string): Promise<void>;
  respondAgent(agentId: string, text: string): Promise<void>;

  answerEscalation(id: string, text: string): Promise<void>;
  dismissEscalation(id: string, note?: string): Promise<void>;
  decideProposal(id: string, verdict: 'accept' | 'reject', note?: string): Promise<void>;
  decidePermission(id: string, allow: boolean, note?: string): Promise<void>;
  decideRecovery(agentId: string, verdict: RecoveryVerdict): Promise<void>;

  replan(planId: string): Promise<void>;
  reorderUpNext(origins: string[]): Promise<void>;

  promoteFinding(id: string): Promise<void>;
  fileFinding(id: string): Promise<void>;
  dismissFinding(id: string): Promise<void>;

  setPrExcluded(prNumber: number, excluded: boolean): Promise<void>;
  setIssueWatched(issueNumber: number, watched: boolean): Promise<void>;
  setStoryWatched(storyId: string, watched: boolean): Promise<void>;
  setIssueConclusion(issueNumber: number, verdict: 'done' | 'more_work' | null): Promise<void>;
}
