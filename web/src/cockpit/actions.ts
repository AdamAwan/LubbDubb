import type {
  GoalWatchDeclaration,
  FilingTargetProbe,
  InsightsWindow,
  IssueFiled,
  RecoveryVerdict,
  UpgradeAction,
  WorkNodeView,
} from '../types.js';
import type { Place } from './place.js';

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
/**
 * The config page's own sections. On `Place` rather than in the component for the
 * tickets query's reason: a section is a thing you send someone a link to, and one
 * held in a `useState` works right up until the back button steps over it.
 */
export type ConfigTab = 'values' | 'raw' | 'ci' | 'prompts' | 'mcp' | 'notifications' | 'theme';

export type ConsolePanel =
  | 'faults'
  | 'launch'
  | 'build'
  | 'pets'
  | 'localRun'
  | 'setup'
  /** The durable work graph, which was the console's second nav destination. */
  | 'record'
  /**
   * The whole Up next queue. The Fleet card carries the head of it and this is
   * the rest — a panel rather than a disclosure on the card, because the queue is
   * unbounded and the card's own rows are capped by the fleet.
   */
  | 'upnext'
  /**
   * What the world did — the feed that was the overview's fourth card.
   *
   * A panel because it is consulted rather than watched: the queue and the racks
   * say what is happening, and this says what happened to bring it about. It is
   * named in the bar menu and reached from the Up next band, which is the reading
   * it actually serves — the queue is decided off these signals, so "why is that
   * queued" and "why is nothing" are one click apart from the queue itself.
   */
  | 'signals'
  | { ask: string }
  | null;

/**
 * Which destination the situation area is on. One value rather than a boolean
 * per destination for `ConsolePanel`'s reason exactly — and it is why the nav is
 * a list rather than a hand-written pair: a third tab that has to be remembered
 * in two booleans and four call sites is a third tab that arrives half-wired.
 *
 * A selected goal outranks all three, so this says where the nav last was, never
 * what is drawn.
 *
 * `work` was the second of these and is not a destination any more: the record it
 * drew reads on the goal pages, its triage list reads on the tickets tab, and what
 * was left is the {@link ConsolePanel} `record`. `readPlace` aliases the old name
 * onto `tickets`, where the one part of it an operator still acts on went.
 *
 * `knowledge` went the other way — it was a {@link ConsolePanel} and is a
 * destination now, because ruling on the fleet's claims is triage done in a sitting
 * rather than a number glanced at, and a panel drew over the rail the operator came
 * from. `readPlace` aliases `?panel=knowledge` onto the tab for `work`'s reason.
 */
export type ConsoleTab =
  | 'overview'
  | 'tickets'
  /**
   * The obstacle board — in the nav, in the slot Knowledge held.
   *
   * The operator lifted the URL-only rule the board shipped under, and it takes
   * that slot rather than a fifth one: Knowledge is the tab it replaces, and two
   * tabs answering one question is how an operator ends up ruling on the same
   * thing twice. It carries **no badge** — nothing on the board is waiting on a
   * decision. → `docs/spec/27-obstacles.md#in-the-cockpit`
   */
  | 'obstacles'
  | 'features'
  | 'insights'
  | 'pets'
  | 'config';

/**
 * Which reading the Insights page is showing.
 *
 * On `Place` rather than a `useState` in the page, for the tickets query's
 * reason: "why did the fleet keep coming back last week" is a thing an operator
 * sends someone a link to, and a tab held in component state works right up
 * until the back button steps over it or a reload drops it.
 */
