import { existsSync } from 'node:fs';
import type { System } from '../system.js';
import type { Config } from '../config.js';
import type {
  Issue,
  IssueAppraisal,
  IssueDelivery,
  IssueInstruction,
  KnowledgeFact,
  LocalRun,
  PlanPart,
  Retrospective,
  ScratchPadSummary,
  TaskSummary,
  WorldSnapshot,
} from '../types.js';
import type { StateSection } from '../wire.js';
import type {
  CockpitState,
  GoalReachView,
  KnowledgeGraduationView,
  KnowledgeDeliveryView,
  LocalRunRefFacts,
  LocalRunTargetView,
  LocalRunView,
  OpenPullRequest,
  PlanPartView,
  PullRequest,
  ValidationResourceView,
} from '../wire.js';
import { buildRefUrls, decisionSubjectRef, issueCommentRef } from './refUrls.js';
import { fleetHistory } from './fleetHistory.js';
import { placementAsks, truncateAreaPaths, type AreaPathTree } from '../intake/placement.js';
import { buildStacks } from '../stacks/stack.js';
import { landedCount, landingFor, landingReadiness } from '../stacks/landing.js';
import { prHealth, prState } from '../prHealth.js';
import { prAttentionStatus, type PrAttentionContext } from '../prAttention.js';
import {
  effectivePickupStates,
  issuePickupStatus,
  openPrForIssue,
  type IssuePickupContext,
} from '../dispatcher/issuePickup.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import { rollUpIssueSpend } from '../issueSpend.js';
import { tallyRunOutcomes } from '../reliabilityInsights.js';
import { retainedRunIssues } from '../floor/runs.js';
import { DEFAULT_COOLDOWN } from '../dispatcher/dispatchCooldown.js';
import { readRunway } from '../supply/runway.js';
import { DISPATCH_RULES } from '../dispatcher/rules.js';
import { trackerCoordinates } from '../mcp/findings.js';
import { featureBoardOn } from '../features/featureBoard.js';
import { rejectionSignalQuery } from '../proposals/proposals.js';
import { graduationReading } from '../knowledge/graduation.js';
import type { Store } from '../store/store.js';
import { detectFileOverlaps, OVERLAP_AGENT_WINDOW } from '../fileOverlap.js';
import {
  KNOWLEDGE_READ_LIMIT,
  renderKnowledgeBlock,
  renderScopedKnowledgeNote,
  ridesSystemPrompt,
} from '../knowledge/block.js';
import { knowledgeBlockCost } from '../knowledge/cost.js';
import { isCold } from '../knowledge/cold.js';
import { checkScopeDrift, checkSightings } from '../knowledge/drift.js';
import { defaultWindow } from '../insightsWindow.js';
import { acceptanceCriteria, bySlug, partDepth, partOrigin, planIssueNumber } from '../plans/parts.js';
import { planScopeDrift } from '../plans/scopeDrift.js';
import { deliveryHold, deliverySignalQuery } from '../delivery/delivery.js';
import { appraisalSignalQuery } from '../intake/appraisal.js';
import { classifyCiFailures } from '../ci/ciPolicy.js';
import { validationVerdict } from '../validation/verdict.js';
import { localRunIsLive } from '../store/localRuns.js';
import { localRunChoices } from '../localRun/ref.js';
import { isActiveTask } from '../tasks.js';
import { validationResourcePath } from '../validation/resources.js';
import { withLiveClaim } from '../validation/desktop.js';
import { watchLabelFor } from '../watchLabels.js';
import { allGoalReach } from '../environments/reach.js';
import { environmentGateHold } from '../environments/arrival.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { resolveModelTag } from '../modelLabels.js';
import { orderedProfiles } from '../agents/modelPolicy.js';

/**
 * The section names, as a value.
 *
 * Here and not beside the type in `src/wire.ts`, which the cockpit type-imports
 * and which therefore carries **no runtime** — anything that survives erasure
 * there becomes server code in the SPA bundle (`test/wireContract.test.ts`). The
 * annotation catches a name that is not a section; a section missing from the
 * list is caught by `test/stateSections.test.ts`, which would find its keys
 * belonging to no section at all.
 */
export const STATE_SECTIONS: readonly StateSection[] = [
  'harness',
  'control',
  'goals',
  'plans',
  'fleet',
  'knowledge',
  'queue',
  'inbox',
  'activity',
];

const ALL_SECTIONS: ReadonlySet<StateSection> = new Set(STATE_SECTIONS);

/**
 * A read deferred until something asks for it, and taken once when it is.
 *
 * The snapshot's discipline has always been "read once and share, so two parts of
 * the UI cannot disagree" — this keeps that and adds the other half: a section
 * nobody asked for pays for nothing. Both properties matter and they pull in
 * opposite directions, which is why the deferral is a memo rather than a second
 * read at each call site.
 */
function once<T>(read: () => T): () => T {
  let held: { value: T } | null = null;
  return () => {
    held ??= { value: read() };
    return held.value;
  };
}

interface SnapshotOpts {
  artifactSigner?: (flagId: string) => string;
  attachmentSigner?: (attachmentId: string) => string;
}

/**
 * The world the cockpit draws: the baseline the last pulse persisted, **never a
 * fresh provider fetch**. `connector.getState()` is a fan-out — for `azure`,
 * `2 + 3N` REST calls for `N` open PRs — and the cockpit refetches this snapshot
 * on every `dirty`, one of which rides *every file an agent writes*. Reading the
 * provider here made the request rate a function of agent tool-call volume and
 * of how many cockpit tabs were open, which is a rate-limit block waiting to
 * happen. So the pulse is the only provider reader, and this is its record.
 *
 * Two properties make the substitution sound. The baseline is written *before*
 * the dispatch world is filtered (`Harness.runCycle`), so it is the **unfiltered**
 * world and an `-ignore`d PR stays visible here with its health — the very reason
 * this read the connector directly. And it is a pulse old, so it says so:
 * `worldObservedAt` is the reading's age, exactly as `world_read` reports
 * `observedAt` to an agent.
 *
 * A missing baseline (before the first cycle) ships an **empty** world rather
 * than falling back to a live fetch. The fallback is the obvious move and is
 * wrong: boot while the provider is throttling and the boot cycle fails, so the
 * baseline is never written, so every `dirty` refetches, fans out, fails, records
 * an error — which broadcasts another `dirty`. Unbounded, and worst exactly when
 * the provider is already refusing us. An empty world cannot do that.
 */
export function buildStateSnapshot(system: System, opts?: SnapshotOpts): CockpitState {
  // Every section, so the result is the whole `CockpitState` the type promises —
  // the cast is sound because `ALL_SECTIONS` is the partition the structural test
  // holds against the wire type.
  return buildStateSections(system, ALL_SECTIONS, opts) as CockpitState;
}

/**
 * The same build, narrowed to the sections a caller asked for.
 *
 * What it exists for: the cockpit refetches on every `dirty`, and a `dirty` rides
 * *every* file an agent writes, every usage report and every progress note — none
 * of which say anything about the world's goals. Rebuilding the goal enrichment
 * for one of those was around 75 ms of a ~125 ms build, per signal, per open
 * cockpit. The socket now names the sections a signal touched
 * ({@link ServerEvent}) and the browser asks for those, merging the patch over the
 * snapshot it holds — so the cockpit's state stays one complete object and no
 * surface has to learn about partiality. → `docs/spec/16-http-api.md#sections`
 */
