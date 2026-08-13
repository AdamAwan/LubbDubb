// Seed data for the GitHub Pages demo. This is the canned world the fake backend
// (demoBackend.ts) starts from — a plausible slice of an engineering day so every
// cockpit panel has something real-looking to render. No server, no network.
import type {
  AppState,
  Issue,
  OpenPullRequest,
  PlanHistory,
  PlanNarrative,
  PlanPart,
  PlanPartView,
  PlanRevision,
  ValidationCheck,
} from '../types.js';

interface DemoSeed {
  state: AppState;
  // Per-agent scrollback the drawer seeds from before live deltas take over.
  transcripts: Record<string, string>;
}

/**
 * The verdicts every issue on the wire carries, in the reading a goal nobody has
 * judged gets. A helper rather than six more lines per fixture, and a helper
 * rather than loosening the contract: the server folds all six for every issue,
 * so a fixture omitting them was a demo world the real cockpit could not receive.
 */
type IssueSeed = Omit<
  Issue,
  'assay' | 'conclusion' | 'delivery' | 'retrospective' | 'scratchpad' | 'shortfall' | 'spend' | 'validation'
> &
  Partial<Issue>;

function demoIssue(seed: IssueSeed): Issue {
  return {
    conclusion: { verdict: 'undeclared', by: null, note: '', at: null },
    shortfall: null,
    delivery: null,
    assay: null,
    retrospective: null,
    scratchpad: null,
    // Null rather than a zero: a goal nothing measured and a goal that cost
    // nothing are different facts, and the demo must not model the one the
    // cockpit is built to keep apart. Fixtures that have been worked set it.
    spend: null,
    // Null is "no validation plan", which is a third reading and not a synonym
    // for clear — the fixtures that have one set it.
    validation: null,
    ...seed,
  };
}

/**
 * One validation check, with the fields a fixture rarely varies defaulted — the
 * `demoPart` helper's reason: a fixture that had to state every column would
 * state most of them wrong.
 */
function demoCheck(
  seed: Partial<ValidationCheck> & Pick<ValidationCheck, 'id' | 'letter' | 'seq' | 'title' | 'createdAt' | 'updatedAt'>,
): ValidationCheck {
  return {
    planId: 'plan-231',
    do: '',
    expect: '',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    deferUntil: null,
    supersededReason: null,
    ...seed,
  };
}

/** A worked goal's spend, in the shape the roll-up ships it. */
function demoSpend(issueNumber: number, costUsd: number, agents: number): Issue['spend'] {
  return {
    originRef: `issue:${issueNumber}`,
    issueNumber,
    costUsd,
    inputTokens: Math.round(costUsd * 180_000),
    outputTokens: Math.round(costUsd * 9_000),
    agents,
  };
}

/**
 * The CI verdict for a world that reports no per-check detail — which is what a
 * `fake` provider always reports, so it is the demo's honest answer rather than a
 * placeholder. `actionable` with three empty lists is missing detail, not a clean
 * bill of health; see `classifyCiFailures`.
 */
const NO_CI_DETAIL: OpenPullRequest['ciVerdict'] = {
  actionable: true,
  dispatch: [],
  escalate: [],
  ignored: [],
  urgent: false,
};

/** An open pull request as the wire ships one: the row plus its three verdicts. */
type OpenPrSeed = Omit<OpenPullRequest, 'ciVerdict'> & Partial<OpenPullRequest>;

function demoPr(seed: OpenPrSeed): OpenPullRequest {
  return { ciVerdict: NO_CI_DETAIL, ...seed };
}

/**
 * A plan part, with the five columns that are null until something concludes it.
 * `demoIssue`'s reason: the store writes them for every row, so a fixture leaving
 * them out was describing a part the reconciler could not have produced.
 */
type PartSeed = Omit<
  PlanPart,
  | 'blockedReason'
  | 'expectedKind'
  | 'outcomeKind'
  | 'outcomeRef'
  | 'outcomeSummary'
  | 'touches'
  | 'acceptanceMet'
  | 'size'
> &
  Partial<PlanPart> & {
    /** Seeded rather than derived: the demo has no `agent_files` to join against. */
    outsideScope?: string[];
    /** Seeded when a demo plan is deeper than one stack — see {@link demoPart}. */
    depth?: number;
  };

function demoPart(seed: PartSeed): PlanPartView {
  const part: PlanPart = {
    expectedKind: null,
    touches: [],
    acceptanceMet: [],
    size: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    blockedReason: null,
    ...seed,
  };
  return {
    ...part,
    // The wave the map draws it in. The server computes it with `partDepth`, a
    // longest-path walk; a seed has no siblings to walk, so `depth` is seeded
    // explicitly wherever a demo plan is deeper than one stack.
    depth: seed.depth ?? (part.dependsOn.length === 0 ? 0 : 1),
    // Split here the way the server splits it, rather than seeded per part: the
    // demo is meant to exercise the same rendering the real snapshot produces, and
    // a hand-written checklist would drift from the one criterion text is keyed on.
    acceptanceCriteria: (part.acceptance ?? '')
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
      .filter((text) => text !== '')
      .map((text) => ({ text, met: part.acceptanceMet.includes(text) })),
    outsideScope: seed.outsideScope ?? [],
  };
}