export type InsightsView =
  | 'economics'
  | 'allowance'
  | 'reliability'
  | 'causes'
  | 'trend'
  | 'mix'
  | 'mcp'
  | 'review'
  | 'pool';

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
  /**
   * End a usage-limit park (issue #318) — the one control a parked-on-a-limit
   * agent has, since there is no question to answer and its process is usually
   * gone. Refetches: the row moves back to running and leaves `parkedOnLimit`.
   */
  resumeAgent(agentId: string): Promise<void>;
  /**
   * "No, wait" — add `agentStallExtendMs` to the countdown on an agent parked
   * because it stopped without saying why, before the harness records it done.
   *
   * The one control that buys *time* rather than settling anything: the operator is
   * saying they are looking at this, not what they have decided. Refetches, because
   * the new deadline is what the card is drawing.
   */
  extendStall(agentId: string): Promise<void>;

  answerEscalation(id: string, text: string): Promise<void>;
  /** Answer a multi-question ask; positional against the escalation's questions. */
  answerQuestions(id: string, answers: (string | null)[]): Promise<void>;
  dismissEscalation(id: string, note?: string): Promise<void>;
  /**
   * Accept or reject a proposed act. `acknowledged` carries the caveat ids the
   * operator ticked on a plan approval: the route refuses the accept — nothing
   * decided, the proposal still pending — while the plan raises one the verdict
   * has not named (`src/plans/planCaveats.ts`). Ignored by every other verdict.
   */
  decideProposal(id: string, verdict: 'accept' | 'reject', note?: string, acknowledged?: string[]): Promise<void>;
  /**
   * The two ways out of a plan verdict that are about the **ticket** rather than
   * the plan: close it with the operator's comment, or take the watch tag off and
   * think about it later. Neither is `decideProposal`'s reject — that sends the
   * goal back to a planner, which is the wrong answer to "this is not really an
   * issue".
   */
  backOutProposal(id: string, verdict: 'close' | 'hold', note?: string): Promise<void>;
  /**
   * The third arm of a shortfall proposal: the assessment itself is wrong, and
   * `text` is why. Two calls because they settle two different things — the
   * verdict about the goal, and the card asking what to do about it — and the
   * rejection is the honest verb for the second, since no follow-up part is
   * wanted. Ordered verdict-first so a failed rejection leaves the goal correct
   * with a stale card, rather than a settled card with the loop still running.
   */
  overruleShortfall(issueNumber: number, proposalId: string, text: string): Promise<void>;
  /**
   * Stop this goal waiting on an environment, or put it back to waiting.
   *
   * The escape an environment gate has to have: a goal whose work is never going
   * to reach the environment its obligations are gated on — a docs change, a
   * config change — would otherwise sit delivered with an empty bench for good.
   * Refetches, because what it changes is which rows the bench holds.
   */
  releaseEnvironmentGate(issueNumber: number, released: boolean, note?: string): Promise<void>;
  decidePermission(id: string, allow: boolean, note?: string): Promise<void>;
  /** Keyed on the task: orphaned work may never have had an agent. */
  decideRecovery(taskId: string, verdict: RecoveryVerdict): Promise<void>;

  replan(planId: string): Promise<void>;
  /**
   * Accept or decline a check the working agent declared through `watch_declare`.
   *
   * The one control on the watch surface, and the whole of its authorisation
   * story: an agent's query is not put to the operator's telemetry until the
   * operator says so, and accepting is what runs it once.
   */
  ruleWatchProposal(issueNumber: number, checkId: string, accept: boolean): Promise<void>;
  /**
   * Write one of a goal's checks — the operator's own, from the goal page.
   *
   * One verb for both a new check and an edit, because the slug is the merge key
   * every writer in this subsystem folds on. **What comes back is what the dry run
   * refused**, empty on a clean one: saving puts the query to an environment in the
   * same call, and a query that could not resolve is the thing the form exists to
   * catch before an arrival does.
   */
  saveWatchCheck(issueNumber: number, check: GoalWatchDeclaration): Promise<string[]>;
  /** Drop one of a goal's checks, and the readings taken against it. */
  deleteWatchCheck(issueNumber: number, checkId: string): Promise<void>;
  /**
   * Give one goal's watch on one environment more time.
   *
   * The honest answer for a window that ran out before the weekly job it was
   * about ever ran. It puts a settled verdict back in play, which is the one thing
   * nothing in the harness does on its own — so it is a click, and the new end is
   * measured from now by the environment's own `forMs`.
   */
  extendWatch(issueNumber: number, environment: string): Promise<void>;
  /**
   * A reviewer's confirmation that one of a part's acceptance criteria holds.
   * Keyed on the criterion's text, which is what the server stores — an index
   * would move under a re-worded list and carry the tick onto something nobody
   * looked at.
   */
  setAcceptance(planId: string, slug: string, criterion: string, met: boolean): Promise<void>;
  /** One validation check's current reading — see `api.setValidation`. */
  setValidation(issueNumber: number, checkId: string, act: ValidationAct): Promise<void>;
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
   * Which egg is being opened, by pet id, or null to close the ceremony. On the
   * seam for `viewRetro`'s reason: the modal is shared, and the control that opens
   * it is the enclosure the console draws.
   */
  hatchEgg(id: string | null): void;
  /**
   * Which goal's shared scratchpad is open, as an `issue:<n>` ref. On the seam for
   * `viewRetro`'s reason exactly: the modal is shared and fetches its trail from
   * `api.js`, while the controls that open it are embedded by the surfaces that
   * draw the goal — and several of them reaching one action is what stops the
   * notepad becoming readable from one place only.
   */
  viewScratchpad(issueRef: string | null): void;
  /**
   * Which pull request's review pack is open over the goal page, by number, or
   * null to close it. On the seam for `viewScratchpad`'s reason exactly: the page
   * is shared, hangs off the shell and reaches `api.js` for the pack and for the
   * reviewer's marks, while the control that opens it is on the pull request's row
   * the console draws. → `docs/spec/31-review-packs.md#reading-it`
   */
  viewReviewPack(prNumber: number | null): void;
  /**
   * Which idea of the open pack is unfolded — an idea id, `all`, or null for none.
   * A place, not a `useState` in the page: the back button steps out of an idea
   * and a link lands on one.
   */
  openReviewIdea(id: string | null): void;
  /**
   * Open or close the settings modal — the running config, the CI policy and the
   * prompt book. On the seam for `viewPlan`'s reason: the modal is shared and hangs
   * off the shell (it reaches `/api/config`, which `console/` may not do), while
   * the reading that opens it sits in the top bar.
   */
  /** Which section of the config page is in front, and which group it is scrolled to. */
  openConfig(where: { configTab?: ConfigTab; configGroup?: string | null }): void;
  /**
   * Move about the Insights page: which reading is showing, and the window every
   * reading on it obeys.
   *
   * One method taking a partial rather than two, for `setTicketQuery`'s reason —
   * a tab and a window are one place, and two calls would push two history
   * entries for one move. The window is here at all rather than in the page
   * because it is the page's whole subject: a link to "the causes tab over the
   * last 24 hours" has to carry both halves or it is a link to neither.
   *
   * **The fields are named for the `Place` fields they set**, as `openConfig`'s
   * are, because the implementation spreads this object straight into a place
   * patch — and a spread is exactly where TypeScript stops checking for excess
   * properties. Named `view` and `window`, both halves landed on the place as
   * keys nothing reads, so every tab and every window button on the page was a
   * control that pushed no history entry and changed nothing.
   */
  openInsights(where: {
    insightsView?: InsightsView;
    insightsWindow?: InsightsWindow;
    /** Which project the shared pool page is narrowed to, or null for every one. */
    poolProject?: string | null;
  }): void;
  /** Open a goal's page, or return to the overview with null. */
  selectGoal(ref: string | null): void;
  /**
   * Open a pull request's page, or leave it with null — landing back on the goal
   * the crumb names, which is where the place underneath it already was.
   * → `docs/spec/17-cockpit.md#the-pull-request-page`
   */
  selectPr(prNumber: number | null): void;
  /**
   * Put a review thread back in front of the fleet, or take the ask back.
   *
   * The one thing the pull-request page *does*. It is not a reply and it is not a
   * write to the provider: it says *this is not settled* to the harness, which
   * reads the thread as unanswered again and dispatches for it. The mark is spent
   * by the fleet's next reply into that thread.
   * → `docs/spec/07-pull-requests.md#reopening-a-thread`
   */
  reopenThread(prNumber: number, threadId: string, reopened: boolean): Promise<void>;
  /** Bring a full-surface panel in front, or dismiss it with null. */
  openPanel(panel: ConsolePanel): void;
  /**
   * Write a configuration fix offered by the Setup reading.
   *
   * Straight through `POST /api/config`, exactly as a config-page edit — the same
   * refusal ladder and the same surgical splice, so an operator's comments and key
   * order survive a one-click fix as they survive a typed one. A second writer
   * here would be a second opinion about what a save means.
   *
   * The previous value is captured first, so {@link undoConfigFix} can put it back
   * — or clear the key when the operator's own file never set it.
   */
  applyConfigFix(checkId: string, set: Record<string, unknown>): Promise<void>;
  /** Put back whatever {@link applyConfigFix} overwrote on this check. */
  undoConfigFix(checkId: string): Promise<void>;
  /** Clear a settled fix's row from the rail. Writes nothing. */
  dismissConfigFix(checkId: string): void;
  /**
   * Drive an upgrade of the harness's own build. `apply` takes this process down,
   * so the call it makes may never return a settled promise — the cockpit's
   * reconnect is what shows the new build, exactly as it does for any restart.
   */
  upgrade(action: UpgradeAction, opts?: { interrupt?: boolean }): Promise<void>;
  /** Take a fresh reading of the build, rather than waiting for the pulse's. */
  checkBuild(): Promise<void>;
  /**
   * Fast-forward the *worked* checkout onto its remote branch.
   *
   * The one action here that writes to a repository the harness does not own, and
   * it is offered because `lubbdubb.project.json` arrives that way: a clone days
   * behind is a harness running a config the team has already changed.
   */
  pullProject(): Promise<void>;
  /**
   * Start `issueNumber`'s work in the machine's one dev environment — **and stop
   * whatever was in it**, because there is only one. One method rather than a start
   * and a swap: two names for one transition are two things to keep in step, and
   * the server is where the transition lives either way.
   *
   * `ref` runs an earlier part of the goal instead of the tip of its stack. The
   * server checks it against that goal's own part branches, so the panel can offer
   * a choice without this being a way to check out an arbitrary ref.
   */
  startLocalRun(issueNumber: number, ref?: string): Promise<void>;
  stopLocalRun(): Promise<void>;
  /**
   * Type into the session holding the environment — "run the migrations". Not
   * refetched, like {@link respondAgent}: it is conversational, and the `dirty` the
   * server emits carries the turn's beginning and the echo into the tail.
   */
  messageLocalRun(text: string): Promise<void>;
  /**
   * Move the run's checkout to the tip of its branch and tell the session what
   * moved. Refetched, because the row's commit changed the moment it returned.
   */
  refreshLocalRun(): Promise<void>;
  /**
   * The last lines the session holding the environment up has printed.
   *
   * Fetched rather than read off the snapshot — two hundred lines on every
   * heartbeat is a log nobody has open — so unlike every other action this one
   * *returns* something, and the panel asks again when the run changes.
   */
  localRunOutput(): Promise<string[]>;
  /**
   * Ask for this goal to be validated against the machine's dev environment: the
   * harness brings its code up and puts one agent on writing a test plan, driving
   * the application through it and reporting.
   *
   * `swap` is consent to taking the environment from whatever is in it — the server
   * refuses without it and says what is running, because by the time the runner is
   * called that environment is already coming down. `refresh` moves the checkout to
   * the tip of its branch first: a `reset --hard` under a running server, so never
   * automatic and always the operator's choice.
   *
   * Every caller that could hit either question goes through `ValidateLocallyModal`
   * rather than sending the flags on its own.
   */
  validateLocally(issueNumber: number, opts?: { swap?: boolean; refresh?: boolean }): Promise<void>;
  /**
   * Call one off. Settles the row, and is the only thing that does when an operator
   * has killed the agent from its drawer — a `dispatched` row nobody will report
   * against would otherwise leave the control absent for good.
   */
  cancelLocalValidation(issueNumber: number): Promise<void>;
  /** Move the nav to a destination. A selected goal still outranks it. */
  openTab(tab: ConsoleTab): void;
  /**
   * Narrow or re-order the Tickets tab (issue #329).
   *
   * One method taking a partial rather than three, because the three are one
   * place: changing a filter also drops you back to the first page, and two calls
   * would push two history entries for one move. It is on the seam at all — rather
   * than a `useState` in the panel — because the whole point of the tab is that
   * "unclosed watched items" is a link someone can send.
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
   * Fold a feature's children away in the tickets tab, or open them again. Every feature is
   * open until this closes one, so the argument is the state being *set* rather
   * than a bare toggle — the caller already knows which way the chevron points,
   * and a toggle read from stale props would fight a fold restored from the URL.
   */
  collapseFeature(issueNumber: number, collapsed: boolean): void;
  /**
   * Open one of the goal page's reference sections — `ticket` or `record` — or
   * shut it again. The state being *set* is the argument rather than a bare
   * toggle, for {@link collapseFeature}'s reason: the caller already knows which
   * way the caret points, and a toggle read from stale props would fight a
   * disclosure restored from the URL.
   */
  openGoalSection(section: string, open: boolean): void;
  reorderUpNext(origins: string[]): Promise<void>;
  /**
   * Override which model profile the next dispatch on one queued origin runs on,
   * or clear it with `null`. Standing until cleared, so a retry of
   * the run it priced is priced the same way — and pruned once the harness stops
   * tracking that origin.
   */
  setUpNextProfile(origin: string, profile: string | null): Promise<void>;

  /**
   * The vivarium (`docs/spec/22-pets.md`). Opening a shell, and then three acts:
   * feeding is the only thing beats are spent on, a name is the operator's own,
   * and putting a pet out is what the corner of the rail draws.
   */
  /**
   * Crack an egg open. Reveals what the drop already decided and decides nothing
   * — see `docs/spec/22-pets.md#the-egg`.
   */
  openPet(id: string): Promise<void>;
  feedPet(id: string, beats: number): Promise<void>;
  renamePet(id: string, name: string): Promise<void>;
  placePet(id: string, placed: boolean): Promise<void>;
  blendPet(id: string): Promise<void>;

  /**
   * Move about the obstacle board: which row's sightings are unfolded, and whether
   * the terminal tail is open.
   *
   * One method taking a partial rather than two, for `setTicketQuery`'s reason:
   * they are one place, and opening a row inside the tail is a single move that
   * must not push two history entries. It is on the seam at all — rather than a
   * `useState` in the page — because the fold is the only place the matcher can be
   * seen working or getting it wrong, and that is a link an operator sends someone.
   */
  setObstacleQuery(next: Partial<Pick<Place, 'obstacle' | 'obstacleEnded'>>): void;

  /**
   * The four controls on the obstacle board, and the whole of what an operator can
   * say about a row that no reading can.
   *
   * **None of them is on any path.** The board runs itself — a row is filed by an
   * agent, carried to `standing` by a second independent voice, owned by the pulse
   * and ended by one of the four endings — and nothing here is a step in any of
   * that. That is the invariant the subsystem is arranged around: *every state has
   * an exit that is not you*, so a control the harness waited on would rebuild the
   * queue only a human empties that killed the store this one replaces.
   * → `docs/spec/27-obstacles.md#every-state-has-an-exit-that-is-not-you`
   */
  muteObstacle(id: string, muted: boolean): Promise<void>;
  /** Name the ticket you are already using. Never an agent, and never a lock. */
  ownObstacle(id: string, ownerRef: string): Promise<void>;
  /**
   * This is over and no reading is going to say so. **Retiring is not rejecting**:
   * the row keeps what it said, and a matching report reopens it.
   */
  retireObstacle(id: string): Promise<void>;
  /** Write a note into the repository now, rather than when the endings desk reaches it. */
  writeDownObstacle(id: string): Promise<void>;

  /** `note` is required by the route on a close-out whose goal's validation is flagged. */
  completeHumanTask(id: string, note?: string): Promise<void>;
  declineHumanTask(id: string, note: string): Promise<void>;
  /**
   * Close the ticket a close-out row names, in the tracker, and settle the row.
   *
   * The row's own act rather than a verdict about it — `config.canCloseIssue` says
   * whether this deployment's tracker can take it, and the button is not drawn
   * where it cannot. `note` is required by the route on the same flagged-validation
   * condition `completeHumanTask` is.
   */
  closeHumanTaskTicket(id: string, note?: string): Promise<void>;
  /** Clear a settled task off the bench. Settled only — it answers nothing. */
  dismissHumanTask(id: string): Promise<void>;

  setPrWatched(prNumber: number, watched: boolean): Promise<void>;
  /**
   * Authorize landing a whole chain of stacked pull requests, or call that off.
   *
   * On the seam rather than in the drawing code for every mutation's reason:
   * `console/` may not import `api.js`. `landing: false` is the revoke — the standing intent is
   * settled, not un-set, so the record of what was authorized survives.
   */
  setStackLanding(ref: string, landing: boolean): Promise<void>;
  setIssueWatched(issueNumber: number, watched: boolean): Promise<void>;
  /**
   * Move a work item to one of the tracker's own states — the board's drag, and the
   * only thing in the cockpit that writes one.
   *
   * **Rejects with the provider's own sentence**, which the card quotes: a snap-back
   * with no words attached reads as the board being broken rather than as the tracker
   * refusing a transition. So the caller handles the rejection itself rather than
   * routing the click through `AsyncButton`, which folds one into a tooltip.
   */
  setIssueState(issueNumber: number, state: string): Promise<void>;
  /**
   * Put this goal at the front of the queue, or take it back out. On the seam for
   * every mutation's reason: `console/` may not import `api.js`.
   *
   * It orders and nothing else — a goal held by a cooldown, a cap, an unapproved
   * plan or an ignore tag stays held — which is why it is a separate control from
   * the watch toggle beside it rather than a stronger version of one.
   */
  setGoalPriority(issueNumber: number, priority: boolean): Promise<void>;
  /**
   * Pin a goal's work to a model profile, or clear the pin with `null` (#342).
   * On the seam for every mutation's reason: `console/` may not import `api.js`.
   *
   * It is also the answer to a standing profile proposal — the gate is waiting on
   * a decision, not on agreement, so this settles it either way.
   */
  setIssueProfile(issueNumber: number, profile: string | null): Promise<void>;
  /**
   * Settle one of a goal's placement questions — where it hangs off the backlog,
   * and which area node puts it on a board. `null` is "this goal wants neither",
   * the answer that has nowhere else to be recorded.
   */
  setIssueParent(issueNumber: number, parent: number | null): Promise<void>;
  setIssueAreaPath(issueNumber: number, areaPath: string | null): Promise<void>;
  /**
   * Override one plan part's profile, or clear it with `null` so the part
   * inherits the goal's pin again.
   */
  setPartProfile(planId: string, slug: string, profile: string | null): Promise<void>;
  /**
   * Restart one plan part: close the pull request it has open, drop its branch,
   * and hand the part back to the fleet against the declaration the plan carries
   * now — the operator's answer to an amendment that rewrote a part somebody is
   * already halfway through building.
   *
   * On the seam for every mutation's reason: `console/` may not import `api.js`.
   * **Never automatic** — applying an amendment reaches nothing here; closing a
   * reviewable pull request is a person's act.
   */
  restartPart(planId: string, slug: string): Promise<void>;
  setIssueConclusion(issueNumber: number, verdict: 'done' | 'more_work' | null): Promise<void>;
  /**
   * Override the goal appraisal's verdict (#158). On the seam rather than in the
   * drawing code for the reason every mutation is: `console/` may not import
   * `api.js`, and an
   * `unclear` verdict is the one intake reading that *blocks* dispatch — so
   * without this the only escape hatch is editing the ticket.
   *
   * `null` clears the row, which is a third option and not `workable`: the store
   * keeps one representation of "nobody has decided", and that is also what a
   * crashed appraiser leaves behind.
   */
  setIssueAppraisal(issueNumber: number, verdict: 'workable' | 'unclear' | null): Promise<void>;

  /**
   * Tell the fleet what to do on a goal, in the operator's own words — "change the
   * button to primary", "the permission is wrong".
   *
   * This is what the bare "Work left" toggle became. The verdict it wrote said
   * only *that* there was more, so the next agent re-read the ticket that had
   * already produced the thing the operator was unhappy with; the text is the
   * whole feature. One call writes both halves — the instruction the next agent
   * reads, and the `more_work` that makes there be a next agent — because either
   * one alone does nothing.
   */
  addInstruction(issueNumber: number, text: string): Promise<void>;

  /**
   * Withdraw a standing instruction. The last one out takes the `more_work` with
   * it, so a goal is not bounced back to pickup for words nobody will read.
   */
  withdrawInstruction(issueNumber: number, id: string): Promise<void>;

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
   * Where an issue raised from the top bar would land, and as whom — asked of the
   * `gh` CLI on the compose modal opening (issues #413, #449).
   *
   * A **read** on this seam, like {@link fetchWorkSubtree}, and for the same
   * reason: `console/` may not import `api.js`, and the modal is opened from the
   * bar. Not a snapshot key either — it costs a round trip to the tracker, and the
   * only reader opens rarely.
   *
   * It resolves for both readings. `available: false` is the CLI's answer to the
   * question, not a fault, and the modal shows the reason and offers LubbDubb's own
   * form instead; a **rejection** means the probe route itself could not be reached,
   * which the modal treats the same way.
   */
  probeFilingTarget(): Promise<FilingTargetProbe>;

  /**
   * File the operator's own report about LubbDubb onto **LubbDubb's** tracker,
   * directly — never the tracker the fleet is pointed at (issue #449).
   *
   * The one mutation here that resolves with something rather than `void`: the
   * modal's done state is a link to the issue that was just filed, and a number to
   * go and find would be a worse answer than the one the server already has.
   *
   * Unlike {@link raiseBug} no agent stands between the click and the create — the
   * operator wrote it, so there is no write-up to delegate. `watch` decides whether
   * the fleet picks it up and is passed explicitly: an unwatched issue is the right
   * resting state for a half-formed thought. It is honoured only where this fleet
   * works LubbDubb's own repo, which is what the probe's `watchable` says.
   */
  raiseIssue(title: string, body: string, watch: boolean): Promise<IssueFiled>;

  /**
   * End the harness's run at a goal (issues #203, #234). A run is retained until
   * this is clicked — no pulse, poll or ticket close drops it — so the operator can still
   * open its report; this is the one thing that ends it, it persists, and since
   * #234 it also stops the dispatcher. It is **destructive**: it kills the goal's
   * live agents, cancels its queued jobs and settles its standing instructions, so
   * every caller goes through `EndRunModal`'s confirmation rather than posting on a
   * click. On the seam for every mutation's reason: `console/` may not reach
   * `api.js`.
   */
  dismissRun(issueNumber: number, note?: string): Promise<void>;

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