export function buildStateSections(
  system: System,
  want: ReadonlySet<StateSection>,
  opts?: SnapshotOpts,
): Partial<CockpitState> {
  const { store, connector, config, runtimeControl, harness, recovery, updates, agents: fleet } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);
  const baseline = store.getWorldBaseline();
  const world: WorldSnapshot = baseline ?? {
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
  };
  const tasks = store.listTasks();
  // Read once and shared three ways: the fleet list the cockpit draws, the
  // overlap join below, and the per-goal spend roll-up — the last of which is a
  // sum over exactly these rows, so a second read could ship a card whose total
  // disagreed with the agents printed beside it.
  const agents = store.listAgents();
  // The slice of those two lists the snapshot ships. A thunk, so a request for
  // another section pays nothing for it, and taken from the shared reads above
  // rather than from a second query — the roll-ups below are still answers about
  // the *whole* fleet, and a bound applied at the read would have quietly turned
  // the Yield gauge and every goal's spend into readings about the last two
  // hundred runs.
  const history = once(() => fleetHistory(agents, tasks));
  const control = runtimeControl.snapshot();
  // Hoisted (not inlined into the returned object) because the artifact-URL map
  // below is derived from the same list.
  const flags = store.listAllFlags();
  // Hoisted for the same reason: the URL map below is derived from the same rows.
  const attachments = store.listAllAttachments();
  // What the knowledge base actually delivers (issue #27 phase 3), from the two
  // renderers that deliver it, with the cap the launch reads. Everything the two
  // panels say about what is *sent* comes from here — the block's budget meter,
  // the per-claim drop, and the lesson rows' "sent to agents" chip alike.
  const delivery = once(() => knowledgeDelivery(store, config.knowledgeBlockChars));
  // The harness's own clock rather than `world.takenAt`: both readings below are
  // about how long ago something happened *now*, and dating them to a world
  // snapshot that is a pulse old would put the staleness verdict a pulse behind
  // the page drawing it.
  const readAt = Date.now();
  // What the harness has seen of each check name — the dispatches it made and the
  // checks the provider is reporting — for the `check:` staleness verdict below.
  // Derived from records already in hand rather than from a new write path: a
  // recorder for a reading is a second record to keep true, and the failure this
  // surfaces is silent non-delivery, which a recorder that stopped writing would
  // reproduce rather than reveal.
  const sightings = checkSightings(tasks, world.pullRequests);
  // The work graph, read once for every graduation in flight rather than a subtree
  // query each: the list is the operator's own clicks, and this is a polled snapshot.
  const graduationNodes = store.listWorkNodes();
  const graduations = store.listGraduations().map(
    (graduation): KnowledgeGraduationView => ({
      ...graduation,
      reading: graduationReading(
        graduation,
        // The job's own node and its children: the first is what says a job was
        // cancelled before it ever opened one, and the second is the pull request.
        graduationNodes.filter((n) => n.ref === `job:${graduation.jobId}` || n.parentRef === `job:${graduation.jobId}`),
      ),
    }),
  );
  // What the fleet knows about working this repository, every reach and the
  // rejected tail included (issue #27 phase 2). Read here for lessons' reason
  // twice over: each fact's `originRef` and its `goal:` scope both name a goal the
  // world has usually dropped, and the page draws each as a way there.
  //
  // The count is taken here, from the store, and never in the browser: it is
  // `distinctCorroborators`' answer — two observations are one corroborator if
  // they share a goal or a session — and a `rows.length` in the view layer would
  // be free to disagree with the count that actually promotes a claim.
  const facts = store.listFacts();
  // Every count on a fact row, taken together in the store: the agreement count,
  // the dispute count, the fraction that is, and how often the claim was asked
  // for. One read rather than four, so the ratio the page draws and the count
  // beside it cannot be answers to two different questions about the same rows.
  const factCounts = store.factCounts();
  // Work only a person can do. Read here rather than only in the panel for
  // findings' reason: each row's `originRef` names the work it belongs to, and the
  // panel links it through the same ref map as everything else.
  const humanTasks = store.listHumanTasks();
  // Every row, capless. The panel takes the feed above; the runway band takes
  // this, because both of its questions — the debt count and whether a `supply`
  // notice is standing — are asked of the whole bench.
  const allHumanTasks = store.listAllHumanTasks();
  // Acts put to a human. Read here for the same reason as findings: a proposal's
  // ref (`pr:42:merge`) names the item its card links to, so it feeds the link
  // map below as well as the cards themselves.
  const proposals = store.listProposals();
  // Bugs the operator raised from a story row. Read here for findings' reason: the
  // ref each carries once filed is a brand-new item the world lists do not hold yet.
  const bugFilings = store.listBugFilings();
  // The files the newest agents wrote, for the overlap detector below — the one
  // question the rows could always answer and nothing ever asked.
  //
  // **A window, not the table.** The whole of `agent_files` used to ride this
  // snapshot as `files` so that an open drawer could read one agent's slice of it:
  // 87% of the payload, built and serialised on every poll, to draw a list about
  // one agent. That list is `GET /api/agents/:id/files` now, and what is left is
  // the detector, which only concurrent agents can contribute to — so it is run
  // over the newest `OVERLAP_AGENT_WINDOW` rows.
  const overlapAgents = agents.slice(0, OVERLAP_AGENT_WINDOW);
  const overlaps = once(() =>
    detectFileOverlaps({
      files: store.listFilesForAgents(overlapAgents.map((a) => a.id)),
      agents: overlapAgents,
      tasks,
    }),
  );
  // The plan graph, read once and shared by the per-issue pickup verdict below
  // and the snapshot itself, so the chip and the panel can't disagree.
  const plans = store.listPlans();
  const planParts = store.listAllPlanParts();
  const stacks = buildStacks(world.pullRequests, plans, planParts, config.defaultBranch);
  // Open, not merely present: `landingFor` rejects an intent covering a rung
  // outside the chain only while that rung is still open, or a chain that has
  // shrunk by merging would lose its own landing.
  const openPrNumbers = new Set(world.pullRequests.filter((p) => !p.merged).map((p) => p.number));
  // Hoisted out of the two `landedCount` call sites below: one read of the durable
  // merge record per snapshot rather than one per chain.
  const mergedPrs = store.mergedPrs();
  // Standing *and* stopped: a stopped intent is the one the rack most has to keep
  // showing, since it is the state that says nothing further will merge on its own.
  const landings = store.listStackLandings().filter((l) => l.status === 'standing' || l.status === 'stopped');
  // A plan's parts are its **shape** — the conclusion resolver asks for them
  // because "one pull request" is no live parts, not a status.
  const planPartsOf = (origin: string): PlanPart[] => {
    const plan = plans.find((p) => p.originRef === origin);
    return plan ? planParts.filter((p) => p.planId === plan.id) : [];
  };
  // The same rows, translated for the wire (#171). The plan reconciler's one
  // living status comment is stored as a **provider comment id**, which is what
  // `upsertIssueComment` round-trips and exactly what the cockpit must not hold:
  // an id resolves to nothing on its own, and a bare number reads as an *issue
  // number* to `githubRefUrl`. `issueCommentRef` pairs it with the issue it lives
  // on, so the ref shipped here is one `refUrls` can answer — and the same
  // function feeds that map below, so the key and the lookup cannot disagree.
  const wirePlans = plans.map((p) => ({ ...p, statusCommentRef: issueCommentRef(p.originRef, p.statusCommentRef) }));
  // The two readings a part row cannot carry, folded once here rather than in the
  // browser: the acceptance checklist, whose criterion text is the key each tick is
  // stored under, and the scope drift, which is a join across `agent_files` and
  // `tasks` the cockpit does not hold. Per plan, because drift needs the issue
  // number to rebuild the part origins the tasks were dispatched on.
  //
  // Drift reads its own file rows, and **never the overlap detector's window
  // above**: a plan is judged against the agents that worked *its* parts, which on
  // a goal that has been running for a fortnight are nowhere near the newest
  // couple of hundred rows. Sharing that read would leave the sheet reporting a
  // part as inside its declared scope because the agent that left it was too old
  // to be in the window — the check passing for the reason it should have fired.
  // So the population is the part origins themselves.
  const partOrigins = new Set(
    plans.flatMap((plan) => {
      const issueNumber = planIssueNumber(plan.originRef);
      if (issueNumber === null) return [];
      return planParts.filter((p) => p.planId === plan.id).map((p) => partOrigin(issueNumber, p.slug));
    }),
  );
  const driftFiles = store.listFilesForAgents([
    ...new Set(
      tasks.flatMap((t) =>
        t.originRef !== null && partOrigins.has(t.originRef) && t.agentId !== null ? [t.agentId] : [],
      ),
    ),
  ]);
  const drift = new Map<string, string[]>();
  for (const plan of plans) {
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) continue;
    for (const d of planScopeDrift(
      issueNumber,
      planParts.filter((p) => p.planId === plan.id),
      tasks,
      driftFiles,
    )) {
      drift.set(d.partId, d.paths);
    }
  }
  // Indexed per plan, because depth is a walk over *siblings*: one index across
  // every plan would let two plans that happen to share a slug resolve each
  // other's dependencies.
  const partIndexes = new Map(plans.map((plan) => [plan.id, bySlug(planParts.filter((p) => p.planId === plan.id))]));
  const wirePlanParts: PlanPartView[] = planParts.map((part) => ({
    ...part,
    depth: partDepth(part, partIndexes.get(part.planId) ?? bySlug([part])),
    acceptanceCriteria: acceptanceCriteria(part),
    outsideScope: drift.get(part.id) ?? [],
  }));
  // The validation plan, read once and grouped by the goal it belongs to — which
  // is what it is keyed on, so the sheet, the chip and the flag all read one map
  // with no join through the plan to get wrong.
  // Read through `withLiveClaim`, never off the row: a claim past its expiry
  // holds nothing, and the cockpit must stop drawing it at the same instant it
  // stops blocking `validate-check`. `claimIsLive` is the one definition of that,
  // and this is where the cockpit gets it.
  const claimNow = new Date().toISOString();
  const validationChecks = store
    .listAllValidationChecks()
    .map((check) => withLiveClaim(check, claimNow, config.validation.desktopClaimMinutes));
  const checksByGoal = new Map<string, typeof validationChecks>();
  for (const check of validationChecks) {
    const list = checksByGoal.get(check.originRef);
    if (list) list.push(check);
    else checksByGoal.set(check.originRef, [check]);
  }
  // Resolved here rather than in the browser: the path is `validationRoot` joined
  // with the goal's directory, which is config the cockpit does not hold, and
  // "is it there" is a filesystem question only this side can answer.
  const wireValidationResources: ValidationResourceView[] = store.listAllValidationResources().map((resource) => {
    const path = validationResourcePath(config.validationRoot, resource.originRef, resource.name);
    return { ...resource, path, present: existsSync(path) };
  });
  // Standing "is this issue finished" verdicts, keyed on the issue origin — the
  // same rows rule `work-item-back-to-pickup` reads, so the chip and the rule can't disagree.
  const conclusions = new Map(store.listIssueConclusions().map((c) => [c.originRef, c]));
  const deliveries = store.listDeliveries();
  const deliveriesByOrigin = new Map(deliveries.map((d) => [d.originRef, d]));
  const deliveryWindow = deliverySignalQuery(deliveries);
  // The harness's runs at each goal (issues #203, #234), keyed on the issue origin
  // the run field below reads off. Minted at pickup and living until the operator
  // dismisses them, so a goal is drawn — and acted on — after the tracker has
  // forgotten the issue; see the retained list after the issue map.
  const issueRuns = store.listIssueRuns();
  const runByOrigin = new Map(issueRuns.map((r) => [r.originRef, r]));
  // The negative mirror, keyed the same way — the rows rule `issue-shortfall`
  // reads, so the chip and the rule cannot disagree about what fell short.
  const shortfalls = store.listShortfalls();
  const shortfallsByOrigin = new Map(shortfalls.map((s) => [s.originRef, s]));
  // What the agents on each goal wrote each other, as a count and an age. One
  // grouped read for the whole world (see `Store.listScratchPadSummaries`), keyed
  // on the issue origin like every other per-goal record.
  const padsByOrigin = new Map(store.listScratchPadSummaries().map((p) => [p.padRef, p]));
  // What the operator has asked for on each goal and no agent has concluded yet.
  // One read for the whole world, grouped here rather than queried per goal for
  // the pads' reason — and shipped in full rather than as a count, because unlike
  // a pad these are short, few, and the thing the operator most needs to see they
  // said.
  const instructionsByOrigin = new Map<string, IssueInstruction[]>();
  for (const instruction of store.listAllStandingInstructions()) {
    const held = instructionsByOrigin.get(instruction.originRef);
    if (held) held.push(instruction);
    else instructionsByOrigin.set(instruction.originRef, [instruction]);
  }
  const appraisals = store.listAppraisals();
  const appraisalWindow = appraisalSignalQuery(appraisals);
  // Keyed the same way the conclusion and shortfall maps below are, so the
  // per-issue verdict beside them reads off one lookup.
  const appraisalsByOrigin = new Map(appraisals.map((a) => [a.originRef, a]));
  // The same inputs rule `issue-pickup` of the dispatcher consults, so the per-issue verdict
  // below predicts what actually happens next cycle. The decision window (200)
  // and the headroom arithmetic mirror `Harness.runCycle`.
  const pickupCtx: IssuePickupContext = {
    policy: system.issuePickup,
    cooldown: DEFAULT_COOLDOWN,
    now: world.takenAt,
    tasks,
    recentDecisions: store.listDecisions(200),
    // Unfiltered on purpose: an `-ignore` tagged PR is hidden from dispatch but
    // is still an open PR, so it still parks its issue (see `openPrForIssue`).
    openPrs: world.pullRequests,
    // Same plan inputs rules `issue-plan`/`issue-pickup` read, so the chip explains an issue parked in
    // the funnel rather than claiming it's eligible for a pickup that won't fire.
    plans,
    planParts,
    // The harness's own park, read the same way `Harness.runCycle` reads it — the
    // event query is null (and no read happens) until an issue has been assessed.
    deliveries,
    deliverySignals: deliveryWindow ? store.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs) : [],
    // The content gate in front of the funnel, read exactly as `Harness.runCycle`
    // reads it, so the chip reports an issue *awaiting* an appraisal rather than
    // calling it eligible for a pickup that has not happened yet.
    appraisals,
    appraisalSignals: appraisalWindow ? store.listWorldEventsSince(appraisalWindow.since, appraisalWindow.refs) : [],
    // So a closed ticket whose run still lives reads `retained` rather than
    // `done` — the same rows the retained list below is built from (issue #234).
    runs: issueRuns,
    headroom: control.paused ? 0 : Math.max(0, control.cap - store.countLiveAgents()),
    paused: control.paused,
  };
  // The PR-side sibling: whose turn each PR is on. Asked off the same predicates
  // the rules ask, including the rejection expiry — the query is null (and the
  // read never happens) until an operator has actually rejected something, which
  // is the same shape `Harness.runCycle` and the executor use.
  const signals = rejectionSignalQuery(proposals);
  const attentionCtx: PrAttentionContext = {
    // Unfiltered, exactly as `inheritedCiFailure`/`basePrOf` need it (and as the
    // pickup context above takes it): an unwatched base still attributes.
    openPrs: world.pullRequests,
    defaultBranch: config.defaultBranch,
    watchLabel,
    tasks,
    proposals,
    rejectionSignals: signals ? store.listWorldEventsSince(signals.since, signals.refs) : [],
    recentDecisions: pickupCtx.recentDecisions,
    cooldown: DEFAULT_COOLDOWN,
    // The same policy the dispatcher holds, so `attention` names the court rule `pr-ci-failing`
    // will act in rather than promising an agent for a check the policy holds.
    ci: config.ci,
    now: world.takenAt,
    // Read, never written, here: the pulse folds this table and the snapshot only
    // renders it. A write from the read path would restart every clock on
    // whatever schedule the cockpit happened to poll on.
    reviewWaits: store.reviewWaits(),
  };
  // The world's change history the Activity feed / Signals panels draw. Read here
  // rather than at the snapshot literal below because its entries carry structured
  // refs (`pr:42`, `issue:13`) the feed links, so they have to be fed into the ref
  // map — and an event can name a PR that merged out of the open list, so its ref
  // is resolved on its own rather than borrowed from a world item now gone.
  const worldEvents = store.listWorldEvents(100);
  // The audit rows the shift log draws, each carrying the one external thing it is
  // about. Derived here so the ref that keys `refUrls` below and the ref the column
  // looks up in it are the same string — see `decisionSubjectRef`.
  const shiftLog = store.listDecisions(100).map((d) => ({ ...d, subjectRef: decisionSubjectRef(d.action) }));
  // The provider builds every URL (see CompositeConnector.resolveRefUrl); the
  // cockpit only looks refs up in this map, so it stays provider-agnostic.
  const refUrls = buildRefUrls({
    // Closed PRs are linked from the cockpit's "recently closed" list, so their
    // `#n` needs a URL too — the ref map is what the UI looks numbers up in.
    pullRequests: [...world.pullRequests, ...(world.closedPullRequests ?? [])],
    issues: world.issues,
    taskBranches: tasks.map((t) => t.branch),
    // A filed ticket is brand new, so it is usually *not* in the world lists the
    // `#n` keys are built from — it needs resolving by its canonical ref or the
    // chip the operator just created links nowhere.
    refs: [
      // Everything a claim draws as a way somewhere, and every one of them outlives
      // the world lists: the goal it was first observed on and the goal a `goal:`
      // scope names are both usually long finished by the time anyone reads the
      // claim, the item it is *about* is often a closed duplicate, and where it
      // went is a pull request or a ticket the exit only just produced.
      ...facts.map((f) => f.originRef),
      ...facts.map((f) => f.aboutRef),
      ...facts.map((f) => (f.scope.startsWith('goal:') ? f.scope.slice('goal:'.length) : null)),
      ...graduations.map((g) => g.prRef),
      ...graduations.map((g) => g.ticketRef),
      // Both halves of a raised bug: the story it came from, and the bug itself once
      // the filing agent reports it — the chip on the row links the latter.
      ...bugFilings.map((b) => b.originRef),
      ...bugFilings.map((b) => b.ticketRef),
      ...humanTasks.map((t) => t.originRef),
      ...proposals.map((p) => p.ref),
      // The comments the harness maintains on a ticket without being asked — the
      // plan's status comment and the appraisal's refusal (#171). Read off the values
      // actually shipped (and off the same `issueCommentRef` for the appraisal), so a
      // ref the cockpit holds is always the ref this map was keyed by. A provider
      // that resolves neither leaves them absent, and the cockpit draws nothing.
      ...wirePlans.map((p) => p.statusCommentRef),
      ...appraisals.map((a) => issueCommentRef(a.originRef, a.commentRef)),
      // Each Activity-feed / Signals entry's structured ref, so the feed can link
      // it — the summaries embed `#n` (covered by the item lists), but the ref
      // itself (`pr:42`, `issue:13`) is only keyed here.
      ...worldEvents.map((e) => e.ref),
      // Every tracked task's origin ref (`pr:142:ci`, `issue:13`, `issue:13:part:x`):
      // the fleet card, the overlap panel and the recovery panel each link one, and
      // the colon-form origin is not the `#n` the item lists are keyed by. A
      // `job:<id>` origin resolves to nothing and is simply omitted.
      ...tasks.map((t) => t.originRef),
      // Every goal's own canonical ref. The `#n` keys above cover the same
      // tickets, but a goal's plan and its queue speak in the
      // colon form (`issue:13` is the patch's ref, and a crate's origin), and a
      // family that is only keyed when a task or a world event happens to name it
      // is one that links on a busy world and renders plain on a quiet one.
      ...world.issues.map((i) => `issue:${i.number}`),
      // The goals whose run outlives the ticket (issues #203, #234): retained runs
      // are synthesized below and are, by definition, absent from `world.issues`,
      // so their patch would be the one tab on the strip that never links.
      ...issueRuns.map((r) => r.originRef),
      // What each audited decision is about, keyed off the same derivation the
      // row ships — see `shiftLog`.
      ...shiftLog.map((d) => d.subjectRef),
    ],
    resolve: (ref) => connector.resolveRefUrl(ref),
  });
  // What every goal has cost, from the same `agents` rows the fleet list ships —
  // plus its local runs, which are billed to the same account and named by the same
  // origin. The work graph is read (not the world) because it never forgets a merged
  // pull request: a goal's total must not fall when its PRs age out of `closedPrs`.
  const spend = once(() =>
    rollUpIssueSpend({
      agents,
      tasks,
      nodes: store.listWorkNodes(),
      localRuns: store.listLocalRuns(),
    }),
  );
  // The per-issue enrichment, hoisted so a live world issue and a retained
  // completion synthesized below go through one path — the reasons the pickup and
  // conclusion verdicts are computed here rather than in the browser apply to both,
  // and two enrichment paths would drift exactly on a finished goal.
  // The flagged goals, as the goal page's chip reads them: keyed on the same
  // `issue:<n>` origin the flag is written against.
  const goalPriorities = new Map(store.listGoalPriorities().map((g) => [g.originRef, { since: g.since }]));
  const validationChecksFor = (origin: string): ReturnType<typeof validationVerdict> | null => {
    const checks = checksByGoal.get(origin) ?? [];
    return checks.length === 0 ? null : validationVerdict(checks);
  };
  // Where a goal *belongs*, as the placement questions are judged against it: the
  // project's area tree as the harness last read it, and whether anything can
  // write a placement at all. Both are facts about the deployment, so they are
  // resolved once here rather than per issue.
  const placementCtx: PlacementContext = {
    areaTree: system.areaPaths.current(),
    canPlace: connector.canPlaceWorkItem(),
  };
  const enrichIssue = (issue: Issue) => {
    const origin = issueConclusionOrigin(issue.number);
    const run = runByOrigin.get(origin);
    return {
      ...issue,
      pickup: issuePickupStatus(issue, pickupCtx),
      // `conclusion` sits beside `pickup` and does not feed it — the same
      // relationship `attention` has to `health`. Pickup answers "would an agent
      // start next cycle", conclusion answers "has anyone said this is finished".
      conclusion: resolveIssueConclusion(
        conclusions.get(origin) ?? null,
        plans.find((p) => p.originRef === origin) ?? null,
        planPartsOf(origin),
        shortfallsByOrigin.get(origin) ?? null,
      ),
      // Beside the conclusion and the pickup verdict, never inside either: what
      // fell short and what the harness has offered to do about it.
      shortfall: shortfallsByOrigin.get(origin) ?? null,
      // The positive mirror — the assessor's "this goal is reached" — present only
      // while it still stands (`standingDelivery`).
      delivery: standingDelivery(deliveriesByOrigin.get(origin), issue, pickupCtx),
      // The intake verdict, beside the other two and inside `pickup` for none.
      appraisal: appraisalVerdictOf(appraisalsByOrigin.get(origin), issue, placementCtx),
      // What this goal's work is pinned to, read off its own labels through the
      // same pure function the dispatcher resolves the pin with — so the chip and
      // the dispatch can never disagree about which profile is standing.
      modelPin: (({ profile, ignored }) => ({ profile, ignoredTags: ignored }))(
        resolveModelTag(issue.labels, config.labelPrefix, config.agentModels),
      ),
      // Whether the operator has put this goal at the front of the queue, from the
      // same rows the dispatcher ranks by — so the chip cannot claim a priority the
      // ranking is not honouring.
      priority: goalPriorities.get(origin) ?? null,
      // The run's own write-up (rule `issue-retro`) — the reading, never the writing.
      retrospective: retroReading(store.getRetrospective(origin)),
      // The shared pad the agents on this goal left each other — the reading, for
      // the retrospective's reason: the trail is fetched when a reader opens it.
      scratchpad: padReading(padsByOrigin.get(origin)),
      // What the operator has asked for and nobody has concluded yet — in full,
      // unlike the pad above: it is the operator's own words, they are what the
      // next agent will act on, and a count would tell them nothing they did not
      // already know about a thing they wrote themselves.
      instructions: instructionsByOrigin.get(origin) ?? [],
      // The harness's run at this goal (issues #203, #234) — when it started, when
      // it was first observed finished, and whether the operator has ended it.
      // Absent when the harness has never had work under the goal, so the floor
      // reads four states — untouched, running, finished, dismissed — off one
      // optional field.
      run: run
        ? {
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            outcome: run.outcome,
            dismissed: run.dismissedAt !== null,
          }
        : undefined,
      // What this goal has cost so far — every agent under it, including the ones
      // dispatched against its parts and its pull requests. Null is "no runtime
      // ever reported usage for this goal", which PTY mode makes the normal case;
      // it is not zero, and the cockpit draws nothing rather than "$0.00".
      spend: spend().byIssue.get(origin) ?? null,
      // Whether this goal's validation plan is settled. Null is "no checks",
      // which is a third reading and not a synonym for clear: a goal nobody wrote
      // a plan for draws no chip, where a clear one draws a chip it earned.
      validation: validationChecksFor(origin),
    };
  };
  // The open pull requests with their three verdicts folded — hoisted out of the
  // `world` literal below because the local run's rows read the same rows: what has
  // happened on a branch has to be the same answer wherever it is asked, and
  // `ciVerdict` in particular is a classification that must not be made twice.
  const openPullRequests = once((): OpenPullRequest[] =>
    world.pullRequests.map((pr) => ({
      ...pr,
      // Two verdicts about one PR because "can this merge" and "whose turn is it" are
      // different questions with different right answers for the same PR
      // (see `src/prAttention.ts`).
      health: prHealth(pr, world.pullRequests),
      attention: prAttentionStatus(pr, attentionCtx),
      // The third verdict beside the other two, and it exists for the same reason
      // they are computed here rather than in the browser: the alternative is shipping
      // `config.ci` and re-matching client-side, which means a second glob matcher and
      // a second first-match-wins ordering sitting nowhere near the rule they
      // duplicate. That drift would fail silently — the cockpit saying *repair* while
      // the harness held. Same call the dispatcher makes, off the same policy.
      ciVerdict: classifyCiFailures(pr.ciChecks, config.ci, pr.ciChecksWithheld),
    })),
  );
  // Branch → the pull request on it, open rows first so a reopened branch reads as
  // open. Built once: every ref the local-run rows describe looks itself up here,
  // and the lookup is by **branch** precisely so a goal's other pull requests can
  // never be presented as facts about the ref being run.
  const prByBranch = once(() => {
    const map = new Map<string, PullRequest>();
    for (const pr of [...(world.closedPullRequests ?? []), ...openPullRequests()]) map.set(pr.branch, pr);
    return map;
  });
  /**
   * What this deployment *is*, rather than what the fleet is doing: the cockpit's
   * config block, the harness's own build, the orphan banner, the vivarium, the dev
   * environment and the rule book. Almost all of it is fixed for the life of the
   * process, which is why nothing routine invalidates it.
   */
  const harnessSection = (): Pick<
    CockpitState,
    'config' | 'recovery' | 'build' | 'pets' | 'localRun' | 'localRunTargets' | 'planning' | 'dispatchRules'
  > => ({
    config: {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxConcurrentAgents: config.maxConcurrentAgents,
      // The watch tag, so the cockpit knows which label its toggle writes and how
      // to render an item's effective watched state. One tag: an item without it is
      // unwatched, and there is no third reading to draw.
      watchLabel,
      // The profiles a goal or a part may be pinned to, cheapest first — the
      // options every dropdown draws, and the order it draws them in. Empty for a
      // deployment with no `agentModels`, which is what turns the control off:
      // there is nothing to choose between.
      profiles: orderedProfiles(config.agentModels),
      // Which profile an unpinned dispatch falls back to, so a pin can be drawn
      // as the departure from it that it is. Null when nothing is configured.
      defaultProfile: config.agentModels?.default ?? null,
      // The checkout a desktop deep link opens on. Shipped rather than looked up:
      // `repoRoot` is otherwise only reachable through the running-config route,
      // which is a settings page the plan sheet does not read.
      desktopFolder: config.repoRoot,
      // The fact rather than the text: the instruction is prose only the session
      // needs, and the cockpit's question is whether it can offer a start at all.
      localRunConfigured: config.localRun.instruction.trim() !== '',
      localRunStopConfigured: config.localRun.stopInstruction.trim() !== '',
      // The container policy itself, because the backlog draws a container as a
      // heading over its children rather than as a row beside them — a question
      // about the item's type that no per-item verdict answers.
      containerTypes: [...config.issueContainerTypes],
      // Whether a finding can be filed as a ticket at all — there is nowhere to
      // file one under the `fake` provider. Shipped as a flag rather than left to
      // the cockpit to infer from the provider name, so the one place that
      // decides is the one the route asks.
      canFileTickets: trackerCoordinates(config) !== null,
      stateColours: { ...config.issueStateColours },
      boardStates: [...config.issueBoardStates],
      // Asked of the connector, never inferred from the provider name: the one place
      // that decides is the one the route asks. `setWorkItemState` throws when
      // nothing implements it, so there is no other way to *offer* the operation.
      canSetWorkItemState: connector.canSetWorkItemState(),
      // The same question one act further on, and asked the same way: whether this
      // deployment's tracker can be closed from here at all.
      canCloseIssue: connector.canCloseIssue(),
      // The flag and the provider's hierarchy, folded by the one predicate the
      // route refuses on — so the tab and the route can never disagree about
      // whether this deployment has a board.
      featureBoard: featureBoardOn(config, connector),
      // The nodes an item can be filed under, capped by the same rule the appraiser's
      // offer is capped by — one list, so the operator and the agent are choosing
      // between the same things.
      areaPaths: placementCtx.areaTree === null ? [] : truncateAreaPaths(placementCtx.areaTree).paths,
      stateRules: workItemStateRules(config),
    },
    // Agents the previous run left orphaned, each awaiting restore / requeue /
    // remove. A non-empty list means the harness is running **no cycles**, which
    // is why the cockpit draws it as a blocking banner rather than one more
    // panel: the absence of activity everywhere else has exactly one cause, and
    // it is this.
    recovery: recovery.pending(),
    // Where the harness's own build stands, and how far along a deliberate upgrade
    // of it is. Served from the desk's last reading rather than taken here: a
    // snapshot is built on every cockpit poll and on every broadcast, and a git
    // round trip on that path would put the network in front of the whole UI.
    build: updates.reading(),
    // Null when the feature is off, so the cockpit draws nothing at all rather
    // than an empty enclosure that reads as a deployment nobody has used.
    pets: system.pets.state(),
    // The live run, or the last one that ended — the panel asks one question and
    // "nothing is up, the last attempt failed like this" is an answer to it. `live`
    // is derived here rather than in the cockpit so which statuses count is decided
    // once, by the thing that sets them.
    localRun: localRunView(system.localRun.current(), system.localRun.phase(), (ref, origin) =>
      localRunRefFacts(ref, planPartsOf(origin), {
        prByBranch: prByBranch(),
        tasks,
        defaultBranch: config.defaultBranch,
      }),
    ),
    // Where it could be pointed instead, and what has happened on each of those
    // branches. Drawn whether anything is up or not, which is why it is a key of its
    // own rather than something hanging off the run above.
    localRunTargets: localRunTargetViews({
      issues: world.issues,
      partsOf: planPartsOf,
      prByBranch: prByBranch(),
      openPrs: openPullRequests(),
      tasks,
      defaultBranch: config.defaultBranch,
    }),
    // The funnel's policy as the harness is running it: approving a decomposition
    // is agreeing to a rate as well as a shape, and the sheet states that rate on
    // the button that performs the approval.
    planning: config.planning,
    // The rule book, as data: decision rows carry a rule id; the cockpit looks
    // the id up here to expand a decision into "which rule fired, and why".
    dispatchRules: DISPATCH_RULES,
  });

  /**
   * The live dispatch controls, and nothing else.
   *
   * Its own section because it is the one an operator changes by hand and the one
   * the cockpit never has to fetch: `control:changed` carries `cap` and `paused`
   * whole, so the frame *is* the delivery and the browser applies it without a
   * request. The section exists for the first load and for a client that missed a
   * frame.
   */
  const controlSection = (): Pick<CockpitState, 'control'> => ({
    // Live, mutable dispatch controls — the cockpit reads these (not the frozen
    // config block above) for the current cap and pause state.
    control,
  });

  /**
   * The world as the cockpit draws it — every goal with its five verdicts folded,
   * the chains, and where landed work has reached.
   *
   * **The expensive one.** `enrichIssue` runs the pickup, conclusion, delivery,
   * appraisal and validation verdicts per goal, and `prAttentionStatus` runs per
   * open pull request; on a 150-goal board that is around 75 ms of the snapshot's
   * ~125 ms build. It is also the section a fleet event never touches, which is the
   * whole reason sections exist.
   */
  const goalsSection = (): Pick<
    CockpitState,
    | 'worldObservedAt'
    | 'world'
    | 'retainedRuns'
    | 'stacks'
    | 'environmentReach'
    | 'environmentArrivals'
    | 'stackLandings'
  > => ({
    // When the world below was actually observed — null before the first cycle,
    // when there is no baseline and the lists are empty. Shipped because the
    // reading is a pulse old rather than live (see this function's contract), the
    // same reason `world_read` hands an agent an `observedAt`.
    worldObservedAt: baseline?.takenAt ?? null,
    // Fold each PR's signals into a health verdict, and each issue's gates into
    // a pickup verdict, so the cockpit can show *why* an item is stuck or
    // untouched rather than leaving it implied by the absence of activity.
    world: {
      ...world,
      // The full open-PR list is passed as stack context so an inherited CI
      // failure names the PR underneath — otherwise a stacked PR reads as
      // "CI failing" with no agent on it and no visible reason why.
      //
      // `attention` sits beside `health`, not inside it: health answers "can this
      // merge" and attention answers "whose turn is it", and the two have
      // different right answers for the same PR (see `src/prAttention.ts`).
      pullRequests: openPullRequests(),
      // `conclusion` sits beside `pickup` and does not feed it — the same
      // relationship `attention` has to `health` above. Pickup answers "would an
      // agent start on this next cycle", which the work-item state already
      // decides; conclusion answers "has anyone said this is finished", which is
      // what rule `work-item-back-to-pickup` reads and what the operator toggles. Folding the second into
      // the first would make a `done` verdict silently veto an item the operator
      // had deliberately moved back to a pickup state.
      issues: world.issues.map(enrichIssue),
    },
    // Runs whose issue the tracker no longer returns (issues #203, #234) — closed
    // by hand, or the watch tag removed. Rebuilt from the run's own snapshot by
    // the *same* `retainedRunIssues` the dispatcher unions into its issue list, so
    // the card the operator sees and the subject the harness acts on are one
    // thing; and enriched through the same path as a live issue, so the two cannot
    // disagree about what a goal's records say. Dismissed and still-present runs
    // are not here: the former is over, the latter already rides the world list
    // above (with its `run` field).
    retainedRuns: retainedRunIssues(issueRuns, world.issues).map(enrichIssue),
    // Chains of stacked pull requests, derived from the world rather than stored:
    // a plan *adopts* a stack, so a chain a human opened by hand is drawn on the
    // same terms as one a plan produced. The unfiltered open list, for the reason
    // `inheritedCiFailure` takes it — an -ignore'd rung would hole the chain.
    stacks,
    // Where each goal's landed work has got to. Built from the store and not the
    // world, deliberately: a goal whose ticket closed weeks ago is still travelling
    // to production, and it is exactly then that somebody asks. Empty with no
    // environment configured, which the cockpit draws as no row rather than as a
    // row of unknowns.
    environmentReach: buildEnvironmentReach(store, config.environments),
    // Off the same table the comments are posted from, capped like every other
    // feed here. Empty with nothing configured, so the cockpit's signals list is
    // untouched on a deployment that never set an environment up.
    environmentArrivals: config.environments.length === 0 ? [] : store.listGoalArrivals().slice(0, 50),
    // The "land the stack" control, one entry per chain above: whether the click
    // may be offered, and the operator's standing intent over it. Joined to a
    // stack by rung membership rather than by ref — see `landingFor`, which needs
    // the open set to tell one path of a fork from its sibling.
    stackLandings: [
      ...stacks.map((stack) => {
        const rungPrs = stack.rungs.flatMap((rung) => {
          const pr = world.pullRequests.find((p) => p.number === rung.prNumber);
          return pr ? [pr] : [];
        });
        const landing = landingFor(
          stack.rungs.map((r) => r.prNumber),
          landings,
          openPrNumbers,
        );
        return {
          ref: stack.ref,
          ...landingReadiness(rungPrs),
          landing,
          // Counted against the durable record as well as the window, or "landing 1
          // of 3" counts back down to 0 of 3 as merged rungs age out of it.
          landed: landing ? landedCount(landing, { ...world, merged: mergedPrs }) : 0,
        };
      }),
      // And the intents no chain above accounts for. A chain of one is not a
      // stack, so a two-rung intent whose bottom rung has merged has no stack
      // left to hang off — and mapped over `stacks` alone the standing intent
      // over the survivor is invisible, taking the "stop" control with it at
      // exactly the moment an operator wants it. The row says what is standing;
      // `offer` is false because there is no chain left to land.
      // → `docs/spec/07-pull-requests.md#landing-a-stack`
      ...landings
        .filter(
          (l) => l.status === 'standing' && !stacks.some((s) => s.rungs.some((r) => l.rungs.includes(r.prNumber))),
        )
        .map((landing) => ({
          ref: landing.ref,
          offer: false,
          blockedBy: null,
          landing,
          landed: landedCount(landing, { ...world, merged: mergedPrs }),
        })),
    ],
  });

  /**
   * The plan graph and the validation plan hanging off it.
   */
  const plansSection = (): Pick<CockpitState, 'plans' | 'planParts' | 'validationChecks' | 'validationResources'> => ({
    // The plan graph, which until now existed only in the database: the per-issue
    // chip could say "2/5 parts merged" and nothing could say *which* five. The
    // cockpit joins parts to `upcoming` by origin to draw the dispatch cut.
    plans: wirePlans,
    planParts: wirePlanParts,
    // The validation plan beside the plan graph it hangs off — the checks whole,
    // superseded ones included, because "this check was withdrawn" is a thing the
    // sheet has to be able to say.
    validationChecks,
    validationResources: wireValidationResources,
  });

  /**
   * The agents, what they were dispatched to do, and what that has cost.
   *
   * The section almost every live signal invalidates — an agent's usage report, its
   * progress note, a status flip, a file it wrote. `tasks` and `agents` were the
   * bulk of what was left on the wire after the files list came off, and they were
   * the last two collections here with no cap on them: all-time reads over tables
   * nothing deletes from, rebuilt and re-serialised on every one of those signals.
   * They are bounded now — see {@link fleetHistory}, and
   * [16](../../docs/spec/16-http-api.md#bulk-collections) for why the answer was a
   * bound rather than a tenth section.
   */
  const fleetSection = (): Pick<
    CockpitState,
    | 'tasks'
    | 'agents'
    | 'endedAgents'
    | 'parkedOnLimit'
    | 'stallParks'
    | 'flags'
    | 'artifactUrls'
    | 'attachments'
    | 'attachmentUrls'
    | 'overlaps'
    | 'usage'
    | 'runOutcomes'
  > => ({
    // Every live agent, the tail of ended ones, and the tasks those were
    // dispatched on. `ended` is the whole count either way, so the console's
    // "N shifts ended" says how many there have been rather than how many
    // travelled — a header that counted the tail would report 200 forever on a
    // deployment that had run twenty thousand.
    tasks: history().tasks,
    agents: history().agents,
    endedAgents: history().ended,
    // Which of those rows are parked on a spent account limit rather than on a
    // question. Asked of the fleet, not derived from the rows: both parks are
    // `waiting` with a reason, and a cockpit that told them apart by reading the
    // sentence would be one wording change away from offering the wrong control.
    parkedOnLimit: fleet.limitedAgentIds(),
    // And which are parked on an unannounced stop, with the moment each settles
    // itself as done. Asked of the fleet for `parkedOnLimit`'s reason — three parks
    // wear one status, and only the fleet knows which is which.
    stallParks: fleet.stallDeadlines(),
    // Artifacts agents surfaced mid-run (design docs, reports, links). The
    // cockpit groups these by agentId onto the fleet card / drawer.
    flags,
    // The URL to open each local artifact by navigation, carrying its per-flag
    // capability (auth on) or a bare path (auth off). The cockpit opens chips
    // from this map rather than string-building a URL, the same way it looks refs
    // up in refUrls — an http(s) flag is absent here and linked directly.
    artifactUrls: artifactUrls(flags, opts?.artifactSigner),
    // The images an operator attached to a brief (issue #249), every ref in
    // one list. The cockpit filters it by `targetRef` — `job:<id>` under a queued
    // brief, `issue:<n>` under the ticket that brief became — which is the
    // whole visible half of the re-key: the operator watches the screenshot move
    // from the queue onto the goal rather than disappearing at the fork.
    attachments,
    // The URL to fetch each attachment's bytes from, with its capability. Built
    // the same way `artifactUrls` is and for the same reason: an `<img src>` the
    // browser loads on its own carries no bearer token.
    attachmentUrls: attachmentUrls(attachments, opts?.attachmentSigner),
    // Paths two agents wrote while both were running (issue #113). The three
    // dispatch gates are complete for what they see, and origin/branch are 1:1
    // for every world-driven rule — but none of them can see what an agent does
    // once it is running. This is that blind spot, read off rows we already have
    // rather than off an advisory claim an agent has to remember to make.
    overlaps: overlaps(),
    usage: buildUsage(system, spend().unattributedCostUsd),
    // The Yield gauge's reading, from the same `agents` rows the fleet list ships
    // and the same fold `/api/reliability` opens with.
    runOutcomes: tallyRunOutcomes(agents),
  });

  /**
   * What the fleet knows about working this repository, and what saying it costs.
   */
  const knowledgeSection = (): Pick<
    CockpitState,
    'knowledge' | 'knowledgeGraduations' | 'knowledgeSimilarities' | 'knowledgeDelivery' | 'knowledgeCost'
  > => ({
    // Every fact, the rejected ones included: the page is the governance, and a
    // surface drawing only what it let through cannot show that a claim was
    // killed. Nothing in the dispatcher reads one — a fact feeds prompts (phase 3)
    // and this panel, and that is the whole of it.
    knowledge: facts.map((fact) => {
      // Whether the check this claim is scoped to still runs (issue #27 phase 7).
      // Taken here rather than in the browser for the ratio's reason: it is a
      // comparison against a configured window, made beside the dispatches and the
      // world it reads, and a "days since" computed from `Date.now()` in the view
      // layer would be a second implementation of the verdict.
      const drift = checkScopeDrift(fact, sightings, { now: readAt, staleDays: config.knowledgeScopeStaleDays });
      const counts = factCounts.get(fact.id);
      return {
        ...fact,
        corroborations: 0,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 0,
        lastAskedAt: null,
        ...counts,
        scopeStale: drift?.stale ?? false,
        scopeLastMatchedAt: drift?.lastMatchedAt ?? null,
        // Derived here rather than recorded, and taken beside the counts it reads
        // for `scopeStale`'s reason: an age against a configured window computed in
        // the browser would be a second implementation of the verdict the fold's
        // own count is taken from.
        cold: isCold(
          fact,
          { corroborations: counts?.corroborations ?? 0, asks: counts?.asks ?? 0 },
          {
            now: readAt,
            coldDays: config.knowledgeColdDays,
          },
        ),
      };
    }),
    // Every attempt to put one in the repository, the abandoned ones included:
    // committing is one act with two ends, and the operator deciding whether to try
    // again needs to see the try that did not land. `reading` is the sweep's own
    // verdict over the work graph, taken here rather than in the browser for the
    // reason every other count on this row is.
    knowledgeGraduations: graduations,
    // Which proposals a machine thinks are one claim. A suggestion table read
    // straight out — nothing here has joined, promoted or barred anything, and the
    // page draws a cluster whose merge is the operator's click.
    knowledgeSimilarities: store.listSimilarities(),
    // What that list actually sends, from the renderers that send it.
    knowledgeDelivery: delivery(),
    // What sending it costs, over the window Insights opens on. The block's length
    // is the renderer's own answer above rather than a second rendering: a cost
    // drawn from a block that did not ship is a cost for nothing.
    knowledgeCost: knowledgeBlockCost(agents, delivery().block.length, defaultWindow(readAt)),
  });

  /**
   * What is waiting to be dispatched, and the recurrences behind some of it.
   */
  const queueSection = (): Pick<CockpitState, 'jobs' | 'schedules' | 'upcoming' | 'runway'> => ({
    // Operator-launched jobs (newest first) — the cockpit shows the queued
    // ones and their place in line, plus recently-dispatched/cancelled history.
    jobs: store.listJobs(),
    // The recurrences behind some of them: what to queue and when, oldest first.
    // Shipped whole rather than as "the ones due soon", because the panel's job is
    // to let an operator see a standing intention they wrote weeks ago — including
    // a disabled one, which is invisible everywhere else in the harness.
    schedules: store.listJobSchedules(),
    // The "Up next" queue: the last cycle's ordered pickup plan with the
    // headroom cut (issue #69). A per-pulse projection — null until a cycle
    // has run, or when the active dispatcher doesn't materialise a plan.
    upcoming: harness.upcoming,
    // The band under Fleet. Taken here rather than cached off the pulse's own
    // desk because a snapshot is served far more often than a cycle runs, and a
    // reading a pulse old would show a queue the operator has just topped up as
    // still empty — on exactly the surface they topped it up from. The same
    // function the desk calls, over this route's own pickup context, so what the
    // band says and what the bench row says cannot disagree about the gate.
    //
    // `standing` is read off the bench rather than assumed: the hysteresis band
    // the card draws has to be the one the desk is actually applying, or the card
    // reports `healthy` for a queue whose notice is still standing. Off the
    // *unbounded* read, never the panel's capped feed: `listHumanTasks` is
    // newest-first with a hundred-row cap, so a hundred rows filed behind a
    // standing `supply` row push it out of the window and the band silently
    // starts applying `warnHours` where the desk is applying `clearHours`.
    runway: readRunway({
      policy: config.runway,
      issues: world.issues,
      pickup: pickupCtx,
      runs: issueRuns,
      // Every row, not the panel's capped feed above: the debt clause is a
      // count, and a hundred-row cap would report "100" to the deployment
      // furthest behind and to the one exactly at the cap alike — and the
      // settled rows are the human holds the median lead time subtracts.
      humanTasks: allHumanTasks,
      // The projection, never `listEscalations`: that read is all-time and
      // carries every settled item's transcript tail, and this one is taken on
      // every cockpit refresh.
      escalations: store.listEscalationSpans(),
      cap: control.cap,
      standing: allHumanTasks.some((t) => t.kind === 'supply' && t.status === 'open'),
    }),
  });

  /**
   * Everything still waiting on a person.
   */
  const inboxSection = (): Pick<CockpitState, 'bugFilings' | 'humanTasks' | 'escalations' | 'proposals'> => ({
    // Bugs raised from a story row: `filing` while the desk agent writes one, `filed`
    // with a ref once it exists. Several per story is the normal case, not an error —
    // a story can be wrong in more than one way.
    bugFilings,
    // Open ones and a settled tail alike, exactly as `findings` ships: "we asked
    // and it was declined" is information, and a row that vanished on being
    // settled would take the operator's own note with it.
    humanTasks,
    // **Open ones only.** Every cockpit surface that reads this filters to
    // `status === 'open'` — the needs-you queue, the console band, the view
    // model — and nothing draws a settled one, while each carries a transcript
    // tail in `context.recentOutput`. Shipping the all-time list was half a
    // megabyte per refresh spent on rows that were filtered straight back out.
    escalations: store.listOpenEscalations(),
    // Acts a human was asked to authorize (issue #109). The cockpit joins these
    // to their escalation so a decision-bearing item gets accept/reject rather
    // than a text box, and the decision log reads the settled ones as the human
    // half of the audit trail.
    proposals,
  });

  /**
   * What has happened: the world's own changes, the harness's decisions, and its
   * recorded failures. Three capped feeds.
   */
  const activitySection = (): Pick<CockpitState, 'decisions' | 'worldEvents' | 'errors'> => ({
    decisions: shiftLog,
    worldEvents,
    // Recorded failures (cycle exceptions, provider outages, agent crashes,
    // route 500s) for the cockpit's Errors panel.
    errors: store.listErrors(100),
  });

  // Assembled section by section, so a caller that asked for one pays for one. A
  // full build asks for them all and is the same object it always was —
  // `test/stateSections.test.ts` holds the partition against `CockpitState`, so a
  // key added to the wire and to no section is caught rather than silently
  // dropped from every snapshot.
  const out: Partial<CockpitState> = {
    // **Always shipped, whatever was asked for.** Every other section names things
    // the cockpit draws as links, and this is the map it resolves them in — a
    // patch that carried new rows and no way to reach them would be the dead end
    // `<Ref/>` exists to prevent, arriving one section at a time. It is merged
    // rather than replaced on the client, so a ref learned in one patch survives
    // the next: a ref's URL is stable, so an entry can only go stale by being
    // absent.
    refUrls,
  };
  if (want.has('harness')) Object.assign(out, harnessSection());
  if (want.has('control')) Object.assign(out, controlSection());
  if (want.has('goals')) Object.assign(out, goalsSection());
  if (want.has('plans')) Object.assign(out, plansSection());
  if (want.has('fleet')) Object.assign(out, fleetSection());
  if (want.has('knowledge')) Object.assign(out, knowledgeSection());
  if (want.has('queue')) Object.assign(out, queueSection());
  if (want.has('inbox')) Object.assign(out, inboxSection());
  if (want.has('activity')) Object.assign(out, activitySection());
  return out;
}

