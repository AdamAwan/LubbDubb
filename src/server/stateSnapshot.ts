import type { System } from '../system.js';
import type {
  Issue,
  IssueAssay,
  IssueDelivery,
  PlanPart,
  Retrospective,
  ScratchPadSummary,
  WorldSnapshot,
} from '../types.js';
import type { CockpitState } from '../wire.js';
import { buildRefUrls, decisionSubjectRef, issueCommentRef } from './refUrls.js';
import { buildStacks } from '../stacks/stack.js';
import { landedCount, landingFor, landingReadiness } from '../stacks/landing.js';
import { prHealth } from '../prHealth.js';
import { prAttentionStatus, type PrAttentionContext } from '../prAttention.js';
import { issuePickupStatus, type IssuePickupContext } from '../dispatcher/issuePickup.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import { retainedRunIssues } from '../floor/runs.js';
import { DEFAULT_COOLDOWN } from '../dispatcher/dispatchCooldown.js';
import { DISPATCH_RULES } from '../dispatcher/rules.js';
import { trackerCoordinates } from '../mcp/findings.js';
import { rejectionSignalQuery } from '../proposals/proposals.js';
import { detectFileOverlaps } from '../fileOverlap.js';
import { deliveryHold, deliverySignalQuery } from '../delivery/delivery.js';
import { assaySignalQuery } from '../intake/assay.js';
import { classifyCiFailures } from '../ci/ciPolicy.js';
import { watchLabelsFor } from '../watchLabels.js';

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
export function buildStateSnapshot(
  system: System,
  opts?: { artifactSigner?: (flagId: string) => string; attachmentSigner?: (attachmentId: string) => string },
): CockpitState {
  const { store, connector, config, runtimeControl, harness, recovery } = system;
  const { watchLabel, ignoreLabel } = watchLabelsFor(config.labelPrefix);
  const baseline = store.getWorldBaseline();
  const world: WorldSnapshot = baseline ?? {
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
  };
  const tasks = store.listTasks();
  const control = runtimeControl.snapshot();
  // Hoisted (not inlined into the returned object) because the artifact-URL map
  // below is derived from the same list.
  const flags = store.listAllFlags();
  // Hoisted for the same reason: the URL map below is derived from the same rows.
  const attachments = store.listAllAttachments();
  // What agents noticed outside their own tasks. Read here (not only in the
  // panel) because their refs feed the link map below: a finding often names an
  // item that is *not* in the current world — a closed duplicate, say — so its
  // ref has to be resolved directly rather than looked up off the snapshot.
  const findings = store.listFindings();
  // Work only a person can do. Read here rather than only in the panel for
  // findings' reason: each row's `originRef` names the work it belongs to, and the
  // panel links it through the same ref map as everything else.
  const humanTasks = store.listHumanTasks();
  // Acts put to a human. Read here for the same reason as findings: a proposal's
  // ref (`pr:42:merge`) names the item its card links to, so it feeds the link
  // map below as well as the cards themselves.
  const proposals = store.listProposals();
  // Every file every agent wrote, read once: the drawer groups it by agent, and
  // the overlap detector below joins it *across* agents — the one question the
  // rows could always answer and nothing ever asked.
  const files = store.listAllFiles();
  // The plan graph, read once and shared by the per-issue pickup verdict below
  // and the snapshot itself, so the chip and the panel can't disagree.
  const plans = store.listPlans();
  const planParts = store.listAllPlanParts();
  const stacks = buildStacks(world.pullRequests, plans, planParts, config.defaultBranch);
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
  const assays = store.listAssays();
  const assayWindow = assaySignalQuery(assays);
  // Keyed the same way the conclusion and shortfall maps below are, so the
  // per-issue verdict beside them reads off one lookup.
  const assaysByOrigin = new Map(assays.map((a) => [a.originRef, a]));
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
    planning: config.planning,
    // The harness's own park, read the same way `Harness.runCycle` reads it — the
    // event query is null (and no read happens) until an issue has been assessed.
    deliveries,
    deliverySignals: deliveryWindow ? store.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs) : [],
    // The content gate in front of the funnel, read exactly as `Harness.runCycle`
    // reads it — including the policy, so the chip reports an issue *awaiting* an
    // assay rather than calling it eligible for a pickup that will not fire.
    assays,
    assaySignals: assayWindow ? store.listWorldEventsSince(assayWindow.since, assayWindow.refs) : [],
    assay: config.assay,
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
    // pickup context above takes it): an `-ignore`d base still attributes.
    openPrs: world.pullRequests,
    defaultBranch: config.defaultBranch,
    ignoreLabel,
    tasks,
    proposals,
    rejectionSignals: signals ? store.listWorldEventsSince(signals.since, signals.refs) : [],
    recentDecisions: pickupCtx.recentDecisions,
    cooldown: DEFAULT_COOLDOWN,
    // The same policy the dispatcher holds, so `attention` names the court rule `pr-ci-failing`
    // will act in rather than promising an agent for a check the policy holds.
    ci: config.ci,
    now: world.takenAt,
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
      ...findings.map((f) => f.ref),
      ...findings.map((f) => f.ticketRef),
      ...humanTasks.map((t) => t.originRef),
      ...proposals.map((p) => p.ref),
      // The comments the harness maintains on a ticket without being asked — the
      // plan's status comment and the assay's refusal (#171). Read off the values
      // actually shipped (and off the same `issueCommentRef` for the assay), so a
      // ref the cockpit holds is always the ref this map was keyed by. A provider
      // that resolves neither leaves them absent, and the cockpit draws nothing.
      ...wirePlans.map((p) => p.statusCommentRef),
      ...assays.map((a) => issueCommentRef(a.originRef, a.commentRef)),
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
      // tickets, but the factory's Goal Floor and the belt speak in the
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
  // The per-issue enrichment, hoisted so a live world issue and a retained
  // completion synthesized below go through one path — the reasons the pickup and
  // conclusion verdicts are computed here rather than in the browser apply to both,
  // and two enrichment paths would drift exactly on a finished goal.
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
      assay: assayVerdictOf(assaysByOrigin.get(origin)),
      // The run's own write-up (rule `issue-retro`) — the reading, never the writing.
      retrospective: retroReading(store.getRetrospective(origin)),
      // The shared pad the agents on this goal left each other — the reading, for
      // the retrospective's reason: the trail is fetched when a reader opens it.
      scratchpad: padReading(padsByOrigin.get(origin)),
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
    };
  };
  return {
    config: {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxConcurrentAgents: config.maxConcurrentAgents,
      // The watch/ignore tag pair, so the cockpit knows which labels its toggles
      // set and how to render an item's effective watched/ignored state.
      watchLabel,
      ignoreLabel,
      // Whether a finding can be filed as a ticket at all — there is nowhere to
      // file one under the `fake` provider. Shipped as a flag rather than left to
      // the cockpit to infer from the provider name, so the one place that
      // decides is the one the route asks.
      canFileTickets: trackerCoordinates(config) !== null,
    },
    // When the world below was actually observed — null before the first cycle,
    // when there is no baseline and the lists are empty. Shipped because the
    // reading is a pulse old rather than live (see this function's contract), the
    // same reason `world_read` hands an agent an `observedAt`.
    worldObservedAt: baseline?.takenAt ?? null,
    // Live, mutable dispatch controls — the cockpit reads these (not the frozen
    // config block above) for the current cap and pause state.
    control,
    // Agents the previous run left orphaned, each awaiting restore / requeue /
    // remove. A non-empty list means the harness is running **no cycles**, which
    // is why the cockpit draws it as a blocking banner rather than one more
    // panel: the absence of activity everywhere else has exactly one cause, and
    // it is this.
    recovery: recovery.pending(),
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
      pullRequests: world.pullRequests.map((pr) => ({
        ...pr,
        health: prHealth(pr, world.pullRequests),
        attention: prAttentionStatus(pr, attentionCtx),
        // The third verdict beside the other two, and it exists for the same
        // reason they are computed here rather than in the browser: the
        // alternative is shipping `config.ci` and re-matching client-side, which
        // means a second glob matcher and a second first-match-wins ordering
        // sitting nowhere near the rule they duplicate. That drift would fail
        // silently — the cockpit saying *repair* while the harness held. Same
        // call the dispatcher makes, off the same policy.
        ciVerdict: classifyCiFailures(pr.ciChecks, config.ci),
      })),
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
    // The plan graph, which until now existed only in the database: the per-issue
    // chip could say "2/5 parts merged" and nothing could say *which* five. The
    // cockpit joins parts to `upcoming` by origin to draw the dispatch cut.
    plans: wirePlans,
    planParts,
    // Chains of stacked pull requests, derived from the world rather than stored:
    // a plan *adopts* a stack, so a chain a human opened by hand is drawn on the
    // same terms as one a plan produced. The unfiltered open list, for the reason
    // `inheritedCiFailure` takes it — an -ignore'd rung would hole the chain.
    stacks,
    // The "land the stack" control, one entry per chain above: whether the click
    // may be offered, and the operator's standing intent over it. Joined to a
    // stack by rung membership rather than by ref — see `landingFor`.
    stackLandings: stacks.map((stack) => {
      const rungPrs = stack.rungs.flatMap((rung) => {
        const pr = world.pullRequests.find((p) => p.number === rung.prNumber);
        return pr ? [pr] : [];
      });
      const landing = landingFor(
        stack.rungs.map((r) => r.prNumber),
        landings,
      );
      return {
        ref: stack.ref,
        ...landingReadiness(rungPrs),
        landing,
        landed: landing ? landedCount(landing, world) : 0,
      };
    }),
    tasks,
    // Operator-launched jobs (newest first) — the cockpit shows the queued
    // ones and their place in line, plus recently-dispatched/cancelled history.
    jobs: store.listJobs(),
    agents: store.listAgents(),
    // Artifacts agents surfaced mid-run (design docs, reports, links). The
    // cockpit groups these by agentId onto the fleet card / drawer.
    flags,
    // The URL to open each local artifact by navigation, carrying its per-flag
    // capability (auth on) or a bare path (auth off). The cockpit opens chips
    // from this map rather than string-building a URL, the same way it looks refs
    // up in refUrls — an http(s) flag is absent here and linked directly.
    artifactUrls: artifactUrls(flags, opts?.artifactSigner),
    // The images an operator attached to a blueprint (issue #249), every ref in
    // one list. The cockpit filters it by `targetRef` — `job:<id>` under a queued
    // blueprint, `issue:<n>` under the ticket that blueprint became — which is the
    // whole visible half of the re-key: the operator watches the screenshot move
    // from the queue onto the goal rather than disappearing at the fork.
    attachments,
    // The URL to fetch each attachment's bytes from, with its capability. Built
    // the same way `artifactUrls` is and for the same reason: an `<img src>` the
    // browser loads on its own carries no bearer token.
    attachmentUrls: attachmentUrls(attachments, opts?.attachmentSigner),
    // Every file agents wrote (captured by the file-events hook), grouped by
    // agentId in the drawer's "files changed" list; the report-like ones also
    // appear above as artifact chips.
    files,
    // Paths two agents wrote while both were running (issue #113). The three
    // dispatch gates are complete for what they see, and origin/branch are 1:1
    // for every world-driven rule — but none of them can see what an agent does
    // once it is running. This is that blind spot, read off rows we already have
    // rather than off an advisory claim an agent has to remember to make.
    overlaps: detectFileOverlaps({ files, agents: store.listAgents(), tasks }),
    // Things agents noticed outside their own tasks (the `report_finding` tool).
    // Operator-facing only: nothing in the dispatcher reads them, and one becomes
    // work only through `POST /api/findings/:id/promote`.
    findings,
    // Open ones and a settled tail alike, exactly as `findings` ships: "we asked
    // and it was declined" is information, and a row that vanished on being
    // settled would take the operator's own note with it.
    humanTasks,
    escalations: store.listEscalations(),
    // Acts a human was asked to authorize (issue #109). The cockpit joins these
    // to their escalation so a decision-bearing item gets accept/reject rather
    // than a text box, and the decision log reads the settled ones as the human
    // half of the audit trail.
    proposals,
    decisions: shiftLog,
    // The "Up next" queue: the last cycle's ordered pickup plan with the
    // headroom cut (issue #69). A per-pulse projection — null until a cycle
    // has run, or when the active dispatcher doesn't materialise a plan.
    upcoming: harness.upcoming,
    worldEvents,
    // Recorded failures (cycle exceptions, provider outages, agent crashes,
    // route 500s) for the cockpit's Errors panel.
    errors: store.listErrors(100),
    refUrls,
    // The rule book, as data: decision rows carry a rule id; the cockpit looks
    // the id up here to expand a decision into "which rule fired, and why".
    dispatchRules: DISPATCH_RULES,
    usage: buildUsage(system),
  };
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
 * The reviewable half of a stored assay, or null when nobody has judged the goal.
 *
 * Null and `workable` are not the same reading and neither is `unclear`, which is
 * the whole point of the field: a goal nothing has assayed draws no drill at all,
 * while a refused one draws a drill that is stopped and says why. Collapsing the
 * two would put #158's verdict back where it was — legible only as prose inside
 * `pickup.reasons`.
 *
 * `commentRef` is the one thing here the assay says to somebody *else*: the
 * standing comment the desk keeps on the ticket, as a canonical ref (#171). It is
 * the sharper half of that issue — the harness explaining on another person's
 * ticket why it will not act — and until now the operator could only find it by
 * opening the tracker and reading the thread. `goalRef` is still deliberately not
 * shipped: it is a fingerprint the hold is measured against, not a reading.
 */
function assayVerdictOf(assay: IssueAssay | undefined) {
  if (!assay) return null;
  const { verdict, summary, by, decidedAt } = assay;
  return { verdict, summary, by, decidedAt, commentRef: issueCommentRef(assay.originRef, assay.commentRef) };
}

/**
 * Account-level Claude usage for the cockpit chip (issue #60): the rolling cost
 * windows summed from stream-mode turn reports (all modes, self-computed), plus
 * the real subscriber 5h/weekly limits when the PTY status-line capture has
 * seen any (Pro/Max only — null otherwise, and the UI degrades to cost).
 */
function buildUsage(system: System) {
  const now = Date.now();
  const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
  return {
    windows: {
      fiveHourCostUsd: system.store.sumUsageCostSince(iso(5 * 60 * 60 * 1000)),
      sevenDayCostUsd: system.store.sumUsageCostSince(iso(7 * 24 * 60 * 60 * 1000)),
    },
    rateLimits: system.rateLimits?.readLatest() ?? null,
  };
}
