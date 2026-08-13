import type { RecoveryVerdict, WorkNodeView } from '../types.js';

/**
 * What an operator concluded about one validation check. A union rather than four
 * methods because there is one thing being said — this is the check's current
 * reading — and the server clears whatever the last one left behind.
 */
export type ValidationAct =
  | { kind: 'result'; result: 'passed' | 'failed'; note: string }
  | { kind: 'defer'; reason: string }
  | { kind: 'waive'; reason: string }
  | { kind: 'reset' }
  // The one act that is not a reading: who is expected to *run* the check. Here
  // rather than as a method of its own because it is written on the same row,
  // through the same seam, by the same person deciding the same thing — what
  // happens to this check next.
  | { kind: 'handover'; to: 'fleet' | 'human' };

/**
 * Which full-surface panel is in front. One value rather than a boolean each: a
 * boolean per panel admits far more states than there are, and two panels in
 * front at once is not something this layout can draw.
 *
 * `{ ask }` carries the queue row it is showing, for an ask with no goal page to
 * be answered on — a pull request's escalation, a bench task with no ticket. It
 * rides in this same value rather than beside it so that "two at once" stays
 * unrepresentable: a second field would let an ask and the fault log both be in
 * front, which is the state this type exists to rule out.
 */
export type ConsolePanel = 'findings' | 'faults' | 'output' | 'launch' | { ask: string } | null;

/**
 * Which destination the situation area is on. One value rather than a boolean
 * per destination for `ConsolePanel`'s reason exactly — and it is why the nav is
 * a list rather than a hand-written pair: a third tab that has to be remembered
 * in two booleans and four call sites is a third tab that arrives half-wired.
 *
 * A selected goal outranks all three, so this says where the nav last was, never
 * what is drawn.
 */
export type ConsoleTab = 'overview' | 'backlog' | 'work';