/** Build the `flag id → artifact URL` map the cockpit opens chips from. */
function artifactUrls(
  flags: { id: string; ref: string }[],
  signer?: (flagId: string) => string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const flag of flags) {
    // http(s) refs are linked directly by the cockpit and never served here.
    if (/^https?:\/\//i.test(flag.ref)) continue;
    const base = `/artifacts/${encodeURIComponent(flag.id)}`;
    // A signer is present exactly when auth is on. Off, the route needs no
    // capability, so the bare path is the whole URL.
    map[flag.id] = signer ? `${base}?tk=${encodeURIComponent(signer(flag.id))}` : base;
  }
  return map;
}

/**
 * Build the `attachment id → URL` map the cockpit points its thumbnails at.
 *
 * Unlike `artifactUrls` nothing is skipped: every attachment is a local file this
 * harness wrote, so every one of them is served here.
 */
function attachmentUrls(attachments: { id: string }[], signer?: (id: string) => string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attachment of attachments) {
    const base = `/attachments/${encodeURIComponent(attachment.id)}`;
    // A signer is present exactly when auth is on. Off, the route verifies
    // nothing, so the bare path is the whole URL.
    map[attachment.id] = signer ? `${base}?tk=${encodeURIComponent(signer(attachment.id))}` : base;
  }
  return map;
}

