import type {
  ContradictionRuling,
  FactCommitment,
  FactRuling,
  GraduationOutcome,
  FilingTargetProbe,
  KnowledgeFactPayload,
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
export type ConsoleTab = 'overview' | 'tickets' | 'knowledge' | 'insights' | 'pets' | 'config';

/**
 * Which reading the Insights page is showing.
 *
 * On `Place` rather than a `useState` in the page, for the tickets query's
 * reason: "why did the fleet keep coming back last week" is a thing an operator
 * sends someone a link to, and a tab held in component state works right up
 * until the back button steps over it or a reload drops it.
 */
export type InsightsView = 'economics' | 'reliability' | 'causes' | 'trend' | 'mix';

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
  decideProposal(id: string, verdict: 'accept' | 'reject', note?: string): Promise<void>;
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
  openInsights(where: { insightsView?: InsightsView; insightsWindow?: InsightsWindow }): void;
  /** Open a goal's page, or return to the overview with null. */
  selectGoal(ref: string | null): void;
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
   * The last lines the session holding the environment up has printed.
   *
   * Fetched rather than read off the snapshot — two hundred lines on every
   * heartbeat is a log nobody has open — so unlike every other action this one
   * *returns* something, and the panel asks again when the run changes.
   */
  localRunOutput(): Promise<string[]>;
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

  promoteFinding(id: string): Promise<void>;
  fileFinding(id: string): Promise<void>;
  dismissFinding(id: string): Promise<void>;

  /**
   * Write down what working a goal taught about working this repository (#355).
   * `originRef` is the goal it was learned on, or null when it was not learned on
   * one — the provenance a reader dates the claim by, and the reason it is a
   * parameter rather than something inferred from wherever the panel was opened.
   */
  proposeLesson(text: string, originRef: string | null): Promise<void>;
  /**
   * Vouch for a proposed lesson. The operator gate, and the whole of what makes
   * a lesson store something other than the stale fleet-wide instruction block
   * `docs/README.md` argues against — so it is a click, never a tool an agent
   * could reach.
   */
  promoteLesson(id: string): Promise<void>;
  /** Prune one, from either live status. Terminal: there is no un-retire. */
  retireLesson(id: string): Promise<void>;

  /**
   * Where a claim stands, on the operator's say-so (#27 phase 2) — promote,
   * demote, reject, or keep it exactly where it is.
   *
   * The whole write surface the Knowledge page has. Nothing here *files* a fact:
   * agents propose through the tool channel, and a page that could file one would
   * be filing a claim with no observation behind it. Naming the reach a fact
   * already has is a ruling rather than a no-op — it is how an operator says a
   * corroborated claim belongs where it is, and the only way the page's "Needs
   * you" section ever empties.
   */
  setFactReach(id: string, reach: FactRuling): Promise<void>;
  /**
   * Commit a claim to the repository (#27 phase 6): open the documentation work
   * for it, and record where the operator says it belongs.
   *
   * **One call, and the reach does not move.** The claim is still true and still
   * delivered while its pull request sits in review — a page that took it out of
   * every prompt at the click would stop the fleet being told something nobody has
   * committed and nobody can yet read. It reaches `committed` when the pull request
   * lands, which the harness sweeps for.
   */
  commitFact(id: string, commitment: FactCommitment): Promise<void>;
  /**
   * Say what became of a graduation the harness will not guess about — a pull
   * request that left the world without ever being seen closed.
   *
   * The one place `committed` is an operator's own word rather than a reading, and
   * it is available only where a pull request was actually opened.
   */
  settleGraduation(id: string, outcome: GraduationOutcome): Promise<void>;
  /**
   * One claim with the observations behind it, in the observers' own words.
   *
   * A read, so it refetches nothing — and its own fetch rather than a field on the
   * snapshot for the transcript tail's reason: the evidence behind a claim runs to
   * thousands of characters, and a polled snapshot should not carry it for every
   * row nobody has opened.
   */
  factDetail(id: string): Promise<KnowledgeFactPayload>;
  /**
   * Answer one contradiction (#27 phase 5): adopt the agent's amendment and
   * supersede the claim, narrow the claim yourself, or say the dispute is wrong.
   *
   * One call and not two, because the first of the three is one act — an amendment
   * promoted without the claim it replaces being superseded leaves the two of them
   * in the same block saying different things, and nothing would be red. Only the
   * last leaves the fact where it was.
   */
  resolveContradiction(id: string, ruling: ContradictionRuling): Promise<void>;
  /** Open one fact's provenance, or close it. A place, so a link to it lands on it. */
  viewFact(id: string | null): void;

  /** `note` is required by the route on a close-out whose goal's validation is flagged. */
  completeHumanTask(id: string, note?: string): Promise<void>;
  declineHumanTask(id: string, note: string): Promise<void>;
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
   * Override one plan part's profile, or clear it with `null` so the part
   * inherits the goal's pin again.
   */
  setPartProfile(planId: string, slug: string, profile: string | null): Promise<void>;
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
   * #234 it also stops the dispatcher. On the seam for every mutation's reason:
   * `console/` may not reach `api.js`.
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
