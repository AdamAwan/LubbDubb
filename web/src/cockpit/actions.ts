import type {
  GoalWatchDeclaration,
  FilingTargetProbe,
  InsightsWindow,
  IssueFiled,
  RecoveryVerdict,
  UpgradeAction,
  SnoozeTarget,
  WorkNodeView,
} from '../types.js';
import type { Place } from './place.js';

/** What an operator concluded about one validation check; the server clears whatever the last act left behind. */
export type ValidationAct =
  | { kind: 'result'; result: 'passed' | 'failed'; note: string }
  | { kind: 'defer'; reason: string }
  | { kind: 'waive'; reason: string }
  | { kind: 'reset' }
  // Not a reading: who is expected to *run* the check next, written on the same row by the same person.
  | { kind: 'handover'; to: 'fleet' | 'human' };

/**
 * Which full-surface panel is in front. One value rather than a boolean per panel, since only one
 * can be in front at once. `{ ask }` carries the queue row it is showing, for an ask with no goal
 * page to be answered on.
 */
export type ConfigTab = 'values' | 'raw' | 'ci' | 'prompts' | 'mcp' | 'notifications' | 'theme';

export type ConsolePanel =
  | 'faults'
  | 'launch'
  | 'build'
  | 'pets'
  | 'localRun'
  | 'setup'
  /** The durable work graph. */
  | 'record'
  /** The whole Up next queue; the Fleet card shows only its head. */
  | 'upnext'
  /** What the world did — the feed reached from the bar menu and the Up next band. */
  | 'signals'
  /** Every environment's health; also the surface behind the bar's `Env` chip. */
  | 'environments'
  | { ask: string }
  | null;

/**
 * Which destination the situation area is on. A selected goal outranks all three, so this says
 * where the nav last was, never what is drawn. `readPlace` aliases old names (`work` → `tickets`,
 * `knowledge` → `?panel=knowledge`) onto their current homes.
 */
export type ConsoleTab =
  | 'overview'
  | 'tickets'
  /** The obstacle board, in the nav slot Knowledge held. Carries no badge. → `docs/spec/27-obstacles.md#in-the-cockpit` */
  | 'obstacles'
  | 'features'
  | 'insights'
  | 'pets'
  | 'config';

/** Which reading the Insights page is showing. On `Place`, not `useState`, so a view is linkable. */
export type InsightsView =
  | 'economics'
  | 'allowance'
  | 'reliability'
  | 'causes'
  | 'trend'
  | 'mix'
  | 'mcp'
  | 'review'
  | 'usage'
  | 'pool';