/**
 * A delivery verdict, shipped **only while it still stands**.
 *
 * The row is not the reading. `deliveryHold` is what rule `issue-pickup` gates on, and it
 * answers null for a verdict the world has overtaken — the operator moved the
 * ticket back into a pickup state, or a transition landed after `decidedAt`. So
 * the standing-ness is asked here, off the same predicate and the same context
 * `issuePickupStatus` is handed, rather than shipping the row and leaving the
 * cockpit to re-derive an answer from inputs it does not have. A released verdict
 * going null is the point: the issue is back in play and rule `issue-assess` will assess it
 * again, so a cockpit still reporting it delivered would be promising a park that
 * has ended.
 *
 * The hold *reason* is deliberately not shipped. It is prose already carried by
 * `pickup.reasons` in every case that surface can report, and a second copy is a
 * second answer to the one question. What this adds is the structural fact —
 * that there is a standing verdict at all — which is exactly what neither
 * `conclusion` nor `pickup.status` can say for a decomposed issue.
 */
function standingDelivery(delivery: IssueDelivery | undefined, issue: Issue, ctx: IssuePickupContext) {
  if (!delivery) return null;
  const held = deliveryHold(delivery, issue, { pickupStates: ctx.policy.pickupStates, signals: ctx.deliverySignals });
  if (!held) return null;
  const { summary, by, decidedAt } = delivery;
  return { summary, by, decidedAt };
}