/**
 * Every mutation the cockpit can perform, pre-bound and refetching on completion.
 *
 * This exists so that **nothing under `console/` imports `api.js`**. Drawing code
 * that reached the network directly could grow a capability with no refusal rule
 * behind it, and it would show up only as a button nobody wrote a rule for — so
 * the surface is enumerated here once, and `test/console.test.ts` asserts
 * structurally that `console/` never imports the client. Selection is on here too:
 * which drawer is open is cockpit state, not console state, or closing the drawer
 * would lose the subscription.
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
  /** Answer a multi-question ask; positional against the escalation's questions. */
  answerQuestions(id: string, answers: (string | null)[]): Promise<void>;
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
   * A reviewer's confirmation that one of a part's acceptance criteria holds.
   * Keyed on the criterion's text, which is what the server stores — an index
   * would move under a re-worded list and carry the tick onto something nobody
   * looked at.
   */
  setAcceptance(planId: string, slug: string, criterion: string, met: boolean): Promise<void>;
  /** One validation check's current reading — see `api.setValidation`. */
  setValidation(planId: string, checkId: string, act: ValidationAct): Promise<void>;
  /**
   * Which plan's modal is open. UI state, on the seam for the same reason
   * `select` is: the console cannot own it (the modal is shared and the triggers
   * are console-side), and `console/` may not reach `api.js` to open it another way.
   */
  viewPlan(planId: string | null): void;
  /**
   * Which goal's retrospective is open, as an `issue:<n>` ref. On the seam for
   * `viewPlan`'s reason: the modal is shared and reaches `api.js`, while the
   * control that opens it is embedded by the station that draws the goal.
   */
  viewRetro(issueRef: string | null): void;
  /**
   * Which goal's shared scratchpad is open, as an `issue:<n>` ref. On the seam for
   * `viewRetro`'s reason exactly: the modal is shared and fetches its trail from
   * `api.js`, while the controls that open it are embedded by the surfaces that
   * draw the goal — and several of them reaching one action is what stops the
   * notepad becoming readable from one place only.
   */
  viewScratchpad(issueRef: string | null): void;
  /**
   * Open or close the settings modal — the running config, the CI policy and the
   * prompt book. On the seam for `viewPlan`'s reason: the modal is shared and hangs
   * off the shell (it reaches `/api/config`, which `console/` may not do), while
   * the reading that opens it sits in the top bar.
   */
  openSettings(open: boolean): void;
  /**
   * Open or close the spend breakdown — where the money on the Power gauge went.
   * On the seam for `openSettings`' reason exactly: the panel reaches `/api/spend`,
   * which `console/` may not do, while the gauge that opens it sits in the top
   * bar and *is* the reading it explains.
   */
  openSpend(open: boolean): void;
  /**
   * Open or close the reliability breakdown — whether the work the Yield gauge
   * counts actually finished, and whether CI went green. On the seam for
   * `openSpend`'s reason exactly, and beside it: the two panels are the same
   * funnel read for cost and for outcome.
   */
  openReliability(open: boolean): void;
  /** Open a goal's page, or return to the overview with null. */
  selectGoal(ref: string | null): void;
  /** Bring a full-surface panel in front, or dismiss it with null. */
  openPanel(panel: ConsolePanel): void;
  /** Move the nav to a destination. A selected goal still outranks it. */
  openTab(tab: ConsoleTab): void;
  discussPlan(planId: string): Promise<void>;
  endPlanDiscussion(planId: string): Promise<void>;
  reorderUpNext(origins: string[]): Promise<void>;

  promoteFinding(id: string): Promise<void>;
  fileFinding(id: string): Promise<void>;
  dismissFinding(id: string): Promise<void>;

  completeHumanTask(id: string): Promise<void>;
  declineHumanTask(id: string, note: string): Promise<void>;
  /** Clear a settled task off the bench. Settled only — it answers nothing. */
  dismissHumanTask(id: string): Promise<void>;

  setPrExcluded(prNumber: number, excluded: boolean): Promise<void>;
  /**
   * Authorize landing a whole chain of stacked pull requests, or call that off.
   *
   * On the seam rather than in the drawing code for every mutation's reason:
   * `console/` may not import `api.js`. `landing: false` is the revoke — the standing intent is
   * settled, not un-set, so the record of what was authorized survives.
   */
  setStackLanding(ref: string, landing: boolean): Promise<void>;
  setIssueWatched(issueNumber: number, watched: boolean): Promise<void>;
  setIssueConclusion(issueNumber: number, verdict: 'done' | 'more_work' | null): Promise<void>;
  /**
   * Override the goal assay's verdict (#158). On the seam rather than in the
   * drawing code for the reason every mutation is: `console/` may not import
   * `api.js`, and an
   * `unclear` verdict is the one intake reading that *blocks* dispatch — so
   * without this the only escape hatch is editing the ticket.
   *
   * `null` clears the row, which is a third option and not `workable`: the store
   * keeps one representation of "nobody has decided", and that is also what a
   * crashed assayer leaves behind.
   */
  setIssueAssay(issueNumber: number, verdict: 'workable' | 'unclear' | null): Promise<void>;

  /**
   * Raise a bug against a story: the operator ran it and it does not do what they
   * expect — the one fact about a goal no agent on it can derive.
   *
   * Unlike every other mutation on a story here, this files into the **tracker**
   * rather than writing the harness's own record, and it leaves the story's
   * verdict exactly where it found it: the bug is its own work item and carries
   * the work. `summary` is the operator's report and is required; a desk agent
   * writes it up, so the wording of the ticket is not decided here.
   */
  raiseBug(issueNumber: number, summary: string, title?: string): Promise<void>;

  /**
   * End the harness's run at a goal (issues #203, #234). A run is retained until
   * this is clicked — no pulse, poll or ticket close drops it — so the operator can still
   * open its report; this is the one thing that ends it, it persists, and since
   * #234 it also stops the dispatcher. On the seam for every mutation's reason:
   * `console/` may not reach `api.js`.
   */
  dismissRun(issueNumber: number): Promise<void>;

  /**
   * One work item's durable subtree (`GET /api/work/:ref`), fetched on demand.
   *
   * A read rather than a mutation, and on this seam for the same reason every
   * mutation is: `console/` may not import `api.js`, so without it the work panel
   * could not reach the record at all. It is deliberately **not** a snapshot key
   * — the graph never forgets, so shipping the forest on every poll would be the
   * wrong shape, which is why `/api/work` is its own route.
   */
  fetchWorkSubtree(ref: string): Promise<{ nodes: WorkNodeView[] }>;
}