/**
 * Every mutation the cockpit can perform, pre-bound and refetching on completion. Nothing under
 * `console/` may import `api.js`; this seam is the enumerated surface, asserted structurally by
 * `test/console.test.ts`.
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
  /** End a usage-limit park (issue #318). Refetches: the row moves back to running. */
  resumeAgent(agentId: string): Promise<void>;
  /** "No, wait" — add `agentStallExtendMs` to the countdown on an agent parked with no reason given. */
  extendStall(agentId: string): Promise<void>;

  answerEscalation(id: string, text: string): Promise<void>;
  /** Answer a multi-question ask; positional against the escalation's questions. */
  answerQuestions(id: string, answers: (string | null)[]): Promise<void>;
  dismissEscalation(id: string, note?: string): Promise<void>;
  /**
   * Accept or reject a proposed act. `acknowledged` carries caveat ids the operator ticked; the
   * route refuses the accept if the plan raises a caveat not yet acknowledged.
   */
  decideProposal(id: string, verdict: 'accept' | 'reject', note?: string, acknowledged?: string[]): Promise<void>;
  /**
   * The two ways out of a plan verdict about the **ticket** rather than the plan: close it, or
   * drop the watch tag. Neither is `decideProposal`'s reject, which sends the goal back to a planner.
   */
  backOutProposal(id: string, verdict: 'close' | 'hold', note?: string): Promise<void>;
  /**
   * The assessment itself is wrong, and `text` is why. Ordered verdict-first so a failed rejection
   * leaves the goal correct with a stale card, rather than a settled card with the loop still running.
   */
  overruleShortfall(issueNumber: number, proposalId: string, text: string): Promise<void>;
  /** Stop this goal waiting on an environment, or put it back to waiting. Refetches — changes which rows the bench holds. */
  releaseEnvironmentGate(issueNumber: number, released: boolean, note?: string): Promise<void>;
  decidePermission(id: string, allow: boolean, note?: string): Promise<void>;
  /** Keyed on the task: orphaned work may never have had an agent. */
  decideRecovery(taskId: string, verdict: RecoveryVerdict): Promise<void>;

  replan(planId: string): Promise<void>;
  /** Accept or decline a check the working agent declared through `watch_declare`; accepting runs it once. */
  ruleWatchProposal(issueNumber: number, checkId: string, accept: boolean): Promise<void>;
  /**
   * Write one of a goal's checks — the operator's own, from the goal page. One verb for both a new
   * check and an edit, keyed on slug. Returns what a dry run refused (empty on a clean save).
   */
  saveWatchCheck(issueNumber: number, check: GoalWatchDeclaration): Promise<string[]>;
  /** Drop one of a goal's checks, and the readings taken against it. */
  deleteWatchCheck(issueNumber: number, checkId: string): Promise<void>;
  /** Give one goal's watch on one environment more time; new end is measured from now by the environment's `forMs`. */
  extendWatch(issueNumber: number, environment: string): Promise<void>;
  /** A reviewer's confirmation that a part's acceptance criterion holds. Keyed on the criterion's text, not an index. */
  setAcceptance(planId: string, slug: string, criterion: string, met: boolean): Promise<void>;
  /** One validation check's current reading — see `api.setValidation`. */
  setValidation(issueNumber: number, checkId: string, act: ValidationAct): Promise<void>;
  /** Which plan's modal is open. UI state on this seam because `console/` may not reach `api.js`. */
  viewPlan(planId: string | null): void;
  /** Which goal's retrospective is open, as an `issue:<n>` ref. */
  viewRetro(issueRef: string | null): void;
  /** Which egg is being opened, by pet id, or null to close the ceremony. */
  hatchEgg(id: string | null): void;
  /** Which goal's shared scratchpad is open, as an `issue:<n>` ref. */
  viewScratchpad(issueRef: string | null): void;
  /**
   * Which pull request's review pack is open over the goal page, by number, or null to close it.
   * → `docs/spec/31-review-packs.md#reading-it`
   */
  viewReviewPack(prNumber: number | null): void;
  /** Which idea of the open pack is unfolded — an idea id, `all`, or null for none. */
  openReviewIdea(id: string | null): void;
  /** Which section of the config page is in front, and which group it is scrolled to. */
  openConfig(where: { configTab?: ConfigTab; configGroup?: string | null }): void;
  /**
   * Move about the Insights page: which reading is showing, and the window every reading obeys.
   * One method taking a partial rather than two, so a link to a tab+window pushes one history entry.
   * **The fields are named for the `Place` fields they set** — this object is spread straight into a
   * place patch, where TypeScript stops checking for excess properties.
   */
  openInsights(where: {
    insightsView?: InsightsView;
    insightsWindow?: InsightsWindow;
    /** Which project the shared pool page is narrowed to, or null for every one. */
    poolProject?: string | null;
  }): void;
  /** Open a goal's page, or return to the overview with null. */
  selectGoal(ref: string | null): void;
  /** Open a pull request's page, or leave it with null — landing back on the goal the crumb names. → `docs/spec/17-cockpit.md#the-pull-request-page` */
  selectPr(prNumber: number | null): void;
  /**
   * Put a review thread back in front of the fleet, or take the ask back. Not a reply or a
   * provider write: it marks the thread unanswered so the harness dispatches for it again.
   * → `docs/spec/07-pull-requests.md#reopening-a-thread`
   */
  reopenThread(prNumber: number, threadId: string, reopened: boolean): Promise<void>;
  /** Bring a full-surface panel in front, or dismiss it with null. */
  openPanel(panel: ConsolePanel): void;
  /**
   * Write a configuration fix offered by the Setup reading, through the same route and splice as a
   * config-page edit. The previous value is captured first, so {@link undoConfigFix} can restore it.
   */
  applyConfigFix(checkId: string, set: Record<string, unknown>): Promise<void>;
  /** Put back whatever {@link applyConfigFix} overwrote on this check. */
  undoConfigFix(checkId: string): Promise<void>;
  /** Clear a settled fix's row from the rail. Writes nothing. */
  dismissConfigFix(checkId: string): void;
  /** Drive an upgrade of the harness's own build. `apply` takes this process down, so the call may not return a settled promise. */
  upgrade(action: UpgradeAction, opts?: { interrupt?: boolean }): Promise<void>;
  /** Take a fresh reading of the build, rather than waiting for the pulse's. */
  checkBuild(): Promise<void>;
  /** Fast-forward the *worked* checkout onto its remote branch, since `lubbdubb.project.json` is read from it. */
  pullProject(): Promise<void>;
  /**
   * Hide one of the rail's two update asks for `selfUpdate.snoozeMs`. Records no opinion about
   * which build was declined, so the ask returns at whatever is waiting by then.
   */
  snoozeUpdate(target: SnoozeTarget): Promise<void>;
  /**
   * Start `issueNumber`'s work in the machine's one dev environment — **and stop whatever was in
   * it**. `ref` runs an earlier part of the goal instead of the tip of its stack; the server checks
   * it against that goal's own part branches.
   */
  startLocalRun(issueNumber: number, ref?: string): Promise<void>;
  stopLocalRun(): Promise<void>;
  /** Type into the session holding the environment. Not refetched, like {@link respondAgent}: conversational. */
  messageLocalRun(text: string): Promise<void>;
  /** Move the run's checkout to the tip of its branch and tell the session what moved. Refetches. */
  refreshLocalRun(): Promise<void>;
  /** The last lines the session holding the environment has printed. Fetched on demand, not on every heartbeat. */
  localRunOutput(): Promise<string[]>;
  /**
   * Ask for this goal to be validated against the machine's dev environment. `swap` is consent to
   * taking the environment from whatever is in it. `refresh` moves the checkout to the tip of its
   * branch first — a `reset --hard`, so never automatic. Every caller goes through `ValidateLocallyModal`.
   */
  validateLocally(issueNumber: number, opts?: { swap?: boolean; refresh?: boolean }): Promise<void>;
  /** Call one off. Settles the row — needed when an operator has killed the agent from its drawer. */
  cancelLocalValidation(issueNumber: number): Promise<void>;
  /** Move the nav to a destination. A selected goal still outranks it. */
  openTab(tab: ConsoleTab): void;
  /**
   * Narrow or re-order the Tickets tab (issue #329). One method taking a partial rather than three,
   * since changing a filter also resets to the first page and must push one history entry, not two.
   */
  setTicketQuery(
    next: Partial<
      Pick<
        Place,
        | 'ticketWatch'
        | 'ticketTracking'
        | 'ticketState'
        | 'ticketFeature'
        | 'ticketGroup'
        | 'ticketOrder'
        | 'ticketView'
        | 'ticketColumns'
      >
    >,
  ): void;
  /**
   * Move about the Features tab: which card is open, how the list is ordered, and which of the
   * open card's pull requests are listed. One method for `setTicketQuery`'s reason.
   */
  setFeatureQuery(next: Partial<Pick<Place, 'featureCard' | 'featureSort' | 'featurePrs'>>): void;
  /** Fold a feature's children away in the tickets tab, or open them again. Argument is the state being set, not a toggle. */
  collapseFeature(issueNumber: number, collapsed: boolean): void;
  /** Open one of the goal page's reference sections — `ticket` or `record` — or shut it again. Argument is the state being set. */
  openGoalSection(section: string, open: boolean): void;
  reorderUpNext(origins: string[]): Promise<void>;
  /** Override which model profile the next dispatch on one queued origin runs on, or clear it with `null`. Standing until cleared. */
  setUpNextProfile(origin: string, profile: string | null): Promise<void>;

  /** Crack an egg open. Reveals what the drop already decided and decides nothing — see `docs/spec/22-pets.md#the-egg`. */
  openPet(id: string): Promise<void>;
  feedPet(id: string, beats: number): Promise<void>;
  renamePet(id: string, name: string): Promise<void>;
  placePet(id: string, placed: boolean): Promise<void>;
  blendPet(id: string): Promise<void>;

  /**
   * Move about the obstacle board: which row's sightings are unfolded, and whether the terminal
   * tail is open. One method for `setTicketQuery`'s reason.
   */
  setObstacleQuery(next: Partial<Pick<Place, 'obstacle' | 'obstacleEnded'>>): void;

  /**
   * The four controls on the obstacle board. **None of them is on any path** — a row is filed by
   * an agent, carried to `standing` independently, owned by the pulse and ended by one of these four
   * endings, and none is a step any harness logic waits on. → `docs/spec/27-obstacles.md#every-state-has-an-exit-that-is-not-you`
   */
  muteObstacle(id: string, muted: boolean): Promise<void>;
  /** Name the ticket you are already using. Never an agent, and never a lock. */
  ownObstacle(id: string, ownerRef: string): Promise<void>;
  /** This is over and no reading is going to say so. **Retiring is not rejecting**: a matching report reopens it. */
  retireObstacle(id: string): Promise<void>;
  /** Write a note into the repository now, rather than when the endings desk reaches it. */
  writeDownObstacle(id: string): Promise<void>;

  /** `note` is required by the route on a close-out whose goal's validation is flagged. */
  completeHumanTask(id: string, note?: string): Promise<void>;
  declineHumanTask(id: string, note: string): Promise<void>;
  /**
   * Close the ticket a close-out row names, in the tracker, and settle the row. `config.canCloseIssue`
   * says whether this deployment's tracker can take it; `note` follows the same flagged-validation rule.
   */
  closeHumanTaskTicket(id: string, note?: string): Promise<void>;
  /** Clear a settled task off the bench. Settled only — it answers nothing. */
  dismissHumanTask(id: string): Promise<void>;

  setPrWatched(prNumber: number, watched: boolean): Promise<void>;
  /** Authorize landing a whole chain of stacked pull requests, or call that off. `landing: false` is the revoke, not an unset. */
  setStackLanding(ref: string, landing: boolean): Promise<void>;
  setIssueWatched(issueNumber: number, watched: boolean): Promise<void>;
  /**
   * Move a work item to one of the tracker's own states — the board's drag. **Rejects with the
   * provider's own sentence**, which the card quotes rather than routing through `AsyncButton`.
   */
  setIssueState(issueNumber: number, state: string): Promise<void>;
  /**
   * Put this goal at the front of the queue, or take it back out. Orders and nothing else — a goal
   * held by a cooldown, cap, unapproved plan or ignore tag stays held.
   */
  setGoalPriority(issueNumber: number, priority: boolean): Promise<void>;
  /**
   * Pin a goal's work to a model profile, or clear the pin with `null` (#342). Also the answer to a
   * standing profile proposal, since the gate is waiting on a decision, not agreement.
   */
  setIssueProfile(issueNumber: number, profile: string | null): Promise<void>;
  /** Settle one of a goal's placement questions. `null` is "this goal wants neither". */
  setIssueParent(issueNumber: number, parent: number | null): Promise<void>;
  setIssueAreaPath(issueNumber: number, areaPath: string | null): Promise<void>;
  /** Override one plan part's profile, or clear it with `null` so the part inherits the goal's pin again. */
  setPartProfile(planId: string, slug: string, profile: string | null): Promise<void>;
  /**
   * Restart one plan part: close its open pull request, drop its branch, and hand it back to the
   * fleet against the plan's current declaration. **Never automatic** — closing a reviewable PR is a person's act.
   */
  restartPart(planId: string, slug: string): Promise<void>;
  setIssueConclusion(issueNumber: number, verdict: 'done' | 'more_work' | null): Promise<void>;
  /**
   * Override the goal appraisal's verdict (#158) — `unclear` is the one intake reading that
   * *blocks* dispatch, so without this the only escape hatch is editing the ticket. `null` clears
   * the row, distinct from `workable`, matching what a crashed appraiser leaves behind.
   */
  setIssueAppraisal(issueNumber: number, verdict: 'workable' | 'unclear' | null): Promise<void>;

  /**
   * Tell the fleet what to do on a goal, in the operator's own words. One call writes both the
   * instruction the next agent reads and the `more_work` that makes there be a next agent.
   */
  addInstruction(issueNumber: number, text: string): Promise<void>;

  /** Withdraw a standing instruction. The last one out takes `more_work` with it. */
  withdrawInstruction(issueNumber: number, id: string): Promise<void>;

  /**
   * Raise a bug against a story: the operator ran it and it does not do what they expect. Files
   * into the **tracker**, not the harness's own record, and leaves the story's verdict untouched.
   * `summary` is required; a desk agent writes up the ticket text.
   */
  raiseBug(issueNumber: number, summary: string, title?: string): Promise<void>;

  /**
   * Where an issue raised from the top bar would land, and as whom — asked of the `gh` CLI on the
   * compose modal opening. `available: false` is the CLI's answer, not a fault; a rejection means the
   * probe route itself could not be reached, handled the same way by the modal.
   */
  probeFilingTarget(): Promise<FilingTargetProbe>;

  /**
   * File the operator's own report about LubbDubb onto **LubbDubb's** tracker directly, never the
   * fleet's tracker (issue #449). `watch` decides whether the fleet picks it up, honoured only
   * where this fleet works LubbDubb's own repo (the probe's `watchable`).
   */
  raiseIssue(title: string, body: string, watch: boolean): Promise<IssueFiled>;

  /**
   * End the harness's run at a goal (issues #203, #234). A run is retained until this is clicked;
   * it kills the goal's live agents, cancels queued jobs and settles standing instructions, so every
   * caller goes through `EndRunModal`'s confirmation.
   */
  dismissRun(issueNumber: number, note?: string): Promise<void>;

  /** One work item's durable subtree (`GET /api/work/:ref`), fetched on demand — deliberately not a snapshot key. */
  fetchWorkSubtree(ref: string): Promise<{ nodes: WorkNodeView[] }>;
}