/**
 * What the Goal Floor's Manifest station needs to draw itself: whether a goal was
 * written up, the one line to show, and when. Deliberately not the document — see
 * the call site.
 */
function retroReading(retro: Retrospective | null) {
  return retro ? { summary: retro.summary, hasDocument: retro.document.length > 0, updatedAt: retro.updatedAt } : null;
}

/**
 * The same shape for the shared pad, and the same rule: the count and the age,
 * never the trail. A pad nobody has written to is **null rather than a zero**,
 * because the control it draws is keyed on the pad existing — the lesson the plan
 * and the retrospective both learned about hanging a way in off a status.
 */
function padReading(pad: ScratchPadSummary | undefined) {
  return pad && pad.entries > 0 ? { entries: pad.entries, updatedAt: pad.updatedAt } : null;
}

/**
 * The reviewable half of a stored appraisal, or null when nobody has judged the goal.
 *
 * Null and `workable` are not the same reading and neither is `unclear`, which is
 * the whole point of the field: a goal nothing has appraised draws no drill at all,
 * while a refused one draws a drill that is stopped and says why. Collapsing the
 * two would put #158's verdict back where it was — legible only as prose inside
 * `pickup.reasons`.
 *
 * `commentRef` is the one thing here the appraisal says to somebody *else*: the
 * standing comment the desk keeps on the ticket, as a canonical ref (#171). It is
 * the sharper half of that issue — the harness explaining on another person's
 * ticket why it will not act — and until now the operator could only find it by
 * opening the tracker and reading the thread. `goalRef` is still deliberately not
 * shipped: it is a fingerprint the hold is measured against, not a reading.
 */
