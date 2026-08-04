import type { RecoveryVerdict, WorkNodeView } from '../types.js';

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
  /** Keyed on the task: orphaned work may never have had an agent. */
  decideRecovery(taskId: string, verdict: RecoveryVerdict): Promise<void>;

  replan(planId: string): Promise<void>;
  /**
   * Abandon a released decomposition and work the issue as one pull request. The
   * route refuses (409) unless the plan is `active` with no part started, which is
   * the escape hatch for a plan approved onto an issue whose flat branch was
   * already taken — its parts block instantly and nothing else can free them.
   */
  abandonPlan(planId: string): Promise<void>;
  /**
   * Which plan's modal is open. UI state, on the seam for the same reason
   * `select` is: a skin cannot own it (the modal is shared and the triggers are
   * skin-side), and a skin may not reach `api.js` to open it another way.
   */
  viewPlan(planId: string | null): void;
  /**
   * Which goal's retrospective is open, as an `issue:<n>` ref. On the seam for
   * `viewPlan`'s reason: the modal is shared and reaches `api.js`, while the
   * control that opens it is embedded by whichever skin draws the station.
   */
  viewRetro(issueRef: string | null): void;
  /**
   * Which goal's shared scratchpad is open, as an `issue:<n>` ref. On the seam for
   * `viewRetro`'s reason exactly: the modal is shared and fetches its trail from
   * `api.js`, while the controls that open it are embedded by whichever skin draws
   * the goal — and two skins reaching one action is what stops the notepad
   * becoming readable in one theme only.
   */
  viewScratchpad(issueRef: string | null): void;
  /**
   * Open or close the settings modal — the running config and the skin picker.
   * On the seam for `viewPlan`'s reason: the modal is shared and hangs off the
   * shell (it reaches `/api/config`, which a skin may not do), while the cog that
   * opens it is embedded by each skin wherever that skin puts its chrome.
   */
  openSettings(open: boolean): void;
  discussPlan(planId: string): Promise<void>;
  endPlanDiscussion(planId: string): Promise<void>;
  reorderUpNext(origins: string[]): Promise<void>;

  promoteFinding(id: string): Promise<void>;
  fileFinding(id: string): Promise<void>;
  dismissFinding(id: string): Promise<void>;

  setPrExcluded(prNumber: number, excluded: boolean): Promise<void>;
  setIssueWatched(issueNumber: number, watched: boolean): Promise<void>;
  setIssueConclusion(issueNumber: number, verdict: 'done' | 'more_work' | null): Promise<void>;
  /**
   * Override the goal assay's verdict (#158). On the seam rather than in a skin
   * for the reason every mutation is: a skin may not import `api.js`, and an
   * `unclear` verdict is the one intake reading that *blocks* dispatch — so
   * without this the only escape hatch is editing the ticket.
   *
   * `null` clears the row, which is a third option and not `workable`: the store
   * keeps one representation of "nobody has decided", and that is also what a
   * crashed assayer leaves behind.
   */
  setIssueAssay(issueNumber: number, verdict: 'workable' | 'unclear' | null): Promise<void>;

  /**
   * End the harness's run at a goal (issues #203, #234). A run is retained on the
   * floor — no pulse, poll or ticket close drops it — so the operator can still
   * open its report; this is the one thing that ends it, it persists, and since
   * #234 it also stops the dispatcher. On the seam for every mutation's reason: a
   * skin may not reach `api.js`.
   */
  dismissRun(issueNumber: number): Promise<void>;

  /**
   * One work item's durable subtree (`GET /api/work/:ref`), fetched on demand.
   *
   * A read rather than a mutation, and on this seam for the same reason every
   * mutation is: a skin may not import `api.js`, so without it the Goal Floor
   * could not reach the record at all. It is deliberately **not** a snapshot key
   * — the graph never forgets, so shipping the forest on every poll would be the
   * wrong shape, which is why `/api/work` is its own route.
   */
  fetchWorkSubtree(ref: string): Promise<{ nodes: WorkNodeView[] }>;
}