/** Build a fresh demo world. Timestamps are relative to now so the feed reads as "recent". */
export function buildDemoState(): DemoSeed {
  const now = Date.now();
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();
  const ahead = (mins: number) => new Date(now + mins * 60_000).toISOString();
  const state: AppState = {
    config: {
      // Short heartbeat so the countdown bar visibly moves in the demo.
      heartbeatIntervalMs: 15_000,
      maxConcurrentAgents: 3,
      watchLabel: 'lubbdubb-watch',
      ignoreLabel: 'lubbdubb-ignore',
      // The demo world is all-fake, so the inject panel stays available — and by
      // the same token there is no tracker to file a ticket into, so that button
      // is hidden exactly as it would be on a `fake` deployment.
      canFileTickets: false,
    },
    control: { cap: 3, paused: false },
    // What the plan sheet's approval bar states: the funnel is on, verdicts are
    // proposals, and two of a plan's parts run at once.
    planning: {
      enabled: true,
      requireApproval: true,
      maxConcurrentPartsPerIssue: 2,
      gitFetchIntervalMs: 60_000,
    },
    worldObservedAt: ago(0),
    world: {
      takenAt: ago(0),
      pullRequests: [
        demoPr({
          id: 'pr-142',
          number: 142,
          title: 'Add rate limiting to the ingest API',
          branch: 'feature/rate-limit',
          ciStatus: 'failing',
          unresolvedComments: [
            { id: 'c-1', author: 'reviewer', body: 'Can you pull the window size into config?', handled: false },
          ],
          approved: false,
          mergeable: true,
          baseBranch: 'main',
          // GitHub's own `unstable` is folded to `unknown` by `normalizeMergeState`
          // — the raw value never reaches the wire, which is what the demo used to
          // claim it did.
          mergeableState: 'unknown',
          merged: false,
          health: { blocked: true, reasons: ['CI failing', '1 unresolved comment'] },
          attention: { status: 'harness', reasons: ['an agent is working this branch'] },
        }),
        demoPr({
          id: 'pr-141',
          number: 141,
          title: 'Cache PR merge commits between cycles',
          branch: 'feature/merge-cache',
          ciStatus: 'passing',
          unresolvedComments: [],
          approved: true,
          mergeable: true,
          baseBranch: 'main',
          mergeableState: 'clean',
          merged: false,
          health: { blocked: false, reasons: [] },
          attention: { status: 'you', reasons: ['a merge is waiting on your verdict'] },
        }),
        demoPr({
          id: 'pr-139',
          number: 139,
          title: 'Azure DevOps connector: reviewer votes → approval',
          branch: 'feature/azure-approval',
          ciStatus: 'passing',
          unresolvedComments: [
            { id: 'c-2', author: 'maintainer', body: 'Rebase on main — this is behind.', handled: false },
          ],
          approved: false,
          mergeable: false,
          baseBranch: 'main',
          mergeableState: 'behind',
          merged: false,
          health: { blocked: true, reasons: ['behind base branch'] },
          attention: { status: 'harness', reasons: ['queued for a base update'] },
        }),
        demoPr({
          id: 'pr-143',
          number: 143,
          title: '#212 [2/3] refactor(store): route reads through the interface',
          branch: 'issue/212/reads',
          ciStatus: 'passing',
          unresolvedComments: [],
          approved: true,
          mergeable: true,
          baseBranch: 'main',
          mergeableState: 'clean',
          merged: false,
          health: { blocked: false, reasons: [] },
          attention: { status: 'you', reasons: ['a merge is waiting on your verdict'] },
        }),
        demoPr({
          id: 'pr-144',
          number: 144,
          title: '#212 [3/3] refactor(store): route writes through the interface',
          branch: 'issue/212/writes',
          ciStatus: 'failing',
          unresolvedComments: [],
          approved: false,
          mergeable: true,
          baseBranch: 'issue/212/reads',
          mergeableState: 'unknown',
          merged: false,
          health: { blocked: true, reasons: ['CI failing on base PR #143'] },
          attention: { status: 'elsewhere', reasons: ['waiting on PR #143'] },
        }),
        // The ignore tag as a *state*, so the demo shows the one row the harness
        // will never touch: tagged, still listed with its health, drawn spent.
        demoPr({
          id: 'pr-137',
          number: 137,
          title: 'Spike: swap the queue for a work-stealing pool',
          branch: 'spike/work-stealing',
          ciStatus: 'failing',
          unresolvedComments: [],
          approved: false,
          mergeable: true,
          baseBranch: 'main',
          mergeableState: 'clean',
          merged: false,
          labels: ['lubbdubb-ignore'],
          health: { blocked: true, reasons: ['CI failing'] },
          attention: { status: 'ignored', reasons: ['tagged "lubbdubb-ignore" — the harness is leaving it alone'] },
        }),
      ],
      // What the World panel used to lose: a PR you were watching disappears when
      // it leaves the open set, with nothing to say whether it landed.
      closedPullRequests: [
        {
          id: 'pr-140',
          number: 140,
          title: 'Fold check-runs and combined status into one CI verdict',
          branch: 'feature/ci-aggregate',
          ciStatus: 'unknown',
          unresolvedComments: [],
          baseBranch: 'main',
          merged: true,
          state: 'merged',
          closedAt: ago(52),
        },
        {
          id: 'pr-138',
          number: 138,
          title: 'Screen-scrape the PTY transcript',
          branch: 'feature/screen-scrape',
          ciStatus: 'unknown',
          unresolvedComments: [],
          baseBranch: 'main',
          merged: false,
          state: 'closed',
          closedAt: ago(96),
        },
      ],
      issues: [
        // A three-row slice of an Azure Boards tree, which is the one thing a
        // GitHub-shaped fixture set cannot show: a container the harness refuses
        // to work, a story that reads its feature's goal, and an orphan flagged
        // but still worked. See docs/spec/06-issue-pickup.md#hierarchy.
        demoIssue({
          id: 'iss-812',
          number: 812,
          title: 'Self-serve checkout',
          body: 'Customers can complete a purchase without contacting support. Success is a checkout that works on one page, keeps card details out of our logs, and degrades to the old flow if the payment provider is down.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          issueType: 'Feature',
          workItemState: 'Active',
          parent: null,
          children: [
            {
              number: 843,
              title: 'One-page checkout shell',
              issueType: 'User Story',
              workItemState: 'Closed',
              state: 'closed',
            },
            {
              number: 844,
              title: 'Tokenise card entry',
              issueType: 'User Story',
              workItemState: 'Active',
              state: 'open',
            },
            {
              number: 845,
              title: 'Validate the address form inline',
              issueType: 'User Story',
              workItemState: 'Active',
              state: 'open',
            },
          ],
          linkedPrNumber: null,
          pickup: {
            eligible: false,
            status: 'container',
            reasons: ['Feature is a container — work its 3 child items (2 still open)'],
          },
        }),
        demoIssue({
          id: 'iss-845',
          number: 845,
          title: 'Validate the address form inline',
          body: 'Validate the address fields as they are typed, against the same rules the payment provider applies.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          issueType: 'User Story',
          workItemState: 'Active',
          parent: {
            number: 812,
            title: 'Self-serve checkout',
            issueType: 'Feature',
            workItemState: 'Active',
            state: 'open',
            body: 'Customers can complete a purchase without contacting support. Success is a checkout that works on one page, keeps card details out of our logs, and degrades to the old flow if the payment provider is down.',
          },
          siblings: [
            {
              number: 843,
              title: 'One-page checkout shell',
              issueType: 'User Story',
              workItemState: 'Closed',
              state: 'closed',
            },
            {
              number: 844,
              title: 'Tokenise card entry',
              issueType: 'User Story',
              workItemState: 'Active',
              state: 'open',
            },
          ],
          linkedPrNumber: null,
          pickup: { eligible: true, status: 'eligible', reasons: [] },
        }),
        demoIssue({
          id: 'iss-844',
          number: 844,
          title: 'Tokenise card entry',
          body: 'Card details go to the provider iframe and never touch our servers or logs.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          issueType: 'User Story',
          workItemState: 'Active',
          parent: {
            number: 812,
            title: 'Self-serve checkout',
            issueType: 'Feature',
            workItemState: 'Active',
            state: 'open',
            body: 'Customers can complete a purchase without contacting support.',
          },
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'active', reasons: ['agent running'] },
        }),
        demoIssue({
          id: 'iss-903',
          number: 903,
          title: 'Totals drift by a penny on multi-currency carts',
          body: 'Rounding is applied per line rather than per order, so a mixed-currency cart is out by a penny.',
          labels: ['bug', 'lubbdubb-watch'],
          state: 'open',
          issueType: 'Bug',
          workItemState: 'Active',
          // Flagged, not blocked: still eligible, and every agent put on it is
          // told the parent is missing and offered the open features it may
          // belong to.
          parent: null,
          linkedPrNumber: null,
          pickup: { eligible: true, status: 'eligible', reasons: [] },
        }),
        demoIssue({
          id: 'iss-208',
          number: 208,
          title: 'Retry transient GitHub 502s in the snapshotter',
          body: 'Snapshot cycles occasionally fail on a 502 from the REST API. Wrap the calls in a bounded retry.',
          labels: ['bug', 'priority:high', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: true, status: 'eligible', reasons: [] },
        }),
        // The two goals the in-flight pull requests belong to. They are here so
        // that every ask the demo raises has a goal page to be read on: an
        // escalation from PR #142 or #139 resolves through `linkedPrNumber` and
        // opens its goal, rather than a panel with no context around it. The
        // harness does work ticketless PRs — the console still has the goal-less
        // reading for them — but a demo is what the flow is *meant* to look like,
        // and that is a queue where every row leads somewhere.
        demoIssue({
          id: 'iss-248',
          number: 248,
          title: 'Add token-bucket rate limiting to the ingest API',
          body: 'The ingest endpoint has no ceiling; one client can starve the rest. Token bucket per API key.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: 142,
          pickup: { eligible: false, status: 'has_pr', reasons: ['resolved into PR #142 — the PR rules own it now'] },
        }),
        demoIssue({
          id: 'iss-236',
          number: 236,
          title: 'Read Azure DevOps reviewer votes as approval',
          body: 'The connector reports every Azure PR as unapproved: reviewer votes are never mapped to approval state.',
          labels: ['bug', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: 139,
          pickup: { eligible: false, status: 'has_pr', reasons: ['resolved into PR #139 — the PR rules own it now'] },
        }),
        demoIssue({
          id: 'iss-205',
          number: 205,
          title: 'Document the sentinel protocol in the README',
          body: 'Explain @@LUBBDUBB_DONE@@ / @@LUBBDUBB_WAITING@@ and where detection lives.',
          labels: ['docs', 'lubbdubb-watch'],
          state: 'open',
          // Delivered by PR #140, which merged and left the open list — the state
          // the retrospective exists for, and the one the demo could not show
          // before: a goal that is finished but not yet closed by a human.
          linkedPrNumber: 140,
          pickup: { eligible: false, status: 'delivered', reasons: ['assessed as delivered'] },
          delivery: {
            summary: 'PR #140 folded the checks and the docs landed with it.',
            by: 'assessor',
            decidedAt: new Date(Date.now() - 5_400_000).toISOString(),
          },
          conclusion: {
            verdict: 'done' as const,
            by: 'agent' as const,
            note: 'README section added; detection covered.',
            at: new Date(Date.now() - 5_700_000).toISOString(),
          },
          // The reading only — the document is fetched when the station is opened.
          retrospective: {
            summary: 'Delivered in one PR, but two agents were spent chasing a red base that was never ours.',
            hasDocument: true,
            updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
          },
          // What the agents wrote each other while they worked it — the testimony
          // the write-up above was written from, and the demo's one readable pad.
          // The count and the age only; the trail is fetched on open.
          scratchpad: { entries: 4, updatedAt: new Date(Date.now() - 4_200_000).toISOString() },
          // A finished goal, so its total has stopped moving: the write-up above
          // says two agents were spent on a red base that was never ours, and this
          // is what that cost.
          spend: demoSpend(205, 6.14, 4),
        }),
        demoIssue({
          id: 'iss-212',
          number: 212,
          title: 'Move the store behind a repository interface',
          body: 'Too big for one PR: the schema move has to land before anything reads through the new interface.',
          labels: ['refactor', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: 143,
          // A plan, not a PR: the chip reports plan progress rather than whichever
          // part happened to open a pull request last.
          pickup: { eligible: false, status: 'planning', reasons: ['1/3 parts merged'] },
          // Still running, and the figure with it: a decomposed goal's spend is the
          // planner plus every part, which is exactly what one number per goal is
          // for — no card anywhere else adds those up.
          spend: demoSpend(212, 18.42, 7),
        }),
        demoIssue({
          id: 'iss-210',
          number: 210,
          title: 'Explore a Slack notification channel',
          body: 'Nice-to-have: mirror escalations into a Slack channel.',
          labels: ['idea'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'unwatched', reasons: ['no watch label "lubbdubb-watch"'] },
        }),
        // A watched ticket the harness has deliberately not started on: the goal
        // assay could not work out what to do from the description, so pickup is
        // held and the row carries both overrides plus a way into the question the
        // harness asked on the thread (#171). The one demo state where the harness
        // has spoken to somebody outside the cockpit.
        demoIssue({
          id: 'iss-219',
          number: 219,
          title: 'Make the queue smarter',
          body: 'Up next puts the wrong things first sometimes.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: null,
          pickup: {
            eligible: false,
            status: 'assay',
            reasons: ['the goal assay could not act on this goal'],
          },
          assay: {
            verdict: 'unclear',
            summary:
              'Nothing here names which ordering is wrong, or what the right one would be. Which two items ' +
              'came out in the wrong order, and which should have been first?',
            by: 'assayer',
            decidedAt: ago(52),
            commentRef: 'issue:219:comment:8402',
          },
        }),
        demoIssue({
          id: 'iss-231',
          number: 231,
          title: 'Split the cockpit auth guard from the artifact route',
          body: 'Artifact chips 401 unauthenticated — the fix touches the guard, the route, and the snapshot.',
          labels: ['refactor', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'planning', reasons: ['0/3 parts merged'] },
        }),
      ],
    },
    tasks: [
      {
        id: 'task-a1',
        kind: 'code',
        title: 'Fix failing CI on PR #142',
        prompt: 'CI is red on feature/rate-limit. Investigate the failing test and push a fix.',
        branch: 'feature/rate-limit',
        originRef: 'pr:142',
        originTitle: 'Add token-bucket rate limiting to the ingest API',
        originSummary: 'PR #142 on branch feature/rate-limit · CI failing',
        dispatchReason: 'PR #142 has failing CI and no agent is on it.',
        status: 'running',
        agentId: 'agent-a1',
        createdAt: ago(8),
        updatedAt: ago(1),
      },
      {
        id: 'task-a2',
        kind: 'code',
        title: 'Rebase PR #139 on main',
        prompt: 'PR #139 is behind base. Rebase on main and resolve any conflicts.',
        branch: 'feature/azure-approval',
        originRef: 'pr:139',
        originTitle: 'Map Azure DevOps reviewer votes to approval state',
        originSummary: 'PR #139 on branch feature/azure-approval · behind main',
        dispatchReason: 'PR #139 is behind main and no agent is on it.',
        status: 'running',
        agentId: 'agent-a2',
        createdAt: ago(4),
        updatedAt: ago(2),
      },
      {
        id: 'task-a0',
        kind: 'code',
        title: 'Document sentinel protocol (#205)',
        prompt: 'Add a README section describing the sentinel protocol.',
        branch: 'feature/merge-cache',
        originRef: 'issue:205',
        originTitle: 'Document the sentinel protocol',
        originSummary: 'Agents signal done/waiting via reserved control strings; the README should explain them.',
        dispatchReason: 'Open issue #205 has no linked PR and no agent is on it.',
        status: 'done',
        agentId: 'agent-a0',
        createdAt: ago(40),
        updatedAt: ago(22),
      },
    ],
    // One decomposed issue, so the plan panel has a stack to draw: part 1 merged,
    // part 2 in review with its PR open, part 3 ready but held by the plan's own
    // two-at-a-time concurrency cap.
    // The same three-part decomposition seen as pull requests rather than as plan
    // rows: part 2 is the bottom rung (its base is the default branch, part 1 having
    // merged) and part 3 stacks on it, red only because part 2's commits are red.
    stacks: [
      {
        ref: 'stack:143',
        issueNumber: 212,
        issueTitle: 'Move the store behind a repository interface',
        planId: 'plan-212',
        rungs: [
          {
            prNumber: 143,
            title: '#212 [2/3] refactor(store): route reads through the interface',
            branch: 'issue/212/reads',
            base: 'main',
            position: 1,
            partSlug: 'reads',
          },
          {
            prNumber: 144,
            title: '#212 [3/3] refactor(store): route writes through the interface',
            branch: 'issue/212/writes',
            base: 'issue/212/reads',
            position: 2,
            partSlug: 'writes',
          },
        ],
      },
    ],
    // Withheld, because rung #144 is red — the state worth having in the demo, since
    // "why can't I click it" is the question the control has to answer on its own.
    stackLandings: [{ ref: 'stack:143', offer: false, blockedBy: '#144 CI failing', landing: null, landed: 0 }],
    plans: [
      {
        id: 'plan-212',
        originRef: 'issue:212',
        title: 'Move the store behind a repository interface',
        status: 'active',
        // Deliberately left on the old shape: a plan written before `diagnosis`
        // and `approach` existed, so the modal falls back to reading `reason` as
        // the headline. Every plan in a real database predates them once.
        diagnosis: null,
        approach: null,
        reason: 'The schema move has to merge before anything reads through the new interface.',
        risks:
          'The repository interface has to cover every query the harness makes today, or a missed one surfaces as a runtime error instead of a compile error.',
        outOfScope: 'Swapping the underlying engine off SQLite — this only adds the seam, it does not use it.',
        alternatives: null,
        openQuestions: null,
        verification: null,
        evidence: [],
        document:
          '# Move the store behind a repository interface\n\n' +
          'Three parts, stacked: the schema migration has to land before anything can read through the new ' +
          'interface, and the read path has to land before the write path so there is never a window where ' +
          'both paths disagree about what a query returns.\n\n' +
          '## Why three PRs\n\n' +
          'Each part is independently reviewable and each one leaves the harness in a working state — the ' +
          'schema part alone is a no-op migration; the reads part alone changes what code reads but not what ' +
          'it means.',
        discussing: false,
        // An active plan whose parts have moved: the reconciler has news to
        // report, so its one living comment exists. Canonical (`issue:<n>:comment:<id>`)
        // exactly as the server ships it — the store's provider id never reaches here.
        statusCommentRef: 'issue:212:comment:8391',
        createdAt: ago(90),
        updatedAt: ago(6),
      },
      // A decomposition still waiting on a human: the approval escalation below
      // and the plan card's Approve/Reject footer are the whole point of this entry.
      {
        id: 'plan-231',
        originRef: 'issue:231',
        title: 'Split the cockpit auth guard from the artifact route',
        status: 'awaiting_approval',
        diagnosis:
          'Every artifact chip 401s, and not because the guard is wrong: `/artifacts/:id` sits **inside** the `/api` prefix the cockpit guards with a bearer token, and opening a chip is a top-level browser navigation — which cannot carry an `Authorization` header. The route has never been reachable the way it is reached.',
        approach:
          'Move `/artifacts/:id` out from behind the prefix guard and gate it on a short-lived signed capability instead, minted into the state snapshot beside each chip. The URL carries its own proof, so a plain navigation works and nothing else moves outside the guard.',
        reason:
          'The capability signer has to exist before the route can verify one, and the guard change touches every route.',
        risks:
          '**Guard window.** Moving `/artifacts` outside the `/api` prefix means part 2 briefly serves artifacts with no guard at all — the capability check has to land in the same PR, not a later one. **Two modes.** With `auth.enabled` off there is no signing key, so the route serves with no capability at all, and only one of those two modes is covered by the capability tests today. **Snapshot churn.** Part 3 widens the state snapshot, which every cockpit panel reads; a field added there is a field every consumer has to tolerate the absence of on an older server.',
        outOfScope:
          '- Capability revocation. Named as a rejected alternative in the write-up — it needs a store of its own and nothing here creates one.\n- Any change to the cockpit bearer token.\n- Artifact TTL, which stays at 5 minutes.',
        alternatives:
          '**Allow-list the route inside the prefix guard.** One line, and the fix I would have shipped a year ago. Rejected because one exception is a line and the second one is a policy: the guard stops being readable as "everything under `/api` is authenticated" the moment anything under it is not.\n\n' +
          '**Serve the artifact through an authenticated `fetch` and hand the browser a blob URL.** Works, and keeps the route where it is — but the chip stops being a link, so it cannot be opened in a new tab, bookmarked or sent to anyone. That is most of what a chip is for.\n\n' +
          '**A cookie scoped to `/artifacts`.** Rejected on the two-modes problem below: with `auth.enabled` off there is nothing to put in it, so the cookie path needs the same unauthenticated arm the capability path needs, and it costs a `SameSite` argument as well.',
        openQuestions:
          'With `auth.enabled` off there is no signing key, so the route has to serve with no capability at all — and I am not certain that arm should exist rather than the route simply 404ing. I have written it as "serves everything", which is what the operator running with auth off has already chosen, but it is the one decision here I would want argued with.\n\n' +
          'Second, smaller: I assumed the capability rides in the query string. A path segment would keep it out of proxy logs. I have no evidence anyone proxies this.',
        verification:
          'Open an artifact chip in the cockpit with `auth.enabled` on, in a new tab, and get the file rather than a 401 — that is the whole bug, and it is not reproducible from a test that can set a header.',
        evidence: [
          {
            path: 'src/server/app.ts',
            line: 88,
            note: 'the prefix guard: `addHook` over `/api`, which `/artifacts/:id` sits under',
          },
          {
            path: 'src/server/routes/artifacts.ts',
            line: 24,
            note: 'the route, registered inside the guarded prefix',
          },
          {
            path: 'web/src/components/AgentDrawer.tsx',
            line: 212,
            note: 'the chip is an `<a href>` — a navigation, so no Authorization header',
          },
        ],
        document:
          '# Serving artifacts outside the authenticated /api prefix\n\n' +
          'Every artifact chip in the cockpit currently 401s. This is not a bug in the guard — it is a structural ' +
          'consequence of where the route lives.\n\n' +
          '## Why it is broken\n\n' +
          'Opening a chip is a top-level browser navigation, and a navigation cannot carry the `Authorization` ' +
          'header the cockpit attaches to every `fetch`.\n\n' +
          '> Allow-listing the route inside the prefix guard is the tempting fix and the one to avoid. One ' +
          'exception is one line; the second one is a policy.\n\n' +
          '## Why three pull requests\n\n' +
          '1. The signer is a pure predicate with no callers.\n' +
          '2. The route change is the only part that alters who can reach what.\n' +
          '3. The snapshot change touches the cockpit as well as the server.\n\n' +
          '## The one thing I am unsure about\n\n' +
          'With `auth.enabled` off there is no signing key, so the route must serve with no capability at all. ' +
          'That means two modes and only one of them is covered by the capability tests.',
        discussing: false,
        // An unapproved decomposition announces nothing, so the reconciler has
        // deliberately written no comment for this one.
        statusCommentRef: null,
        createdAt: ago(12),
        updatedAt: ago(12),
      },
    ],
    planParts: [
      demoPart({
        id: 'plan-212:schema',
        planId: 'plan-212',
        slug: 'schema',
        seq: 1,
        title: 'Add the repository tables and migration',
        scope: 'src/store/',
        dependsOn: [],
        rationale:
          'The migration has to be reviewable on its own — it changes nothing behaviourally until the reads part lands.',
        acceptance: 'The new tables exist and the migration runs clean on a copy of the production database.',
        touches: [],
        acceptanceMet: [],
        size: null,
        branch: 'issue/212/schema',
        prNumber: 140,
        status: 'merged',
        taskId: null,
        createdAt: ago(90),
        updatedAt: ago(30),
      }),
      demoPart({
        id: 'plan-212:reads',
        planId: 'plan-212',
        slug: 'reads',
        seq: 2,
        title: 'Route reads through the interface',
        scope: 'src/harness.ts, src/dispatcher/',
        dependsOn: ['schema'],
        rationale: 'Reads are safe to move first — nothing downstream depends on the write path also having moved.',
        acceptance:
          'Every dispatcher/harness read goes through the interface; no direct SQL remains outside the store.',
        branch: 'issue/212/reads',
        prNumber: 143,
        status: 'in_review',
        taskId: null,
        createdAt: ago(90),
        updatedAt: ago(6),
      }),
      demoPart({
        id: 'plan-212:writes',
        planId: 'plan-212',
        slug: 'writes',
        seq: 3,
        title: 'Route writes through the interface',
        scope: 'src/executor/, src/agents/',
        dependsOn: ['reads'],
        rationale:
          'Writes go last — the read path has to be proven out first, or a write bug is indistinguishable from a read bug.',
        acceptance: 'Every executor/agent write goes through the interface; direct SQLite access is gone from both.',
        touches: [],
        acceptanceMet: [],
        size: null,
        branch: null,
        prNumber: null,
        status: 'ready',
        taskId: null,
        createdAt: ago(90),
        updatedAt: ago(6),
      }),
      // The step a person owns, and the part waiting behind it. Two rows rather
      // than one because the *point* of a human step is what it holds up: a
      // `cutover` nobody is waiting on and one stopping a verification look
      // identical on a list, and the queue's holding count exists to tell them apart.
      demoPart({
        id: 'plan-212:cutover',
        planId: 'plan-212',
        slug: 'cutover',
        seq: 4,
        title: 'Point the staging database at the new schema',
        scope: 'the RDS console — no agent has an account for it',
        dependsOn: ['writes'],
        expectedKind: 'human',
        rationale: 'Nobody gave the fleet console credentials, and nobody should.',
        acceptance: 'Staging reads and writes against the new tables.',
        touches: [],
        acceptanceMet: [],
        size: null,
        branch: null,
        prNumber: null,
        status: 'ready',
        taskId: null,
        createdAt: ago(90),
        updatedAt: ago(6),
      }),
      demoPart({
        id: 'plan-212:soak',
        planId: 'plan-212',
        slug: 'soak',
        seq: 5,
        title: 'Assert on a staging soak run',
        scope: 'test/soak/',
        dependsOn: ['cutover'],
        rationale: 'The only part that can prove the cutover worked, and it cannot start before it has.',
        acceptance: 'A soak run over the new schema passes against staging.',
        touches: [],
        acceptanceMet: [],
        size: null,
        branch: null,
        prNumber: null,
        status: 'pending',
        taskId: null,
        createdAt: ago(90),
        updatedAt: ago(6),
      }),
      // plan-231's three parts — all `ready`, none dispatched, because the plan
      // itself is still awaiting approval (rule `plan-part` queues them `unapproved`).
      demoPart({
        id: 'plan-231:signer',
        planId: 'plan-231',
        slug: 'signer',
        seq: 1,
        title: 'Add the capability signer',
        scope: 'The signing and verification of a short-lived capability, and nothing that calls it.',
        dependsOn: [],
        rationale: 'A pure sign/verify predicate with no callers yet — reviewable in isolation from the route change.',
        acceptance:
          '- A capability minted for a flag id verifies, and one for another id does not.\n' +
          '- An expired capability is refused.\n' +
          '- A tampered payload is refused.',
        touches: ['src/server/artifactCapability.ts'],
        acceptanceMet: [],
        size: 's',
        depth: 0,
        branch: null,
        prNumber: null,
        status: 'ready',
        taskId: null,
        createdAt: ago(12),
        updatedAt: ago(12),
      }),
      demoPart({
        id: 'plan-231:route',
        planId: 'plan-231',
        slug: 'route',
        seq: 2,
        title: 'Move the artifact route outside /api and require the capability',
        scope: 'Where the artifact route is registered, and the guard it sits behind.',
        dependsOn: ['signer'],
        rationale: 'This is the only part that changes who can reach what, so it stays separate from the pure signer.',
        acceptance:
          '- `/artifacts/:id` serves only with a valid capability.\n' +
          '- Every route still under `/api` 401s without a bearer token.\n' +
          '- With `auth.enabled` off the route serves with no capability at all.',
        touches: ['src/server/app.ts', 'src/server/routes/artifacts.ts'],
        acceptanceMet: [],
        size: 'm',
        depth: 1,
        branch: null,
        prNumber: null,
        status: 'ready',
        taskId: null,
        createdAt: ago(12),
        updatedAt: ago(12),
      }),
      demoPart({
        id: 'plan-231:mint',
        planId: 'plan-231',
        slug: 'mint',
        seq: 3,
        title: 'Mint capabilities into the snapshot',
        scope: 'The state snapshot that mints a capability per chip, and the chip that opens it.',
        // A rejoin: it wires the signer's output into the route, so it waits for
        // *both* lanes to have merged rather than stacking on either.
        dependsOn: ['signer', 'route'],
        rationale:
          'Touches the cockpit as well as the server, so it waits until both the signer and the route it points at exist.',
        acceptance:
          '- Every artifact chip in the cockpit opens in a new tab without a 401.\n' +
          '- The snapshot carries a capability per chip, and no capability for a flag with no artifact.',
        touches: ['src/server/stateSnapshot.ts', 'web/src/components/AgentDrawer.tsx'],
        acceptanceMet: [],
        size: 'm',
        depth: 2,
        branch: null,
        prNumber: null,
        status: 'ready',
        taskId: null,
        createdAt: ago(12),
        updatedAt: ago(12),
      }),
    ],
    // A validation plan on the plan awaiting approval, so the sheet's section and
    // the flag are both reachable in the demo rather than only in a real
    // deployment that has written one. Three checks, one of each interesting
    // state: one passed, one nobody has got to, and one nominated for the fleet.
    validationChecks: [
      demoCheck({
        id: 'chip-opens-in-a-new-tab',
        createdAt: ago(12),
        updatedAt: ago(12),
        letter: 'A',
        seq: 1,
        title: 'An artifact chip opens in a new tab with auth on',
        do: 'Run the cockpit with `auth.enabled`, open a goal with an artifact chip, and middle-click the chip.',
        expect: 'The file renders. No 401, and no bearer token anywhere in the URL bar.',
        covers: ['route'],
        state: 'passed',
        resultNote: 'Opened #212’s design doc in a new tab — served straight through.',
        resultBy: 'operator',
        resultAt: ago(2),
      }),
      demoCheck({
        id: 'auth-off-still-serves',
        createdAt: ago(12),
        updatedAt: ago(12),
        letter: 'B',
        seq: 2,
        title: 'With auth off, artifacts still serve',
        do: 'Set `auth.enabled` to false, restart, and open the same chip.',
        expect: 'The file renders with no capability in the URL at all.',
        covers: ['route'],
      }),
      demoCheck({
        id: 'tampered-capability-refused',
        createdAt: ago(12),
        updatedAt: ago(12),
        letter: 'C',
        seq: 3,
        title: 'A tampered capability is refused',
        do: 'Copy an artifact URL, change one character of the signature, and request it.',
        expect: 'A 403, and the artifact is not served.',
        covers: ['signer'],
        fleetCandidate: true,
        candidateWhy: 'a plain HTTP request against a running harness; needs no login and no browser',
      }),
    ],
    validationResources: [],
    jobs: [],
    // One recurrence, so the desk's schedule list is not an empty box in the demo.
    // Its `nextRunAt` is null for the reason the demo backend never fires one: the
    // cron parser is server code, and a copy of it here would be free to disagree
    // with the only implementation that schedules anything.
    schedules: [
      {
        id: 'sch-1',
        title: 'Sweep the dependency updates',
        prompt: 'Check for outdated dependencies, upgrade the safe ones and open a PR with the changelog links.',
        kind: 'code',
        cron: '0 9 * * 1',
        enabled: true,
        nextRunAt: null,
        lastFiredAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
        lastJobId: null,
        createdAt: new Date(Date.now() - 21 * 24 * 3_600_000).toISOString(),
        updatedAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
      },
    ],
    // Every list `/api/state` always ships, empty here because the demo has no
    // story for them: an orphan-free boot, no goal retained past its issue, and
    // no agent that surfaced an artifact or wrote a file. Present rather than
    // omitted because the wire sends them unconditionally — a demo that left them
    // out was a payload the real cockpit never receives.
    recovery: [],
    retainedRuns: [],
    flags: [],
    artifactUrls: {},
    // The demo has no attachments: their bytes live on a disk the demo does not
    // have, and a thumbnail is the one thing here that cannot be faked from a
    // fixture.
    attachments: [],
    attachmentUrls: {},
    files: [],
    // A path two live agents are both editing from different branches. Neither
    // dispatch gate is violated — the collision only exists inside the worktrees,
    // which is the whole point of detecting it off what was actually written.
    overlaps: [
      {
        path: 'src/integrations/azure/restAzureDevOpsApi.ts',
        sameWorktree: false,
        live: true,
        writers: [
          {
            agentId: 'agent-a2',
            taskId: 'task-a2',
            originRef: 'pr:139',
            originTitle: 'Map Azure DevOps reviewer votes to approval state',
            branch: 'feature/azure-approval',
            status: 'waiting',
            at: ago(2),
          },
          {
            agentId: 'agent-a1',
            taskId: 'task-a1',
            originRef: 'pr:142',
            originTitle: 'Add token-bucket rate limiting to the ingest API',
            branch: 'feature/rate-limit',
            status: 'running',
            at: ago(6),
          },
        ],
      },
    ],
    // Empty for the same reason `canFileTickets` is false: the demo has no tracker
    // to raise a bug into, so a row here would be a link to nothing.
    bugFilings: [],
    // What agents noticed outside their own tasks — one of each kind, which is
    // the whole vocabulary (`report_finding`).
    findings: [
      {
        id: 'find-1',
        agentId: 'agent-a1',
        taskId: 'task-a1',
        originRef: 'pr:142:ci',
        kind: 'out_of_scope',
        ref: null,
        summary: 'The retry helper squares the delay instead of doubling it, so the 5th retry waits ~17 minutes',
        where: 'src/net/backoff.ts:41',
        detail:
          'Not what I was sent to fix, but it is why `ingest.flaky.test.ts` times out — the ' +
          'test budget is 60s and the 4th retry alone sleeps 256s.\n\n' +
          '```\n' +
          'delay = base ** attempt   // 2, 4, 16, 256, 65536\n' +
          'delay = base * 2 ** attempt   // what the comment above it describes\n' +
          '```',
        status: 'open',
        jobId: null,
        ticketRef: null,
        createdAt: ago(12),
        updatedAt: ago(12),
      },
      {
        id: 'find-2',
        agentId: 'agent-a2',
        taskId: 'task-a2',
        originRef: 'issue:139',
        kind: 'duplicate',
        ref: 'issue:118',
        summary: 'This asks for the same provider seam as #118, which already has a merged design doc',
        where: null,
        detail: null,
        status: 'open',
        jobId: null,
        ticketRef: null,
        createdAt: ago(20),
        updatedAt: ago(20),
      },
      {
        id: 'find-3',
        agentId: 'agent-a0',
        taskId: 'task-a0',
        originRef: 'issue:205',
        kind: 'blocked',
        ref: 'issue:205',
        // Deliberately unsplit: a row filed before `where`/`detail` existed, so the
        // demo shows what the card does with one (clamps it, does not pretend).
        summary:
          'The real fix is in the upstream azure-devops-node-api types — the field exists on the wire but not in the published typings. Nothing I can change from this repo.',
        where: null,
        detail: null,
        status: 'dismissed',
        jobId: null,
        ticketRef: null,
        createdAt: ago(48),
        updatedAt: ago(30),
      },
      // The other resolution: filed in the tracker rather than worked now, so the
      // panel shows what a deferred finding looks like once its ticket exists.
      {
        id: 'find-4',
        agentId: 'agent-a1',
        taskId: 'task-a1',
        originRef: 'pr:142:ci',
        kind: 'out_of_scope',
        ref: null,
        summary: 'The ingest API has no request-size limit, so a 200MB body is buffered before anything rejects it',
        where: 'src/server/routes/ingest.ts, the POST /v1/events handler',
        detail: 'Unrelated to the CI failure I was sent for. Reproduced with a 200MB body — RSS peaked at 1.4GB.',
        status: 'filed',
        jobId: 'job-filed-1',
        ticketRef: 'issue:214',
        createdAt: ago(64),
        updatedAt: ago(58),
      },
    ],
    // Work only a person can do. Four, so the panel shows each shape it has: a
    // plan step holding parts shut, a standalone ask from an agent that could not
    // do it itself, one already declined with the note that stopped it, and the
    // harness's own close-out on the goal it delivered but cannot close.
    humanTasks: [
      {
        id: 'hum-1',
        title: 'Point the staging database at the new schema',
        detail:
          'RDS console → `lubbdubb-staging` → Parameter groups.\n\n' +
          '- Switch `search_path` to the new schema\n' +
          '- Restart the instance, then check the app comes back clean\n\n' +
          'Done when staging reads and writes against the new tables. Nobody gave the fleet ' +
          'console credentials, and nobody should.',
        originRef: 'issue:212:part:cutover',
        partId: 'plan-212:cutover',
        kind: 'ask',
        agentId: null,
        taskId: null,
        status: 'open',
        resolution: null,
        createdAt: ago(18),
        updatedAt: ago(18),
        resolvedAt: null,
        dismissedAt: null,
      },
      {
        id: 'hum-2',
        title: 'Confirm the new empty state reads correctly on a real phone',
        detail:
          'I can render it and diff the DOM, but not judge whether the copy lands at 375px in ' +
          'sunlight. Screenshot attached to the PR.',
        originRef: 'pr:142',
        partId: null,
        kind: 'ask',
        agentId: 'agent-a1',
        taskId: 'task-a1',
        status: 'open',
        resolution: null,
        createdAt: ago(40),
        updatedAt: ago(40),
        resolvedAt: null,
        dismissedAt: null,
      },
      {
        id: 'hum-3',
        title: 'Rotate the CI deploy key',
        detail: null,
        originRef: 'issue:205',
        partId: null,
        kind: 'ask',
        agentId: 'agent-a0',
        taskId: 'task-a0',
        status: 'declined',
        resolution: 'Not until the migration lands — rotating now breaks the release branch mid-flight.',
        createdAt: ago(72),
        updatedAt: ago(52),
        resolvedAt: ago(52),
        dismissedAt: null,
      },
      {
        // The harness's own, on the goal it delivered at #205 and cannot close.
        // Nobody asked for it — no agent, no operator — which is what a
        // `close_out` with a null `agentId` says, and it settles itself as soon as
        // the tracker stops listing the item open.
        id: 'hum-4',
        title: 'Close issue #205 in the tracker',
        detail:
          'The assessor marked **Document the sentinel protocol in the README** delivered — ' +
          '"PR #140 folded the checks and the docs landed with it."\n\n' +
          'The item is still open in the tracker. Close it there and this settles itself on the ' +
          'next pulse — or mark it done here, or decline it and say why.',
        originRef: 'issue:205',
        partId: null,
        kind: 'close_out',
        agentId: null,
        taskId: null,
        status: 'open',
        resolution: null,
        createdAt: ago(50),
        updatedAt: ago(50),
        resolvedAt: null,
        dismissedAt: null,
      },
    ],
    agents: [
      {
        id: 'agent-a1',
        taskId: 'task-a1',
        status: 'running',
        cwd: '/work/lubbdubb-142',
        pid: 4821,
        waitingReason: null,
        sessionId: null,
        startedAt: ago(8),
        endedAt: null,
        costUsd: 0.84,
        inputTokens: 412_000,
        outputTokens: 18_400,
        numTurns: 3,
        note: 'Reworking the policy-evaluation fold so a superseded push stops poisoning CI status',
        notedAt: ago(3),
        resumedAt: null,
      },
      {
        id: 'agent-a2',
        taskId: 'task-a2',
        status: 'waiting',
        cwd: '/work/lubbdubb-139',
        pid: 4899,
        waitingReason: 'Rebase hit a conflict in restAzureDevOpsApi.ts — resolve which side wins?',
        sessionId: null,
        startedAt: ago(4),
        endedAt: null,
        costUsd: 0.31,
        inputTokens: 168_000,
        outputTokens: 6_200,
        numTurns: 2,
        note: 'Rebasing onto main — three files conflict, working through them in order',
        notedAt: ago(9),
        // Asked, then carried on regardless: the demo's one stale alert, so the
        // "agent resumed" chip and Dismiss have something to act on.
        resumedAt: ago(2),
      },
      {
        id: 'agent-a0',
        taskId: 'task-a0',
        status: 'done',
        cwd: '/work/lubbdubb-205',
        pid: null,
        waitingReason: null,
        sessionId: null,
        startedAt: ago(40),
        endedAt: ago(22),
        costUsd: 2.17,
        inputTokens: 1_240_000,
        outputTokens: 54_000,
        numTurns: 9,
        // A finished agent keeps its last note: the one-line summary of the run.
        note: 'Suite green, PR opened',
        notedAt: ago(22),
        resumedAt: null,
      },
    ],
    // The act behind the drafted-reply escalation below (issue #109). It is what
    // turns that card from "type something" into "approve & send / reject": the
    // draft was written, and nothing goes out until you say so.
    proposals: [
      {
        id: 'prop-1',
        kind: 'reply_draft',
        ref: 'pr:142:comment:c-1',
        status: 'pending',
        action: {
          type: 'reply_on_pr',
          reason: 'reviewer asked whether the window is configurable',
          prNumber: 142,
          commentId: 'c-1',
          draft:
            'Good call — I pulled the window size into config as `RATE_LIMIT_WINDOW_MS` (defaulting to the old 60s) and wired it through. Pushed as a fixup.',
        },
        note: null,
        decidedBy: null,
        decidedAt: null,
        escalationId: 'esc-2',
        createdAt: ago(1),
      },
      // The plan decomposition itself, held for a human before any part is scheduled.
      {
        id: 'prop-2',
        kind: 'plan',
        ref: 'issue:231:plan',
        status: 'pending',
        action: {
          type: 'propose_plan',
          reason: 'Issue #231 was decomposed into 3 part(s) and approval is required before any is scheduled.',
          planId: 'plan-231',
          originRef: 'issue:231',
        },
        note: null,
        decidedBy: null,
        decidedAt: null,
        escalationId: 'esc-3',
        createdAt: ago(12),
      },
    ],
    escalations: [
      {
        // A drafted PR reply held for sign-off — the auto-send gate wrote a
        // response to the reviewer's comment on #142 but wasn't confident enough
        // to send it unattended, so it escalates for approval (the "Draft reply"
        // panel + approve flow).
        id: 'esc-2',
        type: 'review_reply',
        status: 'open',
        prompt:
          'Draft reply for PR #142:\n\nGood call — I pulled the window size into config as `RATE_LIMIT_WINDOW_MS` (defaulting to the old 60s) and wired it through. Pushed as a fixup.',
        context: {
          taskTitle: 'Fix failing CI on PR #142',
          originRef: 'pr:142',
          prNumber: 142,
          commentId: 'c-1',
          draft:
            'Good call — I pulled the window size into config as `RATE_LIMIT_WINDOW_MS` (defaulting to the old 60s) and wired it through. Pushed as a fixup.',
          confidence: 0.62,
        },
        agentId: 'agent-a1',
        taskId: 'task-a1',
        response: null,
        createdAt: ago(1),
        answeredAt: null,
      },
      {
        // The plan-approval ask: "Needs you" gets a card with a link into the same
        // plan modal rather than a free-text prompt, since a decomposition is
        // approved or rejected, never typed into.
        id: 'esc-3',
        type: 'approve_change',
        status: 'open',
        prompt:
          'Issue #231 was decomposed into 3 parts: signer, route, mint. Approve to schedule, or reject to keep it as one PR.',
        context: {
          originRef: 'issue:231',
          planId: 'plan-231',
          // Whose words these are, said rather than guessed at. A plan approval
          // has no agent behind it and is not an assessment, so a card deriving
          // the label from "no agent" would caption a planner's decomposition as
          // an assessor's finding.
          detailFrom: 'How the planner split it',
          // Markdown, so the demo shows the rendered path rather than the grey
          // block it used to be.
          detail:
            'Split on the seams the tests already draw:\n\n' +
            '- **signer** — pure, no deps, lands first\n' +
            '- **route** — needs the signer\n' +
            '- **mint** — needs both\n\n' +
            'One PR would put the signer rewrite and the route change in the same review.',
        },
        agentId: null,
        taskId: null,
        response: null,
        createdAt: ago(12),
        answeredAt: null,
      },
      {
        // Several questions in one park (the questionnaire). The demo carries one
        // because it is the shape that changes how the inbox reads: a count chip
        // and a button where the answer box was, with the questions in a modal.
        id: 'esc-4',
        type: 'resolve_ambiguity',
        status: 'open',
        prompt: "I've read the plan against the code — three things I'd question before we approve it.",
        context: {
          taskTitle: 'Discuss the plan for issue #231',
          originRef: 'issue:231',
          questions: [
            {
              question: 'Part one is fat — split it, or leave it as two parts?',
              detail:
                'Store module + schema + routes + `/api/state` + the gate + the cockpit floor + six ' +
                'specs. The riskiest bit (the gate) is buried in a big single review.',
              options: ['Split into three parts', 'Keep two parts'],
            },
            {
              question: "Keep `requestedBy: 'operator'` with a null origin?",
              detail: "An operator parking a note for themselves is scope the acceptance criteria don't ask for.",
              options: ['Keep it', 'Cut it'],
            },
            { question: 'Rename `PartExpectedKind` to `expectedKind` in the part-two file list?' },
          ],
        },
        // Agentless, like the plan approval above: an ask with no agent is the
        // operator's alone, and the queue groups it as `yours` rather than blocking.
        agentId: null,
        taskId: null,
        response: null,
        createdAt: ago(1),
        answeredAt: null,
      },
      {
        id: 'esc-1',
        type: 'answer_question',
        status: 'open',
        prompt: 'Rebase hit a conflict in restAzureDevOpsApi.ts — resolve which side wins?',
        context: {
          taskTitle: 'Rebase PR #139 on main',
          originRef: 'pr:139',
          recentOutput: 'CONFLICT (content): Merge conflict in src/integrations/azure/restAzureDevOpsApi.ts',
          prNumber: 139,
        },
        agentId: 'agent-a2',
        taskId: 'task-a2',
        response: null,
        createdAt: ago(2),
        answeredAt: null,
      },
      // The harness asking, not an agent: a shortfall whose cause is the goal
      // itself, which schedules nothing and so is a question rather than a
      // proposal. Here because it is the *long* case — the assessor's write-up is
      // the body of the card — and the card that has to stay readable is this one.
      // Note the shape: a one-line prompt, and every word the assessor wrote in
      // `detail`, quoted rather than spliced into the harness's sentence.
      {
        // `esc-5`, not a second `esc-4`: the goal page resolves a queue row back to
        // its escalation by id, so two open rows sharing one id would pin this
        // assessment to the wrong goal's page — and the rail would key two rows the
        // same.
        id: 'esc-5',
        type: 'resolve_ambiguity',
        status: 'open',
        prompt:
          'An assessment of issue #205 ("Document the sentinel protocol") found the work done and the goal ' +
          'still not reached, and the issue itself to be what is wrong — no planner and no agent can fix a ' +
          'goal, so nothing has been dispatched and nothing will be.',
        context: {
          taskTitle: 'Document the sentinel protocol',
          originRef: 'issue:205:shortfall',
          issueNumber: 205,
          detailFrom: 'What the assessor found',
          detail:
            '**The README section landed; the protocol it documents is two protocols, and the issue names ' +
            'neither.**\n\n' +
            '## Present\n\n' +
            'PR #143 added `docs/sentinels.md` and linked it from the README. It documents the `DONE` and ' +
            '`WAITING` tokens, their exact spelling, and the scanner that strips SGR escapes out of them.\n\n' +
            '## Missing\n\n' +
            '- The stream runtime has no sentinels at all — it reads terminals off the result event — so ' +
            'half the fleet is undocumented and the page does not say so.\n' +
            '- `agentMode` is never mentioned, which is what decides which half a reader is in.\n\n' +
            '## Why the goal, and not the plan\n\n' +
            'Both parts delivered exactly the scope they declared. The issue asks to "document the sentinel ' +
            'protocol", singular, and there are two; a planner handed this back would decompose the same ' +
            'wrong question again. Someone has to say which protocol the docs are for.',
        },
        agentId: null,
        taskId: null,
        response: null,
        createdAt: ago(4),
        answeredAt: null,
      },
    ],
    decisions: [
      {
        id: 'dec-4',
        cycleId: 'cycle-103',
        action: { type: 'reply_on_pr', reason: 'reviewer asked for a config change on #142' },
        subjectRef: 'pr:142',
        outcome: 'executed',
        detail: 'Drafted a reply and escalated for approval (confidence 0.62 below threshold)',
        rule: null,
        admission: null,
        createdAt: ago(1),
      },
      {
        id: 'dec-3',
        cycleId: 'cycle-102',
        action: { type: 'dispatch_code_agent', reason: 'PR #142 CI is failing' },
        subjectRef: 'pr:142:ci',
        outcome: 'executed',
        detail: 'Dispatched agent onto feature/rate-limit',
        rule: 'pr-ci-failing',
        admission: null,
        createdAt: ago(8),
      },
      {
        id: 'dec-2',
        cycleId: 'cycle-101',
        action: { type: 'escalate_to_human', reason: 'agent parked on a human' },
        // An escalation is about a human, not a ticket: the column draws a dash.
        subjectRef: null,
        outcome: 'executed',
        detail: 'Rebase conflict on PR #139 needs a call',
        rule: 'pr-base-update',
        admission: null,
        createdAt: ago(2),
      },
      {
        id: 'dec-1',
        cycleId: 'cycle-98',
        action: { type: 'merge_pr', reason: 'PR #141 is merge-ready' },
        subjectRef: 'pr:141',
        outcome: 'deferred',
        detail: 'auto-merge disabled — leaving for a human',
        rule: 'pr-merge-ready',
        admission: null,
        createdAt: ago(12),
      },
    ],
    // The dispatcher's ranked pickup plan from the "last pulse": cap 3 with two
    // live agents leaves headroom 1, so the top candidate dispatches and the
    // rest sit below the cut.
    upcoming: {
      cycleId: 'cycle-103',
      at: ago(0),
      items: [
        {
          origin: 'issue:208',
          rule: 'issue-pickup',
          title: 'Resolve issue #208',
          kind: 'code',
          branch: 'issue/208',
          status: 'dispatching',
          reason: 'Open issue #208 has no linked PR and no agent is on it.',
        },
        {
          // Held by the plan's own concurrency cap rather than by fleet headroom —
          // a free slot wouldn't start it, which is why it says `capped` and not
          // `waiting`, and why it is queued at all rather than skipped in silence.
          origin: 'issue:212:part:writes',
          rule: 'plan-part',
          title: 'Issue #212 part: Route writes through the interface',
          kind: 'code',
          branch: 'issue/212/writes',
          status: 'capped',
          reason:
            'Part "writes" of issue #212 is ready and stacks on issue/212/reads. Held: issue #212 is already at its 2-part concurrency cap.',
        },
        {
          // Queued but held, same as `writes` above — this time by the plan's own
          // awaiting_approval status rather than a concurrency cap.
          origin: 'issue:231:part:signer',
          rule: 'plan-part',
          title: 'Issue #231 part: Add the capability signer',
          kind: 'code',
          branch: 'issue/231/signer',
          status: 'unapproved',
          reason:
            'Part "signer" of issue #231 is ready and has no agent. Held: the plan for issue #231 is awaiting your approval — nothing is scheduled until you accept it.',
        },
        {
          origin: 'issue:231:part:route',
          rule: 'plan-part',
          title: 'Issue #231 part: Move the artifact route outside /api and require the capability',
          kind: 'code',
          branch: 'issue/231/route',
          status: 'unapproved',
          reason:
            'Part "route" of issue #231 is ready and stacks on issue/231/signer. Held: the plan for issue #231 is awaiting your approval — nothing is scheduled until you accept it.',
        },
      ],
    },
    errors: [
      {
        id: 'err-2',
        source: 'agent',
        message: 'Agent agent-a0 failed (task task-a0), exit code 1',
        detail: 'npm test\n✗ rate-limit window resets on rollover\nProcess exited with code 1',
        createdAt: ago(11),
      },
      {
        id: 'err-1',
        source: 'provider',
        message: 'sourceControl:github snapshot failed: request to api.github.com timed out',
        detail: null,
        createdAt: ago(25),
      },
    ],
    worldEvents: [
      { id: 'we-5', kind: 'pr_ci', ref: 'pr:142', summary: 'CI failing on PR #142', createdAt: ago(8) },
      { id: 'we-4', kind: 'pr_comment', ref: 'pr:142', summary: 'reviewer commented on PR #142', createdAt: ago(7) },
      { id: 'we-3', kind: 'pr_approved', ref: 'pr:141', summary: 'PR #141 approved', createdAt: ago(9) },
      { id: 'we-2', kind: 'issue_opened', ref: 'issue:208', summary: 'Issue #208 opened', createdAt: ago(15) },
      { id: 'we-1', kind: 'pr_merged', ref: 'pr:138', summary: 'PR #138 merged', createdAt: ago(30) },
    ],
    // Ref → URL map the real provider builds; canned here so the demo's issue/PR
    // references render as clickable links, keyed by how they appear in the UI (`#N`).
    refUrls: {
      '#142': 'https://github.com/example/lubbdubb/pull/142',
      '#141': 'https://github.com/example/lubbdubb/pull/141',
      '#139': 'https://github.com/example/lubbdubb/pull/139',
      '#208': 'https://github.com/example/lubbdubb/issues/208',
      '#205': 'https://github.com/example/lubbdubb/issues/205',
      '#210': 'https://github.com/example/lubbdubb/issues/210',
      '#212': 'https://github.com/example/lubbdubb/issues/212',
      '#143': 'https://github.com/example/lubbdubb/pull/143',
      '#140': 'https://github.com/example/lubbdubb/pull/140',
      '#231': 'https://github.com/example/lubbdubb/issues/231',
      '#219': 'https://github.com/example/lubbdubb/issues/219',
      // The two comments the harness maintains on a ticket by itself, keyed by the
      // canonical ref the snapshot ships (#171) and anchored the way the provider
      // builds them. Absent from this map ⇒ the cockpit draws no way in at all.
      'issue:212:comment:8391': 'https://github.com/example/lubbdubb/issues/212#issuecomment-8391',
      'issue:219:comment:8402': 'https://github.com/example/lubbdubb/issues/219#issuecomment-8402',
      // The colon form, which is what the harness speaks: a part's ref, a job's
      // origin, an agent's origin and a decision's subject are all structured refs,
      // and the `#n` keys above answer none of them. The server keys both families
      // for the same items (see `buildRefUrls`), so the demo does too — otherwise
      // the Pages build is the one place every new link renders as plain text.
      'issue:205': 'https://github.com/example/lubbdubb/issues/205',
      'issue:208': 'https://github.com/example/lubbdubb/issues/208',
      'issue:210': 'https://github.com/example/lubbdubb/issues/210',
      'issue:212': 'https://github.com/example/lubbdubb/issues/212',
      'issue:219': 'https://github.com/example/lubbdubb/issues/219',
      'issue:231': 'https://github.com/example/lubbdubb/issues/231',
      'issue:212:part:writes': 'https://github.com/example/lubbdubb/issues/212',
      'issue:231:part:route': 'https://github.com/example/lubbdubb/issues/231',
      'issue:231:part:signer': 'https://github.com/example/lubbdubb/issues/231',
      'pr:139': 'https://github.com/example/lubbdubb/pull/139',
      'pr:141': 'https://github.com/example/lubbdubb/pull/141',
      'pr:142': 'https://github.com/example/lubbdubb/pull/142',
      'pr:142:ci': 'https://github.com/example/lubbdubb/pull/142/checks',
    },
    // The rule book the server ships in /api/state (src/dispatcher/rules.ts) —
    // canned to just the rules the demo's decisions reference.
    dispatchRules: {
      'pr-ci-failing': {
        kind: 'rule',
        name: 'Failing CI',
        description:
          'A PR with failing CI gets a code agent on its branch to investigate and push a fix — broken builds block everything downstream, so this outranks all other work.',
      },
      'pr-base-update': {
        kind: 'rule',
        name: 'Base out of date',
        description:
          'A PR that is behind its base branch (clean update) or conflicts with it (resolve and push) gets a code agent, so it never sits unmergeable while the base moves on.',
      },
      'branch-notify': {
        kind: 'admission',
        name: 'One agent per branch',
        description:
          'At most one code agent works a PR branch: a fresh signal for a branch that already has a running agent is delivered to that agent as a note instead of spawning a second one.',
      },
      'plan-part': {
        kind: 'rule',
        name: 'Plan part ready',
        description:
          "One part of a multi-PR plan whose dependency has pushed a branch worth stacking on, and which has no agent, gets a code agent on `issue/<n>/<slug>` — based on that dependency's branch while it is still open, on the default branch once it merged. A part held by the plan's concurrency cap is queued as `capped` rather than skipped, so the limit is visible instead of looking like nothing happened.",
      },
      'pr-merge-ready': {
        kind: 'rule',
        name: 'Merge-ready PR',
        description:
          'A green, approved, mergeable PR with no open comments is driven the last mile — merged in, gated by the auto-send policy (below the confidence bar it escalates for approval instead).',
      },
      'issue-pickup': {
        kind: 'rule',
        name: 'Open issue without a PR',
        description:
          'An open, pickup-eligible issue with no linked PR gets a code agent to resolve it into a PR — the front of the issue → PR → merge loop, ordered by label-encoded priority.',
      },
      idle: {
        kind: 'terminal',
        name: 'Nothing actionable',
        description:
          'No rule matched this cycle, so a no-op is recorded — idleness is a decision too, and stays auditable.',
      },
    },
    // Claude usage: canned subscriber limits (as the PTY status-line capture
    // would report) plus rolling cost windows summed from agent turn reports.
    usage: {
      windows: { fiveHourCostUsd: 1.15, sevenDayCostUsd: 12.4 },
      rateLimits: {
        fiveHour: { usedPercentage: 62, resetsAt: ahead(140) },
        sevenDay: { usedPercentage: 30, resetsAt: ahead(3 * 24 * 60) },
        capturedAt: ago(1),
      },
      // The remainder no goal's card shows — an operator's job the graph never
      // linked to a ticket. Non-zero on purpose: the honest demo of a partition is
      // one where the parts visibly do not add to the whole.
      unattributedCostUsd: 0.86,
    },
    // The Yield gauge's reading. Not every run finishes in the demo either: a
    // fleet that has never lost one is a fleet whose gauge nobody would click.
    runOutcomes: { settled: 24, live: 3, completed: 20, lost: 3, stopped: 1, completionRate: 20 / 24 },
  };

  const transcripts: Record<string, string> = {
    // Real `renderBlocks` output, markers intact, so the demo exercises the drawer's
    // collapsed tool blocks rather than only plain prose.
    'agent-a1': [
      'Reading feature/rate-limit — the failing case is the window edge.\n',
      '\x1b[36m⚙ Bash\x1b[0m \x1b[2mnpm test -- ratelimit\x1b[0m\n',
      '\n',
      '\x1b[31m  ↳ error\x1b[0m\x1b[2m · 5 lines\x1b[0m\n',
      '  ✗ ratelimit › rejects over the window\n',
      '    Expected 429, got 200\n',
      '    at rateLimit.test.ts:41\n',
      '  \n',
      '  1 failing, 82 passing\n',
      'So a request exactly on the boundary is let through. Let me read the comparison.\n',
      '\x1b[36m⚙ Read\x1b[0m \x1b[2msrc/ingest/rateLimit.ts\x1b[0m\n',
      '\n',
      '\x1b[90m  ↳ result\x1b[0m\x1b[2m · 18 lines\x1b[0m\n',
      '  30	  const within = elapsed <= windowMs;\n',
      '  31	  const within = elapsed <= windowMs;\n',
      '  32	  const within = elapsed <= windowMs;\n',
      '  33	  const within = elapsed <= windowMs;\n',
      '  34	  const within = elapsed <= windowMs;\n',
      '  35	  const within = elapsed <= windowMs;\n',
      '  36	  const within = elapsed <= windowMs;\n',
      '  37	  const within = elapsed <= windowMs;\n',
      '  38	  const within = elapsed <= windowMs;\n',
      '  39	  const within = elapsed <= windowMs;\n',
      '  40	  const within = elapsed <= windowMs;\n',
      '  41	  const within = elapsed <= windowMs;\n',
      '  42	  const within = elapsed <= windowMs;\n',
      '  43	  const within = elapsed <= windowMs;\n',
      '  44	  const within = elapsed <= windowMs;\n',
      '  45	  const within = elapsed <= windowMs;\n',
      '  46	  const within = elapsed <= windowMs;\n',
      '  47	  const within = elapsed <= windowMs;\n',
      'The window comparison uses <= where it should be <. Patching.\n',
    ].join(''),
    'agent-a2': [
      '$ claude --resume rebase-139',
      'git fetch origin main',
      'git rebase origin/main',
      'CONFLICT (content): Merge conflict in src/integrations/azure/restAzureDevOpsApi.ts',
      'Both sides changed resolveAzureAuth. Need a human call.',
      '@@LUBBDUBB_WAITING: which auth path wins?@@',
    ].join('\n'),
    'agent-a0': [
      '$ claude implement-205',
      'Added "Sentinel protocol" section to README.md',
      'npm run check … all green',
      'git push && opened PR #141',
      '@@LUBBDUBB_DONE@@',
    ].join('\n'),
  };

  return { state, transcripts };
}

/**
 * A plan's revision history, for the sheet's "What changed" view.
 *
 * Authored rather than derived, and only for `plan-231` — the demo's world is
 * built fresh in the browser each load, so no replan has ever landed in it and
 * there is nothing to snapshot. The real route reads `plan_revisions`, which
 * `ingestPlanDocument` writes on every submission.
 *
 * The amendment below is the one worth showing: a discussion in which the
 * operator argued the snapshot change was not a third pull request, the planner
 * agreed and folded it in, and a new part appeared for the unauthenticated arm
 * nobody had thought about. Anything else answers with no revisions, which is what
 * a plan with no history draws — no History control at all.
 */
export function demoPlanHistory(planId: string): PlanHistory {
  if (planId !== 'plan-231') return { revisions: [], diff: null };
  const at = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const narrative = (over: Partial<PlanNarrative>): PlanNarrative => ({
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    document: null,
    evidence: [],
    ...over,
  });
  const part = (over: Partial<PlanPartInputView> & { slug: string; seq: number }): PlanPartInputView => ({
    title: over.slug,
    scope: '',
    touches: [],
    dependsOn: [],
    rationale: null,
    acceptance: null,
    size: null,
    expectedKind: null,
    ...over,
  });
  const revisions: PlanRevision[] = [
    {
      id: 'rev-231-1',
      planId,
      seq: 1,
      verdict: 'parts',
      at: at(40),
      narrative: narrative({
        reason: 'The signer has to exist before the route can verify one, and the guard change touches every route.',
        approach: 'Sign a short-lived capability into the artifact URL and move the route out from behind the guard.',
      }),
      parts: [
        part({
          slug: 'signer',
          seq: 1,
          title: 'Add the capability signer',
          touches: ['src/server/artifactCapability.ts'],
          size: 's',
        }),
        part({
          slug: 'route',
          seq: 2,
          title: 'Move the artifact route outside /api',
          touches: ['src/server/app.ts'],
          dependsOn: ['signer'],
          size: 'm',
        }),
        part({
          slug: 'mint',
          seq: 3,
          title: 'Mint capabilities into the snapshot',
          touches: ['src/server/stateSnapshot.ts'],
          dependsOn: ['route'],
          size: 's',
        }),
        part({
          slug: 'chips',
          seq: 4,
          title: 'Point the cockpit chips at the minted URL',
          touches: ['web/src/components/AgentDrawer.tsx'],
          dependsOn: ['mint'],
          size: 's',
        }),
      ],
    },
    {
      id: 'rev-231-2',
      planId,
      seq: 2,
      verdict: 'parts',
      at: at(12),
      narrative: narrative({
        reason:
          'The capability signer has to exist before the route can verify one, and the guard change touches every route.',
        approach:
          'Move `/artifacts/:id` out from behind the prefix guard and gate it on a short-lived signed capability instead.',
        openQuestions: 'Whether the unauthenticated arm should serve everything or 404.',
      }),
      parts: [
        part({
          slug: 'signer',
          seq: 1,
          title: 'Add the capability signer',
          touches: ['src/server/artifactCapability.ts'],
          size: 's',
        }),
        part({
          slug: 'route',
          seq: 2,
          title: 'Move the artifact route outside /api and require the capability',
          touches: ['src/server/app.ts', 'src/server/routes/artifacts.ts'],
          dependsOn: ['signer'],
          size: 'm',
        }),
        part({
          slug: 'mint',
          seq: 3,
          title: 'Mint capabilities into the snapshot',
          touches: ['src/server/stateSnapshot.ts', 'web/src/components/AgentDrawer.tsx'],
          dependsOn: ['signer', 'route'],
          size: 'm',
        }),
      ],
    },
  ];
  return {
    revisions,
    diff: {
      seq: 2,
      againstSeq: 1,
      verdictChanged: false,
      parts: [
        { slug: 'signer', kind: 'unchanged', title: 'Add the capability signer', fields: [] },
        {
          slug: 'route',
          kind: 'changed',
          title: 'Move the artifact route outside /api and require the capability',
          fields: [
            {
              field: 'title',
              from: 'Move the artifact route outside /api',
              to: 'Move the artifact route outside /api and require the capability',
            },
            {
              field: 'touches',
              from: 'src/server/app.ts',
              to: 'src/server/app.ts, src/server/routes/artifacts.ts',
            },
          ],
        },
        {
          slug: 'mint',
          kind: 'changed',
          title: 'Mint capabilities into the snapshot',
          fields: [
            {
              field: 'touches',
              from: 'src/server/stateSnapshot.ts',
              to: 'src/server/stateSnapshot.ts, web/src/components/AgentDrawer.tsx',
            },
            { field: 'dependsOn', from: 'route', to: 'route, signer' },
            { field: 'size', from: 's', to: 'm' },
          ],
        },
        {
          slug: 'chips',
          kind: 'dropped',
          title: 'Point the cockpit chips at the minted URL',
          fields: [],
        },
      ],
      narrative: [
        { field: 'approach', kind: 'rewritten' },
        { field: 'reason', kind: 'rewritten' },
        { field: 'openQuestions', kind: 'written' },
      ],
    },
  };
}

/** The declaration half of a part, as a revision stores it — `seq` and all. */
type PlanPartInputView = PlanRevision['parts'][number];