function appraisalVerdictOf(appraisal: IssueAppraisal | undefined, issue: Issue, placement: PlacementContext) {
  if (!appraisal) return null;
  const { verdict, summary, by, decidedAt, proposedProfile } = appraisal;
  return {
    verdict,
    summary,
    by,
    decidedAt,
    commentRef: issueCommentRef(appraisal.originRef, appraisal.commentRef),
    proposedProfile,
    // Both fields, because the gate is exactly their conjunction: a proposal that
    // was settled on arrival (the appraiser agreed) is still worth showing, and it
    // is holding nothing.
    awaitingProfileAnswer: proposedProfile !== null && appraisal.profileAnsweredAt === null,
    // The placement questions still open on this goal — derived here, every time,
    // against the **live** work item. Nothing about them is stored except the
    // operator's "does not apply", which is what makes setting the field by hand
    // in the tracker end the question with no write anywhere.
    //
    // Gated on the sink being able to make the write at all, because a proposal
    // nobody can act on is the cockpit's dead-end bug in its purest form: three
    // buttons, all of which 400. In practice the gate never bites — only a
    // provider that tracks hierarchy can report an orphan in the first place — and
    // it is here so that stays true by construction rather than by coincidence.
    placement: placement.canPlace ? placementAsks(appraisal, issue, placement.areaTree, appraisal.goalRef) : [],
    // Carried whole, and deliberately *not* gated on `canPlace` the way the asks
    // above are: this is a stamp of something the operator did, not a question
    // being put to them, and a deployment that has since lost the ability to
    // write a placement has not un-answered it.
    parentSettledAt: appraisal.parentSettledAt,
  };
}

/**
 * What the placement questions are judged against: the project's area tree, and
 * whether anything can write a placement.
 *
 * Resolved once per snapshot rather than per issue — both halves are facts about
 * the deployment, and asking the connector per issue would put a capability probe
 * in a loop over the whole board.
 */
interface PlacementContext {
  areaTree: AreaPathTree | null;
  canPlace: boolean;
}

/**
 * Account-level Claude usage for the cockpit chip (issue #60): the rolling cost
 * windows summed from stream-mode turn reports (all modes, self-computed), plus
 * the real subscriber 5h/weekly limits when the PTY status-line capture has
 * seen any (Pro/Max only — null otherwise, and the UI degrades to cost).
 *
 * `unattributedCostUsd` is the other half of the per-goal figures on each issue:
 * the spend that reached no goal at all. It is shipped rather than kept server-side
 * because it is what makes the per-issue totals readable as a partition of the
 * fleet's spend instead of an unbounded subset of it.
 */
function buildUsage(system: System, unattributedCostUsd: number) {
  const now = Date.now();
  const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
  return {
    windows: {
      fiveHourCostUsd: system.store.sumUsageCostSince(iso(5 * 60 * 60 * 1000)),
      sevenDayCostUsd: system.store.sumUsageCostSince(iso(7 * 24 * 60 * 60 * 1000)),
    },
    rateLimits: system.rateLimits?.readLatest() ?? null,
    unattributedCostUsd,
  };
}

/**
 * Every goal anything is known about, and where each has got to.
 *
 * The goal set comes from the **landings and the work graph**, never from the
 * world: a goal is at its most interesting to this panel once its ticket has
 * closed, which is precisely when the world stops listing it. It is also why a
 * goal with only unattributable merges appears here at all — it has an answer,
 * and the answer is that nobody can say.
 *
 * Empty when nothing is configured, so the cockpit draws no row rather than a row
 * of unknowns on a deployment that never asked for one.
 */
function buildEnvironmentReach(store: System['store'], environments: EnvironmentConfig[]): GoalReachView[] {
  if (environments.length === 0) return [];
  const arrivals = store.listGoalArrivals();
  const releases = store.listEnvironmentGateReleases();
  const released = new Map(releases.map((r) => [r.goalRef, r]));
  // A hold is only a hold on a goal that is *delivered*: everything else is
  // simply work in progress, and a sentence saying its close-out is waiting on
  // testUk would be the harness announcing a queue it is not in yet.
  const delivered = new Set(store.listDeliveries().map((d) => d.originRef));
  const shortfalls = new Set(store.listShortfalls().map((sf) => sf.originRef));
  // Resolved before the fold, because it is also what widens the fold's goal set.
  // A goal delivered with nothing merged has landed nothing to be folded, so
  // without this it ships no row — and the hold sentence, the release control and
  // the "not waiting on an environment" line all live inside the card an empty
  // list stops drawing. Those are exactly the goals the escape hatch was written
  // for, so it was absent precisely where it was needed. A released goal is kept
  // for the same reason: the row is where its note is drawn, and a release that
  // erased its own account would be the lift with nothing left saying it happened.
  const holds = new Map<string, string>();
  const gated = new Set<string>();
  for (const goalRef of delivered) {
    if (shortfalls.has(goalRef)) continue;
    const hold = environmentGateHold({ goalRef, environments, arrivals, releases });
    if (hold !== null) holds.set(goalRef, hold);
    if (hold !== null || released.has(goalRef)) gated.add(goalRef);
  }
  return allGoalReach({
    held: gated,
    landings: store.listGoalLandings(),
    readings: store.listEnvironmentReach(),
    nodes: store.listWorkNodes(),
    landed: store.landedPrs(),
    // The denominator is the goal's *work*: a plan's parts that have yet to merge
    // are counted alongside its landings, so the first of four parts arriving is
    // not the goal arriving.
    plans: store.listPlans(),
    parts: store.listAllPlanParts(),
    environments,
  }).map((goal) => ({
    ...goal,
    gateHold: holds.get(goal.goalRef) ?? null,
    released: released.get(goal.goalRef) ?? null,
  }));
}

/**
 * The run as the cockpit reads it, or null when nothing has ever been started.
 *
 * `live` and `phase` are the two things added, and adding them here is the point:
 * which statuses count as a running environment, and which of a session's lines
 * counts as a stage, are each one rule — and they belong beside the writer that
 * sets them rather than in a component deciding whether to draw a Stop button.
 *
 * The phase comes from the runner rather than the row because it is not durable and
 * should not be: it describes work in flight, and the process that was doing the
 * work is the only thing that can vouch for it. A restart correctly has none.
 */
function localRunView(
  run: LocalRun | null,
  phase: string | null,
  facts: (ref: string, origin: string) => LocalRunRefFacts,
): LocalRunView | null {
  if (run === null) return null;
  return { ...run, live: localRunIsLive(run), phase, refFacts: facts(run.ref, run.originRef) };
}

/**
 * What has happened on **one branch**: the part it belongs to, and the pull request
 * that is on it.
 *
 * The lookup is by branch, and that is the whole discipline. A goal can have three
 * pull requests, none of which describes the ref about to be checked out — and the
 * tempting fold, "show the goal's PR", is how a panel comes to report a passing
 * build for a branch nothing has built. A ref with no pull request of its own says
 * so, beside the count of what *did* land in the integration branch.
 */
function localRunRefFacts(
  ref: string,
  parts: readonly PlanPart[],
  ctx: { prByBranch: Map<string, PullRequest>; tasks: readonly TaskSummary[]; defaultBranch: string },
): LocalRunRefFacts {
  const part = parts.find((p) => p.branch === ref) ?? null;
  const pr = ctx.prByBranch.get(ref) ?? null;
  const onBranch = ctx.tasks.filter((t) => t.branch === ref);
  return {
    ref,
    isDefaultBranch: ref === ctx.defaultBranch,
    part:
      part === null
        ? null
        : { slug: part.slug, title: part.title, seq: part.seq, total: parts.length, status: part.status },
    pr:
      pr === null
        ? null
        : {
            number: pr.number,
            state: prState(pr),
            ciStatus: pr.ciStatus,
            // The CI policy's own classification of what is failing, read off the
            // verdict this snapshot already folded. A closed row carries none, which
            // reads as no detail rather than as a clean bill of health — the
            // aggregate `ciStatus` still speaks.
            failing: [...(pr.ciVerdict?.dispatch ?? []), ...(pr.ciVerdict?.escalate ?? [])].map((c) => c.name),
            approved: pr.approved === true,
            unresolved: pr.unresolvedComments.length,
          },
    mergedParts: parts.filter((p) => p.status === 'merged').length,
    // The same rule the dispatcher, the executor and the branch reap read, rather
    // than a fourth opinion about which statuses are live.
    agentOnIt: onBranch.some((t) => isActiveTask(t)),
    lastActivityAt: onBranch.reduce<string | null>(
      (newest, t) => (newest === null || t.updatedAt > newest ? t.updatedAt : newest),
      null,
    ),
  };
}

/**
 * Where the local run could be pointed, one entry per goal.
 *
 * The ref comes from `localRunChoices` — the same function the runner starts from
 * and guards an override with — so what the panel offers, what a start runs, and
 * what a start will accept are one decision. A cockpit that worked out the tip of a
 * stack for itself would be free to draw a branch nobody would get.
 */
function localRunTargetViews(ctx: {
  issues: readonly Issue[];
  partsOf: (origin: string) => PlanPart[];
  prByBranch: Map<string, PullRequest>;
  openPrs: PullRequest[];
  tasks: readonly TaskSummary[];
  defaultBranch: string;
}): LocalRunTargetView[] {
  return ctx.issues.map((issue) => {
    const origin = issueConclusionOrigin(issue.number);
    const parts = ctx.partsOf(origin);
    // The goal's own branch as well as its parts', through the same
    // `openPrForIssue` the pickup verdict uses — and the same call the runner makes,
    // so what the panel offers is what a start will accept.
    const choices = localRunChoices(parts, openPrForIssue(issue, ctx.openPrs)?.branch ?? null);
    const facts = (ref: string): LocalRunRefFacts => localRunRefFacts(ref, parts, ctx);
    return {
      originRef: origin,
      issueNumber: issue.number,
      target: facts(choices.target ?? ctx.defaultBranch),
      options: choices.options.map((option) => ({ option, facts: facts(option.ref) })),
      // A goal with no branch of its own resolves to the integration branch, which
      // is where every other such goal resolves too — so it is not a *choice*, and
      // the panel's default filter leaves it out rather than drawing the same one
      // answer forty times.
      runnable: choices.target !== null,
    };
  });
}

/**
 * The state words the work-item rules act on, or null where they are all switched off.
 *
 * Pure and beside the snapshot rather than inline, so the one thing worth getting
 * right is readable: `pickup` is the **effective** set the dispatcher gates on, which
 * folds `issueInProgressState` in. Built from the raw key it would tell the board
 * that dropping onto the in-progress state stops the fleet, which is the opposite of
 * true — and the board's headers are the surface that says so out loud.
 *
 * `returnsTo` is the first *configured* pickup state rather than the first of the
 * effective list, because that is how `workItemBackToPickup` reads it: the fold
 * appends, so on a config listing nothing but an in-progress state the two differ.
 */
function workItemStateRules(config: Config): CockpitState['config']['stateRules'] {
  const pickup = effectivePickupStates({
    pickupStates: config.issuePickupStates,
    inProgressState: config.issueInProgressState,
  });
  if (pickup === undefined || pickup.length === 0) return null;
  return {
    pickup,
    inProgress: config.issueInProgressState ?? null,
    inReview: config.issueInReviewState ?? null,
    returnsTo: config.issuePickupStates?.[0] ?? null,
  };
}

/**
 * What the knowledge base actually delivers, projected from the renderers that
 * deliver it.
 *
 * **Never a second reading.** The block is `renderKnowledgeBlock`'s own output —
 * the string, the ids it carries, and the ids the cap left out — so the cockpit's
 * budget meter is measuring the block that will ship rather than a character count
 * of its own. A recomputation here would be free to disagree with the launch, and
 * nothing would be red when it did.
 *
 * The scoped half is one entry per `check:` or `goal:` scope holding anything
 * deliverable, rendered through the same function `recordDispatchTask` appends
 * with. Per scope rather than per dispatch because a dispatch matches its goal and
 * every check it answers at once, and the set of dispatches is not a list — an
 * agent on `pr:412:ci` with `test (windows)` red receives this page's `goal:pr:412`
 * entry and its `check:test (windows)` entry, in one pass through the renderer.
 */
function knowledgeDelivery(store: Store, limit: number): KnowledgeDeliveryView {
  const block = renderKnowledgeBlock(store.askFacts({ limit: KNOWLEDGE_READ_LIMIT }), limit);
  const byScope = new Map<string, KnowledgeFact[]>();
  for (const fact of store.askFacts({ limit: KNOWLEDGE_READ_LIMIT })) {
    // What rides the block is out of the scoped half, through the renderers' own
    // predicate rather than a scope test of this page's — a fact counted in both
    // halves here would tell an operator a claim is sent twice when it is sent
    // once, which is the drift this whole surface exists to make visible.
    if (fact.scope === 'fleet' || ridesSystemPrompt(fact)) continue;
    byScope.set(fact.scope, [...(byScope.get(fact.scope) ?? []), fact]);
  }
  return {
    block: block.text,
    limit,
    rendered: block.rendered.map((f) => f.id),
    dropped: block.dropped.map((f) => f.id),
    scoped: [...byScope]
      // Alphabetical, so the list an operator reads twice is the same list twice —
      // insertion order here is the store's recency, which moves under them.
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([scope, facts]) => ({ scope, text: renderScopedKnowledgeNote(facts), facts: facts.map((f) => f.id) })),
  };
}
