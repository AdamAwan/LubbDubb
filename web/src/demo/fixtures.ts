// Seed data for the GitHub Pages demo. This is the canned world the fake backend
// (demoBackend.ts) starts from — a plausible slice of an engineering day so every
// cockpit panel has something real-looking to render. No server, no network.
//
// One repository, one product: **Markdown Magpie**, a Git-backed Markdown
// knowledge system that indexes documents, answers questions with citations, logs
// the weak answers, clusters them into knowledge gaps and publishes Markdown
// improvements as pull requests. Every goal, pull request, plan, finding and
// transcript below is work on that codebase. The theme is load-bearing rather
// than decorative: a demo whose tickets come from three unrelated products reads
// as noise, and an operator learning the cockpit is trying to follow one story
// through it.
//
// The other rule this file is built to: **every pickup status appears exactly
// where it belongs.** `issuePickupStatus` has fourteen answers, and a demo
// carrying eight of them teaches an operator that the other six are broken when
// they finally show up. See the roll-call comment above `issues` below.
import type {
  AppState,
  Issue,
  KnowledgeCost,
  LocalRunRefFacts,
  LocalRunTargetView,
  OpenPullRequest,
  PullRequest,
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
  | 'assay'
  | 'conclusion'
  | 'delivery'
  | 'instructions'
  | 'modelPin'
  | 'priority'
  | 'retrospective'
  | 'scratchpad'
  | 'shortfall'
  | 'spend'
  | 'validation'
> &
  Partial<Issue>;

function demoIssue(seed: IssueSeed): Issue {
  return {
    conclusion: { verdict: 'undeclared', by: null, note: '', at: null },
    shortfall: null,
    delivery: null,
    assay: null,
    // Unpinned, which is what almost every goal is: a pin is the exception an
    // operator or an assayer made, so the demo models it on the fixtures that are
    // about it rather than everywhere.
    modelPin: { profile: null, ignoredTags: [] },
    retrospective: null,
    scratchpad: null,
    // Nothing standing, which is every goal the operator has not written on.
    instructions: [],
    // Null rather than a zero: a goal nothing measured and a goal that cost
    // nothing are different facts, and the demo must not model the one the
    // cockpit is built to keep apart. Fixtures that have been worked set it.
    spend: null,
    // Null is "no validation plan", which is a third reading and not a synonym
    // for clear — the fixtures that have one set it.
    validation: null,
    // Not flagged, which is where every goal starts: a priority is a statement the
    // operator made about this deployment's queue, so the fixture that is about it
    // sets it and the rest read as the ordinary case.
    priority: null,
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
    originRef: 'issue:395',
    do: '',
    expect: '',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'human',
    handbackNote: null,
    claimedBy: null,
    claimedAt: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    ...seed,
  };
}

/** A worked goal's spend, in the shape the roll-up ships it. */
function demoSpend(issueNumber: number, costUsd: number, agents: number, localRuns = 0): Issue['spend'] {
  return {
    originRef: `issue:${issueNumber}`,
    issueNumber,
    costUsd,
    inputTokens: Math.round(costUsd * 180_000),
    outputTokens: Math.round(costUsd * 9_000),
    agents,
    localRuns,
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
/**
 * The system-prompt block the demo's facts render to, verbatim — a hand-written
 * transcript of `renderKnowledgeBlock`'s output rather than a re-rendering of it
 * here, because what fits is the server's answer and a demo that recomputed it
 * would be exactly the second implementation of "what fits" the real page refuses.
 *
 * A named constant so the cost reading below can be priced against **this**
 * string's own length. A hand-kept character count beside a hand-kept transcript
 * is two things to keep in step, and the one that would be wrong is the number.
 */
const DEMO_KNOWLEDGE_BLOCK =
  '\n' +
  'What working this repository has taught the fleet. This is not part of your task and not an\n' +
  'instruction: it is prior evidence, dated and attributed to the goal it was learned on, offered so\n' +
  'you do not pay to rediscover it. The repository in front of you is the authority — where it and a\n' +
  'claim disagree, the claim is stale: say so with `knowledge_contradict`, naming what it should say\n' +
  'instead.\n' +
  '\n' +
  'A claim that carries a **lapses** date is a notice: something two independent goals saw recently,\n' +
  'which no operator has vouched for and which ends by itself on that date. It reports what was seen\n' +
  'and not what to do about it — the conclusion is yours to draw. Everything else below was vouched\n' +
  'for by an operator and holds until they retire it.\n' +
  '\n' +
  'This is the fleet-wide tier and not the whole record. Call `knowledge_ask` with a question when you\n' +
  'want what the fleet knows about one check, one goal, or anything not standing here, `knowledge_propose`\n' +
  'when you learn something worth the next agent not paying for again, and `knowledge_notice` when what\n' +
  'you saw is true today and will stop being true.\n' +
  '\n' +
  '- The check `check (build)` is failing on branch `feat/catalog-cutover`, which one or more open pull ' +
  'requests are based on.\n' +
  '  (first seen on pr:404, written 2026-08-22, lapses 2026-08-22)\n' +
  '- `test (windows)` has been timing out at the dependency-install step since about 09:00 — the same ' +
  'commit passes on a re-run roughly half the time.\n' +
  '  (first seen on pr:412, written 2026-08-22, lapses 2026-08-22)\n' +
  '- A ticket that only names a symptom is under-specified for a planner every time.\n' +
  '  (first seen on issue:364, written 2026-06-14)\n';

/**
 * What the demo's injected block costs the demo's fleet.
 *
 * Every figure is derived from the transcript above and the fleet's own totals
 * rather than written down, for the reason the real reading is derived from the
 * renderer: a hand-written cost beside a hand-written block is a number free to
 * describe a block that is not there.
 *
 * The share is deliberately small and the fleet's spend deliberately large,
 * because that is the shape of the real answer: the block is a **cached prefix**
 * in the system prompt, and the rate it is priced at is the fleet's own dollars
 * per input token — which already carries the cache discount, since `inputTokens`
 * is the gross figure.
 */
function demoKnowledgeCost(): KnowledgeCost {
  // The fleet's own week, as its agents reported it.
  const launches = 34;
  const turns = 1_147;
  const inputTokens = 42_600_000;
  const cachedInputTokens = 38_900_000;
  const fleetCostUsd = 61.42;
  const charsPerToken = 4;
  const blockTokens = Math.ceil(DEMO_KNOWLEDGE_BLOCK.length / charsPerToken);
  // The block rides every turn of a session, not just its launch: it is in the
  // system prompt, and a session re-sends its prefix on every call.
  const shareOfInput = (blockTokens * turns) / inputTokens;
  const usd = (n: number): number => Math.round(n * 1e6) / 1e6;
  const windowCostUsd = usd(shareOfInput * fleetCostUsd);
  return {
    windowLabel: '7d',
    blockChars: DEMO_KNOWLEDGE_BLOCK.length,
    blockTokens,
    charsPerToken,
    launches,
    unmeasured: 0,
    turns,
    inputTokens,
    cachedInputTokens,
    fleetCostUsd,
    shareOfInput,
    perDispatchUsd: usd(windowCostUsd / launches),
    windowCostUsd,
  };
}

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
      containerTypes: ['Feature', 'Epic'],
      // A plausible checkout, so the demo's Discuss link is a real `claude://code/new`
      // rather than one pointing at nothing. It opens whatever the visitor has —
      // which is the honest demonstration: the control hands off to their machine.
      desktopFolder: '/Users/you/code/demo-shop',
      // Configured, so the demo shows the panel that can start and swap rather than
      // the one explaining what is missing. Both are worth seeing and only one can
      // be the default; this is the state an operator who has set it up is in.
      localRunConfigured: true,
      localRunStopConfigured: true,
      // The demo tracker's own vocabulary, coloured — the setting is invisible
      // until a deployment has used it, and the demo is where it is looked at.
      stateColours: { New: '#8a93a0', Ready: '#7fb3ff', Active: '#63d297', Closed: '#666b73' },
      // The same four states, in workflow order rather than the colours' — the demo's
      // board is a real one, so the order has to be a judgement somebody made.
      boardStates: ['New', 'Ready', 'Active', 'Closed'],
      // The demo drags for real: a board that looks draggable and is not would teach
      // a visitor the wrong thing about the product.
      canSetWorkItemState: true,
      stateRules: { pickup: ['Ready', 'Active'], inProgress: 'Active', inReview: null, returnsTo: 'Ready' },
      // Cheapest first, as `rank` orders them — the demo's profile controls draw
      // this list in this order.
      profiles: [
        { name: 'fast', description: 'Mechanical, well-specified work with an obvious shape.' },
        { name: 'standard', description: 'Ordinary feature and bug work with a clear approach.' },
        { name: 'deep', description: 'Work whose shape is unclear, or where the approach is expensive to undo.' },
      ],
      defaultProfile: 'standard',
      // Two hours rather than the real two days, so the demo's waiting PR below
      // actually draws its age — the mechanism is what the demo is showing.
      // The demo world is all-fake, so the inject panel stays available — and by
      // the same token there is no tracker to file a ticket into, so that button
      // is hidden exactly as it would be on a `fake` deployment.
      canFileTickets: false,
    },
    control: { cap: 3, paused: false },
    // What the plan sheet's approval bar states: two of a plan's parts run at once.
    planning: {
      maxConcurrentPartsPerIssue: 2,
      gitFetchIntervalMs: 60_000,
    },
    worldObservedAt: ago(0),
    world: {
      takenAt: ago(0),
      pullRequests: [
        demoPr({
          id: 'pr-412',
          number: 412,
          // Deliberately not word-for-word its goal's title: a demo where the
          // ticket and the pull request are one string cannot show that the two
          // are different objects, and every row that quotes one reads as the other.
          title: 'Cut the ranked section list down to the token budget',
          branch: 'feature/context-budget',
          ciStatus: 'failing',
          unresolvedComments: [
            {
              id: 'c-1',
              author: 'reviewer',
              body: 'Can the budget be per-flow rather than one global number? Our runbook flow needs a bigger window than the FAQ one.',
              handled: false,
            },
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
          id: 'pr-411',
          number: 411,
          title: 'Reuse section embeddings across incremental index runs',
          branch: 'feature/embed-cache',
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
          id: 'pr-409',
          number: 409,
          title: 'Read GitHub review decisions as proposal approval',
          branch: 'feature/review-decision',
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
        // Green, clean, unapproved and nobody's turn but a reviewer's — the one
        // shape the review-wait age exists for. Dated three days back so it is
        // past the demo's threshold and actually draws.
        demoPr({
          id: 'pr-408',
          number: 408,
          title: 'Cache the tokenizer between index runs',
          branch: 'feature/tokenizer-cache',
          ciStatus: 'passing',
          unresolvedComments: [],
          approved: false,
          mergeable: true,
          baseBranch: 'main',
          mergeableState: 'clean',
          merged: false,
          health: { blocked: true, reasons: ['not approved'] },
          attention: {
            status: 'elsewhere',
            reasons: ['waiting on review'],
            reviewWaitingSince: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }),
        demoPr({
          id: 'pr-413',
          number: 413,
          title: '#390 [2/3] refactor(jobs): validate every payload through the catalog',
          branch: 'issue/390/validate',
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
          id: 'pr-414',
          number: 414,
          title: '#390 [3/3] refactor(jobs): route the watcher’s intake through the catalog',
          branch: 'issue/390/watcher',
          ciStatus: 'failing',
          unresolvedComments: [],
          approved: false,
          mergeable: true,
          baseBranch: 'issue/390/validate',
          mergeableState: 'unknown',
          merged: false,
          health: { blocked: true, reasons: ['CI failing on base PR #413'] },
          attention: { status: 'elsewhere', reasons: ['waiting on PR #413'] },
        }),
        // The ignore tag as a *state*, so the demo shows the one row the harness
        // will never touch: tagged, still listed with its health, drawn spent.
        demoPr({
          id: 'pr-407',
          number: 407,
          title: 'Spike: replace pg-boss with a LISTEN/NOTIFY worker loop',
          branch: 'spike/listen-notify',
          ciStatus: 'failing',
          unresolvedComments: [],
          approved: false,
          mergeable: true,
          baseBranch: 'main',
          mergeableState: 'clean',
          merged: false,
          labels: [],
          health: { blocked: true, reasons: ['CI failing'] },
          attention: {
            status: 'unwatched',
            reasons: ['not tagged "lubbdubb-watch" — the harness is leaving it alone'],
          },
        }),
      ],
      // What the World panel used to lose: a PR you were watching disappears when
      // it leaves the open set, with nothing to say whether it landed.
      closedPullRequests: [
        {
          id: 'pr-410',
          number: 410,
          title: 'Verify gap closure on merge instead of resolving blindly',
          branch: 'feature/verify-gap-closure',
          ciStatus: 'unknown',
          unresolvedComments: [],
          baseBranch: 'main',
          merged: true,
          state: 'merged',
          closedAt: ago(52),
        },
        {
          id: 'pr-406',
          number: 406,
          title: '#390 [1/3] refactor(jobs): move every payload schema into the catalog',
          branch: 'issue/390/schemas',
          ciStatus: 'unknown',
          unresolvedComments: [],
          baseBranch: 'main',
          merged: true,
          state: 'merged',
          closedAt: ago(30),
        },
        {
          // The pull request behind the shortfall on #382: it merged, it did what
          // it said, and the assessor still found the goal unreached.
          id: 'pr-405',
          number: 405,
          title: 'Raise the gap-cluster similarity threshold to 0.81',
          branch: 'issue/382/threshold',
          ciStatus: 'unknown',
          unresolvedComments: [],
          baseBranch: 'main',
          merged: true,
          state: 'merged',
          closedAt: ago(180),
        },
        {
          id: 'pr-408',
          number: 408,
          title: 'Screen-scrape the watcher log for job outcomes',
          branch: 'spike/log-scrape',
          ciStatus: 'unknown',
          unresolvedComments: [],
          baseBranch: 'main',
          merged: false,
          state: 'closed',
          closedAt: ago(96),
        },
      ],
      /*
       * The pickup roll-call. `issuePickupStatus` answers fourteen ways, and each
       * one is somebody's whole reading of why nothing is happening — so each has
       * a goal here, in the order they are gated:
       *
       *   done       #352   retained  #357   has_pr    #388, #376
       *   active     #332   ignored   #366   container #300
       *   unwatched  #371   planning  #390, #395       delivered #364
       *   assay      #379   cooldown  #345   escalated #359
       *   blocked    #333, #368, #382  eligible  #341
       *
       * `blocked` outnumbers `eligible` on purpose: the cap is 3 and two agents
       * are live, so exactly one goal can start this cycle and the queue below
       * dispatches it. A fixture set where six goals are all "eligible" under a
       * cap of three is a world the dispatcher could never have produced.
       *
       * Twelve of the fourteen are reachable by clicking: the backlog lists every
       * *open* item, in one of its four groups. `done` (#352) and `retained`
       * (#357) are the two that are not, because no surface lists a closed goal —
       * they are carried anyway, since both are readings the wire ships and the
       * goal page draws (a retained run is drawn there with the dismissal that
       * ends it), and a demo world with no closed goal in it would be the only
       * world the cockpit ever sees that has none.
       */
      issues: [
        // A three-row slice of a work-item tree, which is the one thing a
        // GitHub-shaped fixture set cannot show: a container the harness refuses
        // to work, a story that reads its feature's goal, and an orphan bug
        // flagged but still worked. See docs/spec/06-issue-pickup.md#hierarchy.
        demoIssue({
          id: 'iss-300',
          number: 300,
          title: 'Source-grounded document patrols',
          body: 'A patrol reads the documents it maintains against the code they describe, rather than against a sample of file content pasted into a prompt. Success is a patrol that can open any file in a read-only checkout of the source repository, and a correction that cites the line it was drawn from.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          issueType: 'Feature',
          workItemState: 'Active',
          parent: null,
          children: [
            {
              number: 331,
              title: 'Give each source-grounded job a read-only workspace',
              issueType: 'User Story',
              workItemState: 'Closed',
              state: 'closed',
            },
            {
              number: 332,
              title: 'Give HTTP providers a bounded file-tool loop',
              issueType: 'User Story',
              workItemState: 'Active',
              state: 'open',
            },
            {
              number: 333,
              title: 'Verify a document against its sources before correcting it',
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
          id: 'iss-333',
          number: 333,
          title: 'Verify a document against its sources before correcting it',
          body: 'The patrol currently drafts a correction from one read. Split it: `verify_document` reports what the document gets wrong, and `correct_document` only runs when there is something to correct.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          issueType: 'User Story',
          workItemState: 'Active',
          parent: {
            number: 300,
            title: 'Source-grounded document patrols',
            issueType: 'Feature',
            workItemState: 'Active',
            state: 'open',
            body: 'A patrol reads the documents it maintains against the code they describe, rather than against a sample of file content pasted into a prompt. Success is a patrol that can open any file in a read-only checkout of the source repository, and a correction that cites the line it was drawn from.',
          },
          siblings: [
            {
              number: 331,
              title: 'Give each source-grounded job a read-only workspace',
              issueType: 'User Story',
              workItemState: 'Closed',
              state: 'closed',
            },
            {
              number: 332,
              title: 'Give HTTP providers a bounded file-tool loop',
              issueType: 'User Story',
              workItemState: 'Active',
              state: 'open',
            },
          ],
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'blocked', reasons: ['no agent capacity'] },
        }),
        demoIssue({
          id: 'iss-332',
          number: 332,
          title: 'Give HTTP providers a bounded file-tool loop',
          body: 'A CLI provider walks the checkout with its own tools. An HTTP provider has none, so it needs `list_dir` / `read_file` / `grep` offered as tools with a hard call ceiling.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          issueType: 'User Story',
          workItemState: 'Active',
          parent: {
            number: 300,
            title: 'Source-grounded document patrols',
            issueType: 'Feature',
            workItemState: 'Active',
            state: 'open',
            body: 'A patrol reads the documents it maintains against the code they describe, rather than against a sample of file content pasted into a prompt.',
          },
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'active', reasons: ['agent running'] },
        }),
        demoIssue({
          id: 'iss-341',
          number: 341,
          title: 'Answers cite a heading the section splitter renamed',
          body: 'Sectioning lower-cases and de-duplicates heading anchors, but the citation is built from the raw heading text — so every citation into a document with two "Configuration" headings points at the wrong one.',
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
          id: 'iss-368',
          number: 368,
          title: 'Retry transient 502s from the embeddings endpoint',
          body: 'An incremental index run aborts whole-sale on one 502 from the embeddings provider, leaving the index half-written. Wrap the batch call in a bounded retry.',
          labels: ['bug', 'priority:high', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'blocked', reasons: ['no agent capacity'] },
        }),
        // The two goals the in-flight pull requests belong to. They are here so
        // that every ask the demo raises has a goal page to be read on: an
        // escalation from PR #412 or #409 resolves through `linkedPrNumber` and
        // opens its goal, rather than a panel with no context around it. The
        // harness does work ticketless PRs — the console still has the goal-less
        // reading for them — but a demo is what the flow is *meant* to look like,
        // and that is a queue where every row leads somewhere.
        demoIssue({
          id: 'iss-388',
          number: 388,
          title: 'Cap the retrieval context at the token budget before ranking',
          body: 'A question that matches forty sections sends all forty to the provider; the request is rejected or silently truncated at the far end. Cut the ranked list to the budget before the prompt is built.',
          labels: ['lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: 412,
          pickup: { eligible: false, status: 'has_pr', reasons: ['has open PR #412'] },
        }),
        demoIssue({
          id: 'iss-376',
          number: 376,
          title: 'Read GitHub review decisions as proposal approval',
          body: 'The publisher reports every proposal as unreviewed: a GitHub review decision of APPROVED is never mapped onto the proposal’s own approval state, so a reviewed proposal sits in the console forever.',
          labels: ['bug', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: 409,
          pickup: { eligible: false, status: 'has_pr', reasons: ['has open PR #409'] },
        }),
        demoIssue({
          id: 'iss-364',
          number: 364,
          title: 'Document the two-watcher requirement for maintenance jobs',
          body: 'A maintenance job blocks in an API callback while the API waits on the AI jobs it enqueued, so a single watcher self-starves. Nothing says so outside a code comment.',
          labels: ['docs', 'lubbdubb-watch'],
          state: 'open',
          // Delivered by PR #410, which merged and left the open list — the state
          // the retrospective exists for, and the one the demo could not show
          // before: a goal that is finished but not yet closed by a human.
          linkedPrNumber: 410,
          pickup: { eligible: false, status: 'delivered', reasons: ['assessed as delivered'] },
          delivery: {
            summary: 'PR #410 landed the deadlock note and the console warning with it.',
            by: 'assessor',
            decidedAt: ago(90),
          },
          conclusion: {
            verdict: 'done' as const,
            by: 'agent' as const,
            note: 'architecture.md gained the section; the console warns on one watcher.',
            at: ago(95),
          },
          // The reading only — the document is fetched when the station is opened.
          retrospective: {
            summary: 'Delivered in one PR, but two agents were spent chasing a red base that was never ours.',
            hasDocument: true,
            updatedAt: ago(60),
          },
          // What the agents wrote each other while they worked it — the testimony
          // the write-up above was written from, and the demo's one readable pad.
          // The count and the age only; the trail is fetched on open.
          scratchpad: { entries: 4, updatedAt: ago(70) },
          // A finished goal, so its total has stopped moving: the write-up above
          // says two agents were spent on a red base that was never ours, and this
          // is what that cost.
          spend: demoSpend(364, 6.14, 4),
        }),
        demoIssue({
          id: 'iss-390',
          number: 390,
          title: 'Validate job payloads in the catalog, not in each runner',
          body: 'Too big for one PR: every runner re-parses its own payload, so the schema move has to land before anything validates against it.',
          labels: ['refactor', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: 413,
          // A plan, not a PR: the chip reports plan progress rather than whichever
          // part happened to open a pull request last.
          pickup: { eligible: false, status: 'planning', reasons: ['1/5 parts done'] },
          // Still running, and the figure with it: a decomposed goal's spend is the
          // planner plus every part, which is exactly what one number per goal is
          // for — no card anywhere else adds those up.
          spend: demoSpend(390, 19.16, 7, 2),
        }),
        demoIssue({
          id: 'iss-371',
          number: 371,
          title: 'Mirror new knowledge gaps into a Slack channel',
          body: 'Nice-to-have: post a message when a gap cluster crosses the drafting threshold.',
          labels: ['idea'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'unwatched', reasons: ['no watch label "lubbdubb-watch"'] },
        }),
        // A watched ticket the harness has deliberately not started on: the goal
        // assay could not work out what to do from the description, so pickup is
        // held and the row carries both overrides plus a way into the question the
        // harness asked on the thread. The one demo state where the harness has
        // spoken to somebody outside the cockpit.
        demoIssue({
          id: 'iss-379',
          number: 379,
          title: 'Make retrieval smarter',
          body: 'Search brings back the wrong sections sometimes.',
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
              'Nothing here names which question came back wrong, or what the right sections would have been. ' +
              'Retrieval is keyword search, vector search and an RRF fold over both — which of the three is ' +
              'bringing back the wrong thing, and for which question?',
            by: 'assayer',
            // An `unclear` verdict names no profile: a goal nobody could start
            // from has no work to size.
            proposedProfile: null,
            awaitingProfileAnswer: false,
            decidedAt: ago(52),
            commentRef: 'issue:379:comment:8402',
          },
        }),
        demoIssue({
          id: 'iss-395',
          number: 395,
          title: 'Snapshot downloads 401 in the review console',
          body: 'Every snapshot download link 401s — the fix touches the auth guard, the route, and the payload the console reads.',
          labels: ['refactor', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'planning', reasons: ['awaiting your approval of the 3-part plan'] },
          // The goal the demo's validation plan hangs off, so it is the one issue
          // that carries a verdict. It has to agree with `validationChecks` below —
          // three passed of six live — because the header chip is the way in to the
          // card that draws them, and a chip disagreeing with the rows under it is
          // the one thing this whole surface exists to prevent.
          validation: { state: 'flagged', total: 6, passed: 3, failed: 0, unrun: 3, deferred: 0, waived: 0 },
        }),
        // Worked, landed, and still not what was asked for. A shortfall gates
        // nothing — the goal is eligible again the moment there is capacity — and
        // the assessor's write-up is the body of the ask in the queue below.
        demoIssue({
          id: 'iss-382',
          number: 382,
          title: 'Gap clustering merges unrelated questions into one gap',
          body: 'Two questions about different documents land in the same cluster whenever they share a common noun, so the drafted proposal answers neither.',
          labels: ['bug', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: 405,
          pickup: { eligible: false, status: 'blocked', reasons: ['no agent capacity'] },
          shortfall: {
            cause: 'goal',
            partSlug: null,
            summary:
              'The threshold was raised and the two example questions now cluster apart — but the goal asks for ' +
              'clusters that are “about one thing”, and no threshold decides that.',
            by: 'assessor',
            decidedAt: ago(4),
          },
          spend: demoSpend(382, 4.38, 3, 1),
        }),
        // Attempted twice and failed twice: the dispatcher is waiting out the
        // re-dispatch gap rather than spending a third agent on the same minute.
        // The operator's own verdict is on it as well — `more_work` from a human
        // is what puts a goal back in front of pickup, and the demo should show
        // one that has been.
        demoIssue({
          id: 'iss-345',
          number: 345,
          title: 'The watcher drops its claim when the API restarts mid-job',
          body: 'A job claimed by a watcher stays claimed after an API restart, so it is neither retried nor completed until the visibility timeout expires twenty minutes later.',
          labels: ['bug', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'cooldown', reasons: ['on cooldown after 2 attempts'] },
          conclusion: {
            verdict: 'more_work' as const,
            by: 'operator' as const,
            note: 'Both attempts fixed the symptom in the watcher. The claim is the API’s to release.',
            at: ago(80),
          },
          spend: demoSpend(345, 3.08, 2),
        }),
        // The cap spent: three agents have been and gone, and the harness has
        // stopped rather than spending a fourth. Nothing moves until a person does.
        demoIssue({
          id: 'iss-359',
          number: 359,
          title: 'Embedding backfill times out on the 40k-section repository',
          body: 'A first index of the platform handbook never finishes: the backfill embeds every section in one transaction and the statement times out at 40k rows.',
          labels: ['bug', 'priority:high', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: null,
          pickup: {
            eligible: false,
            status: 'escalated',
            reasons: ['3 failed attempts — escalated to a human'],
          },
          spend: demoSpend(359, 7.36, 3),
        }),
        // Closed, and the harness never had a run at it — the reading `done`
        // keeps, and the one a closed ticket gets on every deployment.
        demoIssue({
          id: 'iss-352',
          number: 352,
          title: 'Publish to a local-git destination without polling for a pull request',
          body: 'A `file://` destination has no pull requests to poll, so the PR-poll schedule must never be offered for one.',
          labels: ['lubbdubb-watch'],
          state: 'closed',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'done', reasons: ['closed'] },
        }),
        // Closed in the tracker, and the harness is still holding its run: the
        // state that separates "the ticket is shut" from "the work is over". The
        // only way out is the operator's dismissal, which is why it is a queue row
        // and not a chip.
        demoIssue({
          id: 'iss-357',
          number: 357,
          title: 'The reconciler re-opens gaps that a merge already closed',
          body: 'Merging a proposal resolves its gap, and the next reconciliation pass re-opens it because the questions are still logged against the old document path.',
          labels: ['bug', 'lubbdubb-watch'],
          state: 'closed',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'retained', reasons: ['closed; run kept until you dismiss it'] },
          run: { startedAt: ago(400), completedAt: ago(120), outcome: 'judged' as const, dismissed: false },
          conclusion: {
            verdict: 'done' as const,
            by: 'assessor' as const,
            note: 'Reconciliation keys on the proposal id now, not the path.',
            at: ago(120),
          },
          spend: demoSpend(357, 5.51, 3),
        }),
        // Nobody opted it in. Listed, with its health, and never touched — the
        // absent tag as a state rather than an absence.
        demoIssue({
          id: 'iss-366',
          number: 366,
          title: 'Rewrite the review console in Svelte',
          body: 'The console is Next.js with Emotion. This proposes starting again.',
          labels: [],
          state: 'open',
          linkedPrNumber: null,
          pickup: {
            eligible: false,
            status: 'unwatched',
            reasons: ['no watch label "lubbdubb-watch"'],
          },
        }),
      ],
    },
    tasks: [
      {
        id: 'task-a1',
        kind: 'code',
        title: 'Fix failing CI on PR #412',
        branch: 'feature/context-budget',
        originRef: 'pr:412',
        originTitle: 'Cap the retrieval context at the token budget before ranking',
        originSummary: 'PR #412 on branch feature/context-budget · CI failing',
        dispatchReason: 'PR #412 has failing CI and no agent is on it.',
        status: 'running',
        agentId: 'agent-a1',
        createdAt: ago(8),
        updatedAt: ago(1),
      },
      {
        id: 'task-a2',
        kind: 'code',
        title: 'Rebase PR #409 on main',
        branch: 'feature/review-decision',
        originRef: 'pr:409',
        originTitle: 'Read GitHub review decisions as proposal approval',
        originSummary: 'PR #409 on branch feature/review-decision · behind main',
        dispatchReason: 'PR #409 is behind main and no agent is on it.',
        status: 'running',
        agentId: 'agent-a2',
        createdAt: ago(4),
        updatedAt: ago(2),
      },
      {
        id: 'task-a0',
        kind: 'code',
        title: 'Document the two-watcher requirement (#364)',
        branch: 'feature/verify-gap-closure',
        originRef: 'issue:364',
        originTitle: 'Document the two-watcher requirement for maintenance jobs',
        originSummary:
          'A maintenance job blocks in an API callback while its follow-up AI jobs queue; one watcher self-starves.',
        dispatchReason: 'Open issue #364 has no linked PR and no agent is on it.',
        status: 'done',
        agentId: 'agent-a0',
        createdAt: ago(140),
        updatedAt: ago(100),
      },
    ],
    // One decomposed issue, so the plan panel has a stack to draw: part 1 merged,
    // part 2 in review with its PR open, part 3 ready but held by the plan's own
    // two-at-a-time concurrency cap.
    // The same decomposition seen as pull requests rather than as plan rows: part
    // 2 is the bottom rung (its base is the default branch, part 1 having merged)
    // and part 3 stacks on it, red only because part 2's commits are red.
    stacks: [
      {
        ref: 'stack:413',
        issueNumber: 390,
        issueTitle: 'Validate job payloads in the catalog, not in each runner',
        planId: 'plan-390',
        rungs: [
          {
            prNumber: 413,
            title: '#390 [2/3] refactor(jobs): validate every payload through the catalog',
            branch: 'issue/390/validate',
            base: 'main',
            position: 1,
            partSlug: 'validate',
          },
          {
            prNumber: 414,
            title: '#390 [3/3] refactor(jobs): route the watcher’s intake through the catalog',
            branch: 'issue/390/watcher',
            base: 'issue/390/validate',
            position: 2,
            partSlug: 'watcher',
          },
        ],
      },
    ],
    // Withheld, because rung #414 is red — the state worth having in the demo, since
    // "why can't I click it" is the question the control has to answer on its own.
    stackLandings: [{ ref: 'stack:413', offer: false, blockedBy: '#414 CI failing', landing: null, landed: 0 }],
    // The two arrivals behind the reach rows below — what the signals list draws
    // for an environment, and what the ticket comments were posted off.
    environmentArrivals: [
      {
        goalRef: 'issue:390',
        environment: 'staging',
        arrivedAt: '2026-08-19T09:12:00.000Z',
        announcedAt: '2026-08-19T09:12:04.000Z',
      },
    ],
    // One goal in each of the readings worth drawing: whole, half, and unanswerable.
    // `staging` opens both obligations, so the second goal also draws the hold —
    // delivered, and its bench rows waiting on an environment it has not reached.
    environmentReach: [
      {
        goalRef: 'issue:390',
        environments: [
          {
            environment: 'staging',
            status: 'reached',
            landed: 2,
            total: 2,
            at: '2026-08-19T09:12:00.000Z',
            opens: ['validate', 'close_out'],
          },
          { environment: 'prod', status: 'partial', landed: 1, total: 2, at: null, opens: [] },
        ],
        gateHold: null,
        released: null,
      },
      {
        goalRef: 'issue:376',
        environments: [
          {
            environment: 'staging',
            status: 'unknown',
            landed: 0,
            total: 1,
            at: null,
            opens: ['validate', 'close_out'],
          },
          { environment: 'prod', status: 'unknown', landed: 0, total: 1, at: null, opens: [] },
        ],
        gateHold: 'the validation checks and the close-out are waiting for this work to reach staging.',
        released: null,
      },
    ],
    // An environment that is up, on the goal whose plan is waiting for approval —
    // so the indicator reads `running` and the panel has something to swap away
    // from. A demo with nothing running would show only the empty state, which is
    // the half that needs no explaining.
    localRun: {
      id: 'run-1',
      // The stacked goal, at the tip of its stack — a run whose branch carries its
      // own pull request, with an earlier part behind it to fall back to. A run on a
      // goal with one branch and nothing on it would demonstrate none of what the
      // panel is for.
      originRef: 'issue:390',
      ref: 'issue/390/validate',
      dir: '/Users/you/code/demo-shop/.lubbdubb/local-run',
      pid: 48211,
      status: 'running',
      url: 'http://localhost:5173',
      note: 'Up on :5173. Seeded the sample invoices — the instruction did not mention that step.',
      startedAt: ago(18),
      endedAt: null,
      // What the session holding it up has cost so far — one of the two runs the
      // spend panel's #390 row counts.
      costUsd: 0.22,
      inputTokens: 39_600,
      outputTokens: 1_980,
      cacheReadTokens: 30_800,
      cacheCreationTokens: 2_420,
      numTurns: 4,
      live: true,
      // An environment that is already up has nothing in flight to caption. The
      // phase is what a bring-up shows *while* it is happening — press Start in the
      // demo and the scripted one in `demoBackend` runs through them.
      phase: null,
      // Filled below, from the same rows the rows are: see `localRunTargets`.
      refFacts: null,
    },
    // Filled below rather than written out: one entry per goal, and hand-maintaining
    // twenty of them beside the issue list is how a fixture comes to describe a world
    // that is not the one above it.
    localRunTargets: [],
    // A vivarium with something in it, because an empty one is indistinguishable
    // from the feature being broken — and the demo is where somebody decides
    // whether they want it at all. Four species, four stages, one of each rarity.
    pets: {
      slots: 4,
      // Well before the demo's own pets, so the line reads as a deployment that has
      // been counting for a while rather than as one that started this morning.
      startedAt: '2026-05-02T09:00:00.000Z',
      wallet: { earned: 6_240, spent: 2_900, balance: 3_340 },
      pets: [
        {
          id: 'pet-1',
          species: 'warden',
          rarity: 'uncommon',
          display: 'Warden',
          seed: 'escalation:esc_9f2a',
          name: 'Bramble',
          fed: 2_400,
          stage: 'juvenile',
          beatsToNextStage: 10_400,
          originKind: 'escalation',
          originRef: 'esc_9f2a',
          originLabel: 'Should the rate-limit park apply to review agents too?',
          hatchedAt: ago(4_320),
          openedAt: ago(4_320),
          placed: true,
          dissolvedAt: null,
          flaw: null,
          provenance: 'official',
          builtSha: '9c1d4a2f',
          builtClean: true,
          chain: null,
        },
        {
          id: 'pet-2',
          species: 'pip',
          rarity: 'common',
          display: 'Pip',
          seed: 'human-task:htk_31c',
          name: null,
          fed: 9_100,
          stage: 'adult',
          beatsToNextStage: null,
          originKind: 'human-task',
          originRef: 'htk_31c',
          originLabel: 'Issue a deploy key for the staging cluster',
          hatchedAt: ago(2_880),
          openedAt: ago(2_880),
          placed: true,
          dissolvedAt: null,
          flaw: null,
          provenance: 'official',
          builtSha: '9c1d4a2f',
          builtClean: true,
          chain: null,
        },
        {
          id: 'pet-3',
          species: 'lander',
          rarity: 'rare',
          display: 'Lander',
          seed: 'landing:land_77b',
          name: null,
          fed: 500,
          stage: 'hatchling',
          beatsToNextStage: 3_250,
          originKind: 'landing',
          originRef: 'land_77b',
          originLabel: 'stack:413',
          hatchedAt: ago(600),
          openedAt: ago(600),
          placed: true,
          dissolvedAt: null,
          flaw: null,
          provenance: 'official',
          builtSha: '9c1d4a2f',
          builtClean: true,
          chain: null,
        },
        {
          id: 'pet-4',
          species: 'ouroboros',
          rarity: 'mythic',
          display: 'Ouroboros',
          seed: 'upgrade:9c1d4a2',
          name: null,
          fed: 0,
          stage: 'hatchling',
          beatsToNextStage: 6_000,
          originKind: 'upgrade',
          originRef: '9c1d4a2',
          originLabel: '9c1d4a2',
          hatchedAt: ago(90),
          // The demo's one unopened egg: the newest drop, still a shell in the
          // corner of the rail, so the hatch is one click away in the tour.
          openedAt: null,
          placed: true,
          dissolvedAt: null,
          flaw: null,
          provenance: 'official',
          builtSha: '9c1d4a2f',
          builtClean: true,
          chain: null,
        },
      ],
    },
    plans: [
      {
        id: 'plan-390',
        originRef: 'issue:390',
        title: 'Validate job payloads in the catalog, not in each runner',
        status: 'active',
        // Deliberately left on the old shape: a plan written before `diagnosis`
        // and `approach` existed, so the modal falls back to reading `reason` as
        // the headline. Every plan in a real database predates them once.
        diagnosis: null,
        approach: null,
        reason: 'The schemas have to move into the catalog before anything can validate against them.',
        risks:
          'The catalog has to describe every payload the queue carries today, or a job type nobody moved fails to enqueue at runtime instead of at build time.',
        outOfScope: 'Changing any payload shape — this only moves where they are declared.',
        alternatives: null,
        openQuestions: null,
        verification: null,
        evidence: [],
        document:
          '# Validate job payloads in the catalog\n\n' +
          'Three parts, stacked: the schemas move first, then the API validates at enqueue, then the watcher ' +
          'validates at intake. Enqueue has to land before intake, or there is a window in which the watcher ' +
          'refuses payloads the API is still happily writing.\n\n' +
          '## Why three PRs\n\n' +
          'Each part is independently reviewable and each one leaves the queue working — the schema move alone ' +
          'is a no-op re-export; the enqueue part alone tightens what may be written without changing what is read.',
        // An active plan whose parts have moved: the reconciler has news to
        // report, so its one living comment exists. Canonical (`issue:<n>:comment:<id>`)
        // exactly as the server ships it — the store's provider id never reaches here.
        statusCommentRef: 'issue:390:comment:8391',
        createdAt: ago(300),
        updatedAt: ago(6),
      },
      // A decomposition still waiting on a human: the approval escalation below
      // and the plan card's Approve/Reject footer are the whole point of this entry.
      {
        id: 'plan-395',
        originRef: 'issue:395',
        title: 'Snapshot downloads 401 in the review console',
        status: 'awaiting_approval',
        diagnosis:
          'Every snapshot download 401s, and not because the guard is wrong: `/snapshots/:id/download` sits **inside** the `/api` prefix the console guards with an Auth0 bearer token, and clicking a download link is a top-level browser navigation — which cannot carry an `Authorization` header. The route has never been reachable the way it is reached.',
        approach:
          'Move `/snapshots/:id/download` out from behind the prefix guard and gate it on a short-lived signed capability instead, minted into the snapshot list beside each row. The URL carries its own proof, so a plain navigation works and nothing else moves outside the guard.',
        reason:
          'The capability signer has to exist before the route can verify one, and the guard change touches every route.',
        risks:
          '**Guard window.** Moving `/snapshots` outside the `/api` prefix means part 2 briefly serves snapshots with no guard at all — the capability check has to land in the same PR, not a later one. **Two modes.** With `AUTH_ENABLED` off there is no signing key, so the route serves with no capability at all, and only one of those two modes is covered by the tests today. **Payload churn.** Part 3 widens the snapshot list payload, which the console reads on every render; a field added there is a field the console has to tolerate the absence of on an older API.',
        outOfScope:
          '- Capability revocation. Named as a rejected alternative in the write-up — it needs a store of its own and nothing here creates one.\n- Any change to the console’s Auth0 session.\n- The snapshot retention window, which stays at 30 days.',
        alternatives:
          '**Allow-list the route inside the prefix guard.** One line, and the fix I would have shipped a year ago. Rejected because one exception is a line and the second one is a policy: the guard stops being readable as "everything under `/api` is authenticated" the moment anything under it is not.\n\n' +
          '**Fetch the snapshot with the bearer token and hand the browser a blob URL.** Works, and keeps the route where it is — but the row stops being a link, so it cannot be opened in a new tab, bookmarked or sent to anyone. That is most of what a download link is for.\n\n' +
          '**A cookie scoped to `/snapshots`.** Rejected on the two-modes problem below: with `AUTH_ENABLED` off there is nothing to put in it, so the cookie path needs the same unauthenticated arm the capability path needs, and it costs a `SameSite` argument as well.',
        openQuestions:
          'With `AUTH_ENABLED` off there is no signing key, so the route has to serve with no capability at all — and I am not certain that arm should exist rather than the route simply 404ing. I have written it as "serves everything", which is what the operator running with auth off has already chosen, but it is the one decision here I would want argued with.\n\n' +
          'Second, smaller: I assumed the capability rides in the query string. A path segment would keep it out of proxy logs. I have no evidence anyone proxies this.',
        verification:
          'Open a snapshot download link in the console with `AUTH_ENABLED` on, in a new tab, and get the file rather than a 401 — that is the whole bug, and it is not reproducible from a test that can set a header.',
        evidence: [
          {
            path: 'apps/api/src/app.ts',
            line: 96,
            note: 'the prefix guard: the auth hook over `/api`, which `/snapshots/:id/download` sits under',
          },
          {
            path: 'apps/api/src/features/snapshots/routes.ts',
            line: 41,
            note: 'the download route, registered inside the guarded prefix',
          },
          {
            path: 'apps/web/src/app/snapshots/page.tsx',
            line: 128,
            note: 'the row is an `<a href>` — a navigation, so no Authorization header',
          },
        ],
        document:
          '# Serving snapshot downloads outside the authenticated /api prefix\n\n' +
          'Every snapshot download link in the console currently 401s. This is not a bug in the guard — it is a ' +
          'structural consequence of where the route lives.\n\n' +
          '## Why it is broken\n\n' +
          'Clicking a download link is a top-level browser navigation, and a navigation cannot carry the ' +
          '`Authorization` header the console attaches to every `fetch`.\n\n' +
          '> Allow-listing the route inside the prefix guard is the tempting fix and the one to avoid. One ' +
          'exception is one line; the second one is a policy.\n\n' +
          '## Why three pull requests\n\n' +
          '1. The signer is a pure predicate with no callers.\n' +
          '2. The route change is the only part that alters who can reach what.\n' +
          '3. The payload change touches the console as well as the API.\n\n' +
          '## The one thing I am unsure about\n\n' +
          'With `AUTH_ENABLED` off there is no signing key, so the route must serve with no capability at all. ' +
          'That means two modes and only one of them is covered by the tests.',
        // An unapproved decomposition announces nothing, so the reconciler has
        // deliberately written no comment for this one.
        statusCommentRef: null,
        createdAt: ago(12),
        updatedAt: ago(12),
      },
    ],
    planParts: [
      demoPart({
        id: 'plan-390:schemas',
        planId: 'plan-390',
        slug: 'schemas',
        seq: 1,
        title: 'Move every payload schema into the jobs catalog',
        scope: 'packages/jobs/src/',
        dependsOn: [],
        rationale:
          'The move has to be reviewable on its own — it changes nothing behaviourally until the enqueue part lands.',
        acceptance: 'Every job type’s payload schema is declared in the catalog and re-exported from where it was.',
        touches: [],
        acceptanceMet: [],
        size: null,
        branch: 'issue/390/schemas',
        prNumber: 406,
        status: 'merged',
        taskId: null,
        createdAt: ago(300),
        updatedAt: ago(30),
      }),
      demoPart({
        id: 'plan-390:validate',
        planId: 'plan-390',
        slug: 'validate',
        seq: 2,
        title: 'Validate every payload at enqueue through the catalog',
        scope: 'apps/api/src/features/jobs/, apps/api/src/jobs/',
        dependsOn: ['schemas'],
        rationale: 'Enqueue is safe to tighten first — nothing downstream depends on the watcher also having moved.',
        acceptance: 'Every enqueue path validates against the catalog; no route parses a payload shape of its own.',
        branch: 'issue/390/validate',
        prNumber: 413,
        status: 'in_review',
        taskId: null,
        createdAt: ago(300),
        updatedAt: ago(6),
      }),
      demoPart({
        id: 'plan-390:watcher',
        planId: 'plan-390',
        slug: 'watcher',
        seq: 3,
        title: 'Route the watcher’s job intake through the catalog',
        scope: 'apps/watcher/src/worker-loop.ts, apps/watcher/src/runners/',
        dependsOn: ['validate'],
        rationale:
          'Intake goes last — enqueue has to be proven out first, or a rejected job is indistinguishable from a bad write.',
        acceptance: 'Every runner receives a payload the catalog parsed; no runner re-parses one itself.',
        // The one part the planner singled out (#342), so the demo teaches the
        // control rather than only offering it: its siblings inherit the goal's
        // pin and this one is drawn loudly because it does not.
        profile: 'deep',
        touches: [],
        acceptanceMet: [],
        size: null,
        branch: null,
        prNumber: null,
        status: 'ready',
        taskId: null,
        createdAt: ago(300),
        updatedAt: ago(6),
      }),
      // The step a person owns, and the part waiting behind it. Two rows rather
      // than one because the *point* of a human step is what it holds up: a
      // `cutover` nobody is waiting on and one stopping a verification look
      // identical on a list, and the queue's holding count exists to tell them apart.
      demoPart({
        id: 'plan-390:cutover',
        planId: 'plan-390',
        slug: 'cutover',
        seq: 4,
        title: 'Re-point the staging watchers at the new queue names',
        scope: 'the hosting dashboard — no agent has an account for it',
        dependsOn: ['watcher'],
        expectedKind: 'human',
        rationale: 'Nobody gave the fleet dashboard credentials, and nobody should.',
        acceptance: 'Both staging watchers claim jobs from the catalog’s queue names.',
        touches: [],
        acceptanceMet: [],
        size: null,
        branch: null,
        prNumber: null,
        status: 'ready',
        taskId: null,
        createdAt: ago(300),
        updatedAt: ago(6),
      }),
      demoPart({
        id: 'plan-390:soak',
        planId: 'plan-390',
        slug: 'soak',
        seq: 5,
        title: 'Assert on a staging queue soak run',
        scope: 'scripts/queue-e2e.mjs',
        dependsOn: ['cutover'],
        rationale: 'The only part that can prove the cutover worked, and it cannot start before it has.',
        acceptance: 'A queue end-to-end run against staging completes every job type once.',
        touches: [],
        acceptanceMet: [],
        size: null,
        branch: null,
        prNumber: null,
        status: 'pending',
        taskId: null,
        createdAt: ago(300),
        updatedAt: ago(6),
      }),
      // plan-395's three parts — all `ready`, none dispatched, because the plan
      // itself is still awaiting approval (rule `plan-part` queues them `unapproved`).
      demoPart({
        id: 'plan-395:signer',
        planId: 'plan-395',
        slug: 'signer',
        seq: 1,
        title: 'Add the download capability signer',
        scope: 'The signing and verification of a short-lived capability, and nothing that calls it.',
        dependsOn: [],
        rationale: 'A pure sign/verify predicate with no callers yet — reviewable in isolation from the route change.',
        acceptance:
          '- A capability minted for a snapshot id verifies, and one for another id does not.\n' +
          '- An expired capability is refused.\n' +
          '- A tampered payload is refused.',
        touches: ['apps/api/src/features/snapshots/download-capability.ts'],
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
        id: 'plan-395:route',
        planId: 'plan-395',
        slug: 'route',
        seq: 2,
        title: 'Move the download route outside /api and require the capability',
        scope: 'Where the snapshot download route is registered, and the guard it sits behind.',
        dependsOn: ['signer'],
        rationale: 'This is the only part that changes who can reach what, so it stays separate from the pure signer.',
        acceptance:
          '- `/snapshots/:id/download` serves only with a valid capability.\n' +
          '- Every route still under `/api` 401s without a bearer token.\n' +
          '- With `AUTH_ENABLED` off the route serves with no capability at all.',
        touches: ['apps/api/src/app.ts', 'apps/api/src/features/snapshots/routes.ts'],
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
        id: 'plan-395:mint',
        planId: 'plan-395',
        slug: 'mint',
        seq: 3,
        title: 'Mint capabilities into the snapshot list',
        scope: 'The snapshot list payload that mints a capability per row, and the console row that opens it.',
        // A rejoin: it wires the signer's output into the route, so it waits for
        // *both* lanes to have merged rather than stacking on either.
        dependsOn: ['signer', 'route'],
        rationale:
          'Touches the console as well as the API, so it waits until both the signer and the route it points at exist.',
        acceptance:
          '- Every snapshot row in the console opens in a new tab without a 401.\n' +
          '- The payload carries a capability per row, and none for a snapshot whose file has been pruned.',
        touches: ['apps/api/src/features/snapshots/list.ts', 'apps/web/src/app/snapshots/page.tsx'],
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
    // deployment that has written one. Six checks, one of each interesting state:
    // passed by hand, amended out from under a reading, claimed by a desktop
    // session right now, run by the fleet, handed back, and reported from a
    // desktop session.
    validationChecks: [
      demoCheck({
        id: 'download-opens-in-a-new-tab',
        createdAt: ago(12),
        updatedAt: ago(12),
        letter: 'A',
        seq: 1,
        title: 'A snapshot download opens in a new tab with auth on',
        do: 'Run the console with `AUTH_ENABLED`, open /snapshots, and middle-click a download link.',
        expect: 'The file downloads. No 401, and no bearer token anywhere in the URL bar.',
        covers: ['route'],
        state: 'passed',
        resultNote: 'Opened last night’s handbook snapshot in a new tab — served straight through.',
        resultBy: 'operator',
        resultAt: ago(2),
      }),
      demoCheck({
        id: 'auth-off-still-serves',
        createdAt: ago(12),
        updatedAt: ago(12),
        letter: 'B',
        seq: 2,
        title: 'With auth off, snapshot downloads still serve',
        do: 'Set `AUTH_ENABLED` to false, restart the API, and open the same link.',
        expect: 'The file downloads with no capability in the URL at all.',
        covers: ['route'],
        // The case the amber band exists for, and the reason it is in the demo
        // rather than only in a test: somebody ran this, and then the check
        // stopped being the check they ran.
        amendedAt: ago(3),
        amendNote:
          'An agent working this goal amended the validation plan: the unsigned path now redirects rather ' +
          'than serving inline, so "no capability in the URL" was no longer the thing to look at.',
        revision: {
          title: 'With auth off, snapshot downloads still serve',
          do: 'Set `AUTH_ENABLED` to false, restart the API, and open the same link.',
          expect: 'The file downloads after one redirect.',
          state: 'passed',
          note: 'Redirected once and downloaded, as expected.',
        },
      }),
      demoCheck({
        id: 'tampered-capability-refused',
        createdAt: ago(12),
        updatedAt: ago(12),
        letter: 'C',
        seq: 3,
        title: 'A tampered capability is refused',
        do: 'Copy a download URL, change one character of the signature, and request it.',
        expect: 'A 403, and the snapshot is not served.',
        covers: ['signer'],
        fleetCandidate: true,
        candidateWhy: 'a plain HTTP request against a running API; needs no login and no browser',
        // Claimed right now by a desktop session, nine minutes in. In the demo
        // because the claim is otherwise unreachable by clicking — nothing in the
        // cockpit takes one — and because it is the whole of what the fleet
        // list's keyboard entry is drawn from: one person, one check, no
        // dispatch. The demo backend reports it two beats after load, which is
        // how the entry leaves again without anybody pressing anything.
        claimedBy: 'desktop (studio)',
        claimedAt: ago(9),
      }),
      // The two ends of a hand-over, both in the demo because neither is
      // reachable by clicking around: one check is with the fleet right now and
      // one came back. Between them they draw every marker the section has for
      // who runs a check.
      demoCheck({
        id: 'expired-capability-refused',
        createdAt: ago(12),
        updatedAt: ago(1),
        letter: 'D',
        seq: 4,
        title: 'An expired capability is refused',
        do: 'Mint a capability with a one-second lifetime, wait, and request the snapshot.',
        expect: 'A 403 naming expiry, and the snapshot is not served.',
        covers: ['signer'],
        fleetCandidate: true,
        candidateWhy: 'clock arithmetic and one request; nothing interactive',
        actor: 'fleet',
        state: 'passed',
        // Attributed, and that is the point of drawing it at all: "an agent says
        // this passed" is a weaker fact than "I ran it and it passed", and the
        // section must never let the second be read off the first.
        resultNote: 'Minted a 1s capability, slept 2s, requested it: 403 "capability expired". Snapshot not served.',
        resultBy: 'agent',
        resultAt: ago(1),
      }),
      demoCheck({
        id: 'download-reachable-on-mobile',
        createdAt: ago(12),
        updatedAt: ago(1),
        letter: 'E',
        seq: 5,
        title: 'The download link is reachable on a narrow viewport',
        do: 'Open /snapshots at 380px wide and tap a download link.',
        expect: 'The link is hittable and the file downloads.',
        covers: ['route'],
        // The answer that is neither a pass nor a failure, and the reason there
        // are three: this agent found nothing out about the goal, so recording
        // `failed` would have flagged it for something that is not about the code.
        handbackNote: 'An agent could not run this check: it needs a browser at a set viewport, and I have none.',
      }),
      // The hand-back's other ending: the operator's own Claude picked the same
      // kind of check up on a machine that *does* have a browser, and the row
      // says which of the three kinds of reader took the reading.
      demoCheck({
        id: 'proposal-sheet-scrolls-on-a-phone',
        createdAt: ago(12),
        updatedAt: ago(1),
        letter: 'F',
        seq: 6,
        title: 'The proposal review sheet scrolls cleanly on a phone',
        do: 'Open a proposal with a nine-file diff at 380px wide and scroll to the review controls.',
        expect: 'No horizontal scroll, and every hunk header is readable.',
        covers: ['route'],
        state: 'passed',
        resultNote: 'Drove it at 380px in Chrome: no horizontal overflow, every hunk header legible.',
        resultBy: 'desktop',
        resultAt: ago(1),
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
        title: 'Sweep docs/ for links that no longer resolve',
        prompt:
          'Check every relative link and code path referenced under docs/ still exists, fix the ones that moved and open a PR.',
        kind: 'code',
        cron: '0 9 * * 1',
        enabled: true,
        nextRunAt: null,
        lastFiredAt: new Date(now - 3 * 24 * 3_600_000).toISOString(),
        lastJobId: null,
        createdAt: new Date(now - 21 * 24 * 3_600_000).toISOString(),
        updatedAt: new Date(now - 3 * 24 * 3_600_000).toISOString(),
      },
    ],
    // Every list `/api/state` always ships, empty here because the demo has no
    // story for them: an orphan-free boot, no goal retained past its issue, and
    // no agent that surfaced an artifact or wrote a file. Present rather than
    // omitted because the wire sends them unconditionally — a demo that left them
    // out was a payload the real cockpit never receives.
    recovery: [],
    // A current build, which is the state the gauge is in almost always and the
    // one worth demonstrating: muted, in its fixed place, saying nothing. The demo
    // has no process to upgrade, so the panel behind it is a reading and no controls.
    build: {
      state: 'current',
      label: 'current',
      live: 0,
      upgradable: false,
      blocked: 'this build is current — there is nothing to take',
      supervised: false,
      standing: {
        head: '4f2a91c7e0d3b6a58f1c0e9d7b4a2c85f36e0d19',
        upstream: '4f2a91c7e0d3b6a58f1c0e9d7b4a2c85f36e0d19',
        behind: 0,
        ahead: 0,
        commits: [],
        dirty: false,
        branch: 'main',
        checkedAt: ago(12),
        unavailable: null,
      },
      intent: { state: 'idle', targetSha: null, requestedAt: null, pausedByDrain: false },
    },
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
        path: 'apps/api/src/config-holder.ts',
        sameWorktree: false,
        live: true,
        writers: [
          {
            agentId: 'agent-a2',
            taskId: 'task-a2',
            originRef: 'pr:409',
            originTitle: 'Read GitHub review decisions as proposal approval',
            branch: 'feature/review-decision',
            status: 'waiting',
            at: ago(2),
          },
          {
            agentId: 'agent-a1',
            taskId: 'task-a1',
            originRef: 'pr:412',
            originTitle: 'Cap the retrieval context at the token budget before ranking',
            branch: 'feature/context-budget',
            status: 'running',
            at: ago(6),
          },
        ],
      },
    ],
    // Empty for the same reason `canFileTickets` is false: the demo has no tracker
    // to raise a bug into, so a row here would be a link to nothing.
    bugFilings: [],
    // What agents filed for an operator — one of each kind, which is the whole
    // vocabulary (`report_finding`). Three are things noticed *outside* a task;
    // the `docs` one arrives from the other direction, which is why it is here.
    findings: [
      {
        id: 'find-1',
        agentId: 'agent-a1',
        taskId: 'task-a1',
        originRef: 'pr:412:ci',
        kind: 'out_of_scope',
        ref: null,
        summary: 'The RRF fold divides by the rank instead of (k + rank), so one list’s top hit swamps every other',
        where: 'packages/retrieval/src/rrf.ts:41',
        detail:
          'Not what I was sent to fix, but it is why `rrf.test.ts` fails once the context is capped — the ' +
          'cap only exposes it, because the swamped list used to be carried anyway.\n\n' +
          '```\n' +
          'score += 1 / rank        // 1, 0.5, 0.33 …\n' +
          'score += 1 / (k + rank)  // what the comment above it describes\n' +
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
        originRef: 'issue:376',
        kind: 'duplicate',
        ref: 'issue:318',
        summary: 'This asks for the same publisher seam as #318, which already has a merged design doc',
        where: null,
        detail: null,
        status: 'open',
        jobId: null,
        ticketRef: null,
        createdAt: ago(20),
        updatedAt: ago(20),
      },
      // A fact about the repository itself, learned *inside* the task rather than
      // beside it (#397). Its promote button says "Queue docs PR", because what
      // that click produces is a pull request against the worked repository's own
      // documentation and not a fix for the thing described.
      {
        id: 'find-5',
        agentId: 'agent-a2',
        taskId: 'task-a2',
        originRef: 'issue:376',
        kind: 'docs',
        ref: null,
        summary:
          'A new retriever must be registered in the factory *and* in the eval harness, or evals silently skip it',
        where: 'docs/architecture/retrieval.md',
        detail:
          'Cost me most of an afternoon: `RETRIEVERS` in `packages/retrieval/src/factory.ts` is what production ' +
          'reads, and `EVAL_TARGETS` in `eval/src/targets.ts` is a second list nothing checks against it. A ' +
          'retriever in only the first one works everywhere except the numbers you judge it by. Neither file ' +
          'mentions the other, and no document says there are two.',
        status: 'open',
        jobId: null,
        ticketRef: null,
        createdAt: ago(26),
        updatedAt: ago(26),
      },
      {
        id: 'find-3',
        agentId: 'agent-a0',
        taskId: 'task-a0',
        originRef: 'issue:364',
        kind: 'blocked',
        ref: 'issue:364',
        // Deliberately unsplit: a row filed before `where`/`detail` existed, so the
        // demo shows what the card does with one (clamps it, does not pretend).
        summary:
          'The real fix is in pg-boss’s published typings — the job’s `singletonKey` is on the wire but not in the declared result type, so the watcher cannot read it back without a cast. Nothing I can change from this repo.',
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
        originRef: 'pr:412:ci',
        kind: 'out_of_scope',
        ref: null,
        summary: 'POST /api/ask has no body-size limit, so a 40MB question is buffered before anything rejects it',
        where: 'apps/api/src/features/ask/routes.ts, the POST /api/ask handler',
        detail: 'Unrelated to the CI failure I was sent for. Reproduced with a 40MB body — RSS peaked at 1.1GB.',
        status: 'filed',
        jobId: 'job-filed-1',
        ticketRef: 'issue:346',
        createdAt: ago(64),
        updatedAt: ago(58),
      },
    ],
    // What working a goal taught about working the repository (#355). One of each
    // status, because the panel's whole claim is that the three are different
    // things: a claim waiting on a reader, one a human vouched for, and one that
    // stopped being true and was pruned — which is the state the surface exists for.
    lessons: [
      {
        id: 'lesn-1',
        text:
          'The console tests render against `web/dist`, so `npm run build:web` has to run before `npm run check` ' +
          'or they fail on a bundle from the last branch. The failure names a component, never the stale build.',
        originRef: 'issue:376',
        status: 'proposed',
        createdAt: ago(20),
        updatedAt: ago(20),
        rendered: false,
      },
      {
        id: 'lesn-2',
        text:
          'A ticket that only names a symptom (“search is slow”) is under-specified for a planner every time. ' +
          'Ask for the query, the corpus size and what “slow” was measured against before dispatching one.',
        originRef: 'issue:364',
        status: 'promoted',
        createdAt: ago(70),
        updatedAt: ago(66),
        rendered: true,
      },
      {
        // The other half of the marking, and the reason it is per row: vouched
        // for, older than the one above, and over the block's cap — so no agent
        // is reading it, and the only way to find that out is here (#355 phase 3).
        id: 'lesn-4',
        text:
          'The integration suite talks to a real Azure DevOps project, so a run from two branches at once ' +
          'trips over the same work items. Take the lock in `scripts/devops-lock.sh` before you start one.',
        originRef: 'issue:301',
        status: 'promoted',
        createdAt: ago(300),
        updatedAt: ago(280),
        rendered: false,
      },
      {
        // Retired rather than deleted, and drawn: the operator has to be able to
        // see that the list they are reading is the whole list.
        id: 'lesn-3',
        text: 'Run the retrieval suite with `--runInBand` — the fixtures share a Postgres schema and trample each other.',
        originRef: 'issue:318',
        status: 'retired',
        createdAt: ago(400),
        updatedAt: ago(90),
        rendered: false,
      },
    ],
    // What the fleet knows about working this repository (#27 phase 2). One of
    // each reach, because the page's whole claim is that reach is a state machine
    // and not a label: a live notice on its clock, a corroborated claim waiting on
    // the operator, one they vouched for, one they parked on lookup, a single
    // voice nothing has agreed with, and one they killed — which is the row that
    // shows the surface draws what it stopped.
    knowledge: [
      {
        id: 'fact-notice',
        claim:
          '`test (windows)` has been timing out at the dependency-install step since about 09:00 — the same commit ' +
          'passes on a re-run roughly half the time.',
        scope: 'check:test (windows)',
        lifetime: 'expiring',
        expiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
        // Injected with no ruling on it: a notice, and the one thing two agents
        // agreeing can put in front of the whole fleet (#27 phase 4). What makes
        // that safe is the clock, which is why the row draws it.
        reach: 'injected',
        supersedes: null,
        originRef: 'pr:412',
        ruledAt: null,
        resolvesWhen: null,
        createdAt: ago(3),
        updatedAt: ago(1),
        corroborations: 2,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        // Nobody has asked for a notice and nobody would: it is already in front
        // of every agent. The ask count is the reading a `lookup` claim has and an
        // injected one cannot.
        asks: 0,
        lastAskedAt: null,
        scopeStale: false,
        scopeLastMatchedAt: ago(3),
      },
      {
        // The harness's own, and the other half of phase 4: it read this rather
        // than being told it, so it corroborates for itself — and it carries a
        // condition, because a red base branch has a green to wait for. The clock
        // is the backstop.
        id: 'fact-base-red',
        claim:
          'The check `check (build)` is failing on branch `feat/catalog-cutover`, which one or more open pull requests are based on.',
        scope: 'check:check (build)',
        lifetime: 'expiring',
        expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
        reach: 'injected',
        supersedes: null,
        originRef: 'pr:404',
        ruledAt: null,
        resolvesWhen: { kind: 'ci-check-green', ref: 'pr:404', check: 'check (build)' },
        createdAt: ago(2),
        updatedAt: ago(2),
        corroborations: 2,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 0,
        lastAskedAt: null,
        scopeStale: false,
        scopeLastMatchedAt: ago(2),
      },
      {
        id: 'fact-needsyou',
        claim:
          'The console tests render against `web/dist`, so `npm run build:web` has to run before `npm run check` — ' +
          'the failure names a component and never the stale bundle.',
        scope: 'fleet',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'lookup',
        supersedes: null,
        originRef: 'issue:376',
        ruledAt: null,
        resolvesWhen: null,
        createdAt: ago(30),
        updatedAt: ago(6),
        corroborations: 2,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 4,
        lastAskedAt: ago(5),
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
      {
        id: 'fact-injected',
        claim: 'A ticket that only names a symptom is under-specified for a planner every time.',
        scope: 'fleet',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'injected',
        supersedes: null,
        originRef: 'issue:364',
        ruledAt: ago(60),
        resolvesWhen: null,
        createdAt: ago(70),
        updatedAt: ago(60),
        corroborations: 3,
        // Disputed, and still injected — which is the whole of what a
        // contradiction does (#27 phase 5). Three agents vouched for this claim
        // and a fourth found the edge it is wrong at; nothing about that demoted
        // it, because a claim right in general and wrong at one edge attracts
        // contradictions *because it is being used*. What the fleet gets out of
        // the disagreement is the sharper claim below, not one fewer claim.
        contradictions: 1,
        contradictionRatio: 0.25,
        openContradictions: 1,
        asks: 0,
        lastAskedAt: null,
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
      {
        // The amendment, filed by the agent that contradicted the claim above and
        // naming it in `supersedes`. It contains the sentence it sharpens — that
        // is what amending is — which is exactly why superseding the original is
        // not rejecting it: a rejection would bar these words too.
        id: 'fact-amendment',
        claim:
          'A ticket that only names a symptom is under-specified for a planner every time — unless it names the ' +
          'check that fails, which is enough for a planner to reproduce it and plan from there.',
        scope: 'fleet',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'proposal',
        supersedes: 'fact-injected',
        originRef: 'issue:390',
        ruledAt: null,
        resolvesWhen: null,
        createdAt: ago(4),
        updatedAt: ago(4),
        corroborations: 1,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 0,
        lastAskedAt: null,
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
      {
        id: 'fact-lookup',
        claim: 'The seed script leaves two orphaned catalog rows behind; the fixture reset clears them.',
        scope: 'fleet',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'lookup',
        supersedes: null,
        originRef: 'issue:341',
        ruledAt: ago(48),
        resolvesWhen: null,
        createdAt: ago(96),
        updatedAt: ago(48),
        corroborations: 2,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        // Eleven asks over its life: the claim nobody vouched for and the fleet
        // keeps wanting anyway. A reading and never a trigger — nothing here was
        // promoted by it, and the operator is who decides whether it should be.
        asks: 11,
        lastAskedAt: ago(7),
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
      {
        // A check scope that has drifted (#27 phase 7). The job was renamed when
        // the matrix moved to `windows-latest`, so nothing matches this scope any
        // more: the claim is not delivered on any dispatch, no error was raised,
        // and the row would otherwise look exactly like a claim nobody has needed.
        // Nothing was demoted by the reading — it is still on lookup, and only the
        // operator will move it.
        id: 'fact-stale-scope',
        claim:
          'The Windows leg needs `npm ci` before the native rebuild — `better-sqlite3` links against the wrong ' +
          'Python otherwise, and the failure names the compiler rather than the install.',
        scope: 'check:test (windows-2019)',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'lookup',
        supersedes: null,
        originRef: 'pr:377',
        ruledAt: ago(24 * 51),
        resolvesWhen: null,
        createdAt: ago(24 * 58),
        updatedAt: ago(24 * 51),
        corroborations: 2,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 0,
        lastAskedAt: null,
        scopeStale: true,
        scopeLastMatchedAt: ago(24 * 47),
      },
      {
        // Goal-scoped and on lookup, which is the other prompt: it never rides the
        // block — a claim about one goal is a claim most of the fleet cannot see —
        // and it is appended to the task prompt of that goal's own dispatches.
        id: 'fact-goal',
        claim:
          'The cutover migration has to run before the seed script on this goal — the seed fails with a missing ' +
          'enum value otherwise, and the error names the table rather than the migration.',
        scope: 'goal:issue:390',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'lookup',
        supersedes: null,
        originRef: 'issue:390',
        ruledAt: ago(20),
        resolvesWhen: null,
        createdAt: ago(26),
        updatedAt: ago(20),
        corroborations: 2,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 3,
        lastAskedAt: ago(19),
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
      {
        id: 'fact-proposal',
        claim: 'The ingest worker holds its Postgres connection open across retries, so a restart is what clears it.',
        scope: 'goal:issue:390',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'proposal',
        supersedes: null,
        originRef: 'issue:390',
        ruledAt: null,
        resolvesWhen: null,
        createdAt: ago(9),
        updatedAt: ago(9),
        corroborations: 1,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 0,
        lastAskedAt: null,
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
      {
        // Committed, and therefore out of every prompt (#27 phase 6): the claim is
        // in the repository now, so an agent reads it there and keeping it injected
        // would pay context twice for one sentence. It reached this reach when the
        // pull request below actually merged — never when the work was queued.
        id: 'fact-committed',
        claim:
          'A route handler never reads the request: it is wrapped in `checked(schemas, handler)` and handed the ' +
          'parsed body, and a refusal is a returned 400 rather than a throw.',
        scope: 'fleet',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'committed',
        supersedes: null,
        originRef: 'issue:341',
        ruledAt: ago(150),
        resolvesWhen: null,
        createdAt: ago(400),
        updatedAt: ago(150),
        corroborations: 3,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        // Committed, so out of every prompt — and the ask count with it: nothing
        // answers an ask with a committed claim, because the repository does.
        asks: 0,
        lastAskedAt: null,
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
      {
        id: 'fact-rejected',
        claim: 'The dispatcher reads the lessons table before it ranks anything.',
        scope: 'fleet',
        lifetime: 'standing',
        expiresAt: null,
        reach: 'rejected',
        supersedes: null,
        originRef: 'issue:355',
        ruledAt: ago(120),
        resolvesWhen: null,
        createdAt: ago(140),
        updatedAt: ago(120),
        corroborations: 1,
        contradictions: 0,
        contradictionRatio: 0,
        openContradictions: 0,
        asks: 0,
        lastAskedAt: null,
        scopeStale: false,
        scopeLastMatchedAt: null,
      },
    ],
    // Every attempt to put a claim in the repository (#27 phase 6). Two, because
    // the interesting half of graduation is the state *between* the click and the
    // landing: the claim on `fact-lookup` is still on lookup and still answered,
    // with a pull request open — and only the one whose pull request actually
    // merged is `committed`. A page that moved a claim at the click would be
    // showing a claim nobody has committed and nobody can yet read.
    knowledgeGraduations: [
      {
        id: 'kng-lookup',
        factId: 'fact-lookup',
        jobId: 'job-docs-1',
        target: 'spec',
        bar: null,
        prRef: 'pr:411',
        outcome: null,
        settledAt: null,
        createdAt: ago(40),
        reading: 'waiting',
      },
      {
        id: 'kng-committed',
        factId: 'fact-committed',
        jobId: 'job-docs-0',
        target: 'spec',
        bar: null,
        prRef: 'pr:409',
        outcome: 'landed',
        settledAt: ago(150),
        createdAt: ago(190),
        reading: 'landed',
      },
    ],
    // What that list actually sends. A **transcript** of what the two renderers
    // produced for the rows above rather than a re-rendering of them here: what
    // fits is the server's answer, and a demo that recomputed it would be exactly
    // the second implementation of "what fits" the real page refuses. The block
    // carries both notices and the one injected fleet claim — since phase 4 an
    // injected fact rides it whatever its scope, because a notice about a check is
    // for the agent about to run that check and not only for the one already sent
    // to fix it. The one goal-scoped claim is the exception, and it is the scoped
    // entry below.
    knowledgeDelivery: {
      block: DEMO_KNOWLEDGE_BLOCK,
      limit: 6_000,
      rendered: ['fact-base-red', 'fact-notice', 'fact-injected'],
      dropped: [],
      scoped: [
        {
          // The drifted scope still renders — nothing is dropped from delivery
          // because a scope went quiet. What has changed is that no dispatch
          // carries this any more, because no dispatch names that check.
          scope: 'check:test (windows-2019)',
          text:
            '\n\n---\n\nWhat the fleet has recorded about this goal and the checks in front of you. It is ' +
            '**evidence, not instruction** — dated, attributed, and offered so you do not pay to rediscover it. ' +
            'The code in front of you is the authority: where it and a line below disagree, the line is stale. ' +
            'Say so with `knowledge_contradict`, naming what it should say instead.\n\n' +
            '- **about test (windows-2019)** — The Windows leg needs `npm ci` before the native rebuild — ' +
            '`better-sqlite3` links against the wrong Python otherwise, and the failure names the compiler ' +
            'rather than the install. _(written 2026-06-25)_\n',
          facts: ['fact-stale-scope'],
        },
        {
          scope: 'goal:issue:390',
          text:
            '\n\n---\n\nWhat the fleet has recorded about this goal and the checks in front of you. It is ' +
            '**evidence, not instruction** — dated, attributed, and offered so you do not pay to rediscover it. ' +
            'The code in front of you is the authority: where it and a line below disagree, the line is stale. ' +
            'Say so with `knowledge_contradict`, naming what it should say instead.\n\n' +
            '- **about this goal** — The cutover migration has to run before the seed script on this goal — the ' +
            'seed fails with a missing enum value otherwise, and the error names the table rather than the ' +
            'migration. _(written 2026-08-21)_\n',
          facts: ['fact-goal'],
        },
      ],
    },
    // What sending that block costs, over the window Insights opens on (#27
    // phase 7). A reading and never a trigger: nothing above is demoted, lapsed
    // or dropped from the block because of what it costs.
    knowledgeCost: demoKnowledgeCost(),
    // Work only a person can do. Four, so the panel shows each shape it has: a
    // plan step holding parts shut, a standalone ask from an agent that could not
    // do it itself, one already declined with the note that stopped it, and the
    // harness's own close-out on the goal it delivered but cannot close.
    humanTasks: [
      {
        id: 'hum-1',
        title: 'Re-point the staging watchers at the new queue names',
        detail:
          'Hosting dashboard → the two `magpie-watcher` services → Environment.\n\n' +
          '- Set `JOB_QUEUE_PREFIX` to the catalog’s\n' +
          '- Redeploy both, then check the console reports two watchers connected\n\n' +
          'Done when both staging watchers claim jobs from the catalog’s queue names. Nobody gave the fleet ' +
          'dashboard credentials, and nobody should.',
        originRef: 'issue:390:part:cutover',
        partId: 'plan-390:cutover',
        kind: 'ask',
        agentId: null,
        taskId: null,
        status: 'open',
        createdAt: ago(18),
        updatedAt: ago(18),
        resolution: null,
        resolvedAt: null,
        dismissedAt: null,
      },
      {
        id: 'hum-2',
        title: 'Judge whether the truncated-context notice reads as an error on a real phone',
        detail:
          'When the budget cuts the context I show "answered from 8 of 23 sections". I can render it and ' +
          'diff the DOM, but not judge whether that reads as a warning at 375px. Screenshot attached to the PR.',
        originRef: 'pr:412',
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
        title: 'Rotate the GitHub App private key',
        detail: null,
        originRef: 'issue:364',
        partId: null,
        kind: 'ask',
        agentId: 'agent-a0',
        taskId: 'task-a0',
        status: 'declined',
        resolution: 'Not until the catalog migration lands — rotating now stops the publisher mid-flight.',
        createdAt: ago(72),
        updatedAt: ago(52),
        resolvedAt: ago(52),
        dismissedAt: null,
      },
      {
        // The harness's own, on the goal it delivered at #364 and cannot close.
        // Nobody asked for it — no agent, no operator — which is what a
        // `close_out` with a null `agentId` says, and it settles itself as soon as
        // the tracker stops listing the item open.
        id: 'hum-4',
        title: 'Close issue #364 in the tracker',
        detail:
          'The assessor marked **Document the two-watcher requirement for maintenance jobs** delivered — ' +
          '"PR #410 landed the deadlock note and the console warning with it."\n\n' +
          'The item is still open in the tracker. Close it there and this settles itself on the ' +
          'next pulse — or mark it done here, or decline it and say why.',
        originRef: 'issue:364',
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
        cwd: '/work/magpie-412',
        pid: 4821,
        waitingReason: null,
        sessionId: null,
        startedAt: ago(8),
        endedAt: null,
        costUsd: 0.84,
        inputTokens: 412_000,
        outputTokens: 18_400,
        cacheReadTokens: 331_000,
        cacheCreationTokens: 24_000,
        numTurns: 3,
        note: 'Cutting the ranked list to the budget before the prompt is built, not after',
        notedAt: ago(3),
        resumedAt: null,
        resumeAttempts: 0,
      },
      {
        id: 'agent-a2',
        taskId: 'task-a2',
        status: 'waiting',
        cwd: '/work/magpie-409',
        pid: 4899,
        waitingReason: 'Rebase hit a conflict in review-decision.ts — resolve which side wins?',
        sessionId: null,
        startedAt: ago(4),
        endedAt: null,
        costUsd: 0.31,
        inputTokens: 168_000,
        outputTokens: 6_200,
        cacheReadTokens: 121_000,
        cacheCreationTokens: 9_400,
        numTurns: 2,
        note: 'Rebasing onto main — three files conflict, working through them in order',
        notedAt: ago(9),
        // Asked, then carried on regardless: the demo's one stale alert, so the
        // "agent resumed" chip and Dismiss have something to act on.
        resumedAt: ago(2),
        resumeAttempts: 0,
      },
      {
        id: 'agent-a0',
        taskId: 'task-a0',
        status: 'done',
        cwd: '/work/magpie-364',
        pid: null,
        waitingReason: null,
        sessionId: null,
        startedAt: ago(140),
        endedAt: ago(100),
        costUsd: 2.17,
        inputTokens: 1_240_000,
        outputTokens: 54_000,
        cacheReadTokens: 975_000,
        cacheCreationTokens: 71_000,
        numTurns: 9,
        // A finished agent keeps its last note: the one-line summary of the run.
        note: 'Suite green, PR opened',
        notedAt: ago(100),
        resumedAt: null,
        resumeAttempts: 0,
      },
    ],
    // Nobody in the demo world is out of account limit. The key is here rather
    // than absent because the wire always ships it, and a surface that has never
    // seen the empty case is one that renders it wrong the first time it happens.
    parkedOnLimit: [],
    // Nor is anybody stopped without saying why. Present-and-empty for
    // `parkedOnLimit`'s reason: the wire always ships it, and the empty case is the
    // one a surface renders wrong if it has never seen it.
    stallParks: [],
    // The act behind the drafted-reply escalation below. It is what turns that
    // card from "type something" into "approve & send / reject": the draft was
    // written, and nothing goes out until you say so.
    proposals: [
      {
        id: 'prop-1',
        kind: 'reply_draft',
        ref: 'pr:412:comment:c-1',
        status: 'pending',
        action: {
          type: 'reply_on_pr',
          reason: 'reviewer asked whether the budget is per-flow',
          prNumber: 412,
          commentId: 'c-1',
          draft:
            'Good call — the budget is read per flow now (`contextTokenBudget` on the flow config, falling back to the global `RETRIEVAL_CONTEXT_TOKENS`), so the runbook flow can keep its bigger window. Pushed as a fixup.',
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
        ref: 'issue:395:plan',
        status: 'pending',
        action: {
          type: 'propose_plan',
          reason: 'Issue #395 was decomposed into 3 part(s) and approval is required before any is scheduled.',
          planId: 'plan-395',
          originRef: 'issue:395',
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
        // response to the reviewer's comment on #412 but wasn't confident enough
        // to send it unattended, so it escalates for approval (the "Draft reply"
        // panel + approve flow).
        id: 'esc-2',
        type: 'review_reply',
        status: 'open',
        prompt:
          'Draft reply for PR #412:\n\nGood call — the budget is read per flow now (`contextTokenBudget` on the flow config, falling back to the global `RETRIEVAL_CONTEXT_TOKENS`), so the runbook flow can keep its bigger window. Pushed as a fixup.',
        context: {
          taskTitle: 'Fix failing CI on PR #412',
          originRef: 'pr:412',
          prNumber: 412,
          commentId: 'c-1',
          draft:
            'Good call — the budget is read per flow now (`contextTokenBudget` on the flow config, falling back to the global `RETRIEVAL_CONTEXT_TOKENS`), so the runbook flow can keep its bigger window. Pushed as a fixup.',
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
          'There is a plan for issue #395 ("Snapshot downloads 401 in the review console") and nothing is ' +
          'scheduled until you approve it — 3 pull requests of work.\n\n' +
          'Why this shape: split on the seams the tests already draw; one PR would put the signer and the ' +
          'guard change in the same review.',
        context: {
          originRef: 'issue:395',
          planId: 'plan-395',
          // Whose words these are, said rather than guessed at. A plan approval
          // has no agent behind it and is not an assessment, so a card deriving
          // the label from "no agent" would caption a planner's decomposition as
          // an assessor's finding.
          detailFrom: 'What the plan says',
          // What it found and what it will do about it — not the split, which is
          // drawn in the plan panel the card's own button opens. Markdown, so the
          // demo shows the rendered path rather than the grey block it used to be.
          detail:
            "**What's wrong**\n\n" +
            'The snapshot download route sits inside the `/api` prefix the console guards with a bearer token, ' +
            'and clicking a download link is a top-level navigation — which cannot carry an `Authorization` ' +
            'header. The route has never been reachable the way it is reached.\n\n' +
            "**What we'll do**\n\n" +
            'Move the route out from behind the prefix guard and gate it on a short-lived signed capability ' +
            'minted into the snapshot list beside each row. The URL carries its own proof, so a plain ' +
            'navigation works and nothing else moves outside the guard.',
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
          taskTitle: 'Discuss the plan for issue #395',
          originRef: 'issue:395',
          questions: [
            {
              question: 'Part two is fat — split it, or leave it as one?',
              detail:
                'The guard move, the capability check and the two-mode arm are one review. The riskiest bit ' +
                '(the window in which the route serves unguarded) is buried in the middle of it.',
              options: ['Split into two parts', 'Keep it as one'],
            },
            {
              question: 'Should the unauthenticated arm serve, or 404?',
              detail:
                'With `AUTH_ENABLED` off there is no signing key. Serving everything matches what the operator ' +
                'already chose by turning auth off; 404 is the safer default and a surprise.',
              options: ['Serve everything', '404 the route'],
            },
            { question: 'Capability in the query string, or a path segment?' },
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
        prompt: 'Rebase hit a conflict in review-decision.ts — resolve which side wins?',
        context: {
          taskTitle: 'Rebase PR #409 on main',
          originRef: 'pr:409',
          recentOutput: 'CONFLICT (content): Merge conflict in packages/git/src/review-decision.ts',
          prNumber: 409,
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
          'An assessment of issue #382 ("Gap clustering merges unrelated questions") found the work done and ' +
          'the goal still not reached, and the issue itself to be what is wrong — no planner and no agent can ' +
          'fix a goal, so nothing has been dispatched and nothing will be.',
        context: {
          taskTitle: 'Gap clustering merges unrelated questions into one gap',
          originRef: 'issue:382:shortfall',
          issueNumber: 382,
          detailFrom: 'What the assessor found',
          detail:
            '**The threshold moved and the two example questions now cluster apart. The goal asks for ' +
            'clusters that are about one thing, and no threshold decides that.**\n\n' +
            '## Present\n\n' +
            'PR #405 raised the cosine threshold from 0.72 to 0.81 and added the two questions from the ' +
            'issue as a regression test. They cluster apart. The test passes.\n\n' +
            '## Missing\n\n' +
            '- Three other pairs in the same corpus still merge at 0.81, and lowering it far enough to split ' +
            'them splits the pairs that *should* merge.\n' +
            '- Nothing in the clusterer reads what a question is *about* — only how its embedding sits ' +
            'against another’s. A threshold is the wrong instrument for the stated goal.\n\n' +
            '## Why the goal, and not the plan\n\n' +
            'The part delivered exactly the scope it declared. The issue asks for clusters that are "about ' +
            'one thing"; a planner handed this back would tune the same number again. Someone has to say ' +
            'whether that means topic labelling, a second pass over the cluster, or simply a better number.',
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
        action: { type: 'reply_on_pr', reason: 'reviewer asked for a per-flow budget on #412' },
        subjectRef: 'pr:412',
        outcome: 'executed',
        detail: 'Drafted a reply and escalated for approval (confidence 0.62 below threshold)',
        rule: null,
        admission: null,
        createdAt: ago(1),
      },
      {
        id: 'dec-3',
        cycleId: 'cycle-102',
        action: { type: 'dispatch_code_agent', reason: 'PR #412 CI is failing' },
        subjectRef: 'pr:412:ci',
        outcome: 'executed',
        detail: 'Dispatched agent onto feature/context-budget',
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
        detail: 'Rebase conflict on PR #409 needs a call',
        rule: 'pr-base-update',
        admission: null,
        createdAt: ago(2),
      },
      {
        id: 'dec-1',
        cycleId: 'cycle-98',
        action: { type: 'merge_pr', reason: 'PR #411 is merge-ready' },
        subjectRef: 'pr:411',
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
    // A fleet with more work than slots — the state the harness is *for*, so the
    // demo shows the band at rest rather than mid-alarm. The queued figure is
    // above the reservoir deliberately: a demo whose headline reading is a
    // warning teaches the warning as the normal case.
    runway: {
      state: 'healthy',
      runwayMinutes: 187,
      inflight: 3,
      queued: 11,
      reservoir: 4,
      reservoirContainers: 1,
      held: 2,
      latent: { plans: 0, profiles: 0, escalated: 0, parts: 0 },
      debt: 2,
      medianLeadMinutes: 40,
      medianHeldMinutes: 95,
      completedRuns: 47,
      idleSlots: 0,
      headline: 'About 3h 7m of work queued',
      detail: '3 in flight, 11 waiting.',
    },
    upcoming: {
      cycleId: 'cycle-103',
      at: ago(0),
      items: [
        {
          origin: 'issue:341',
          rule: 'issue-pickup',
          title: 'Resolve issue #341',
          kind: 'code',
          branch: 'issue/341',
          status: 'dispatching',
          reason: 'Open issue #341 has no linked PR and no agent is on it.',
          // What the row will launch on, resolved from `agentModels.byRule` — the
          // ordinary case, and the one the panel has to state for the queue to
          // answer "which profile" at all.
          profile: 'standard',
          profileSource: 'rule',
        },
        {
          // Held by the plan's own concurrency cap rather than by fleet headroom —
          // a free slot wouldn't start it, which is why it says `capped` and not
          // `waiting`, and why it is queued at all rather than skipped in silence.
          origin: 'issue:390:part:watcher',
          rule: 'plan-part',
          title: 'Issue #390 part: Route the watcher’s job intake through the catalog',
          kind: 'code',
          branch: 'issue/390/watcher',
          status: 'capped',
          reason:
            'Part "watcher" of issue #390 is ready and stacks on issue/390/validate. Held: issue #390 is already at its 2-part concurrency cap.',
          // Priced by the operator from this very panel: mechanical work they
          // could see was mechanical. A held row is priced too — "what will it
          // cost when it runs" is exactly the question being asked of it.
          profile: 'fast',
          profileSource: 'pin',
          override: 'fast',
        },
        {
          // Queued but held, same as `watcher` above — this time by the plan's own
          // awaiting_approval status rather than a concurrency cap.
          origin: 'issue:395:part:signer',
          rule: 'plan-part',
          title: 'Issue #395 part: Add the download capability signer',
          kind: 'code',
          branch: 'issue/395/signer',
          status: 'unapproved',
          reason:
            'Part "signer" of issue #395 is ready and has no agent. Held: the plan for issue #395 is awaiting your approval — nothing is scheduled until you accept it.',
          // The plan named this part deep, and nothing has overridden it: the
          // picker reads "Pinned (deep)" rather than offering the fleet default.
          profile: 'deep',
          profileSource: 'pin',
        },
        {
          origin: 'issue:395:part:route',
          rule: 'plan-part',
          title: 'Issue #395 part: Move the download route outside /api and require the capability',
          kind: 'code',
          branch: 'issue/395/route',
          status: 'unapproved',
          reason:
            'Part "route" of issue #395 is ready and stacks on issue/395/signer. Held: the plan for issue #395 is awaiting your approval — nothing is scheduled until you accept it.',
          profile: 'standard',
          profileSource: 'default',
        },
      ],
    },
    errors: [
      {
        id: 'err-2',
        source: 'agent',
        message: 'Agent agent-a0 failed (task task-a0), exit code 1',
        detail: 'npm test\n✗ retrieval › the context fits the budget\nProcess exited with code 1',
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
      { id: 'we-5', kind: 'pr_ci', ref: 'pr:412', summary: 'CI failing on PR #412', createdAt: ago(8) },
      { id: 'we-4', kind: 'pr_comment', ref: 'pr:412', summary: 'reviewer commented on PR #412', createdAt: ago(7) },
      { id: 'we-3', kind: 'pr_approved', ref: 'pr:411', summary: 'PR #411 approved', createdAt: ago(9) },
      { id: 'we-2', kind: 'issue_opened', ref: 'issue:341', summary: 'Issue #341 opened', createdAt: ago(15) },
      { id: 'we-1', kind: 'pr_merged', ref: 'pr:406', summary: 'PR #406 merged', createdAt: ago(30) },
    ],
    // Ref → URL map the real provider builds; canned here so the demo's issue/PR
    // references render as clickable links, keyed by how they appear in the UI (`#N`).
    refUrls: {
      '#412': 'https://github.com/example/markdown-magpie/pull/412',
      '#411': 'https://github.com/example/markdown-magpie/pull/411',
      '#409': 'https://github.com/example/markdown-magpie/pull/409',
      '#413': 'https://github.com/example/markdown-magpie/pull/413',
      '#410': 'https://github.com/example/markdown-magpie/pull/410',
      '#406': 'https://github.com/example/markdown-magpie/pull/406',
      '#405': 'https://github.com/example/markdown-magpie/pull/405',
      '#300': 'https://github.com/example/markdown-magpie/issues/300',
      '#332': 'https://github.com/example/markdown-magpie/issues/332',
      '#333': 'https://github.com/example/markdown-magpie/issues/333',
      '#341': 'https://github.com/example/markdown-magpie/issues/341',
      '#345': 'https://github.com/example/markdown-magpie/issues/345',
      '#357': 'https://github.com/example/markdown-magpie/issues/357',
      '#359': 'https://github.com/example/markdown-magpie/issues/359',
      '#364': 'https://github.com/example/markdown-magpie/issues/364',
      '#368': 'https://github.com/example/markdown-magpie/issues/368',
      '#371': 'https://github.com/example/markdown-magpie/issues/371',
      '#379': 'https://github.com/example/markdown-magpie/issues/379',
      '#382': 'https://github.com/example/markdown-magpie/issues/382',
      '#388': 'https://github.com/example/markdown-magpie/issues/388',
      '#390': 'https://github.com/example/markdown-magpie/issues/390',
      '#395': 'https://github.com/example/markdown-magpie/issues/395',
      // The two comments the harness maintains on a ticket by itself, keyed by the
      // canonical ref the snapshot ships and anchored the way the provider builds
      // them. Absent from this map ⇒ the cockpit draws no way in at all.
      'issue:390:comment:8391': 'https://github.com/example/markdown-magpie/issues/390#issuecomment-8391',
      'issue:379:comment:8402': 'https://github.com/example/markdown-magpie/issues/379#issuecomment-8402',
      // The colon form, which is what the harness speaks: a part's ref, a job's
      // origin, an agent's origin and a decision's subject are all structured refs,
      // and the `#n` keys above answer none of them. The server keys both families
      // for the same items (see `buildRefUrls`), so the demo does too — otherwise
      // the Pages build is the one place every new link renders as plain text.
      'issue:341': 'https://github.com/example/markdown-magpie/issues/341',
      'issue:364': 'https://github.com/example/markdown-magpie/issues/364',
      'issue:371': 'https://github.com/example/markdown-magpie/issues/371',
      'issue:379': 'https://github.com/example/markdown-magpie/issues/379',
      'issue:382': 'https://github.com/example/markdown-magpie/issues/382',
      'issue:390': 'https://github.com/example/markdown-magpie/issues/390',
      'issue:395': 'https://github.com/example/markdown-magpie/issues/395',
      'issue:390:part:watcher': 'https://github.com/example/markdown-magpie/issues/390',
      'issue:395:part:route': 'https://github.com/example/markdown-magpie/issues/395',
      'issue:395:part:signer': 'https://github.com/example/markdown-magpie/issues/395',
      'pr:409': 'https://github.com/example/markdown-magpie/pull/409',
      'pr:411': 'https://github.com/example/markdown-magpie/pull/411',
      'pr:412': 'https://github.com/example/markdown-magpie/pull/412',
      'pr:412:ci': 'https://github.com/example/markdown-magpie/pull/412/checks',
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
    // Real `renderBlocks` output, markers intact — stamps included — so the demo
    // exercises the drawer's collapsed tool blocks rather than only plain prose. The
    // times are literals like every other demo value: nothing here reads a clock.
    'agent-a1': [
      'Reading feature/context-budget — the failing case is a question that matches every section.\n',
      '\x1b[2m[10:14:02]\x1b[0m \x1b[36m⚙ Bash\x1b[0m \x1b[2mnpm test -w packages/retrieval\x1b[0m\n',
      '\n',
      '\x1b[31m  ↳ error\x1b[0m\x1b[2m [10:14:51]\x1b[0m\x1b[2m · 5 lines\x1b[0m\n',
      '  ✗ retrieval › the context fits the budget\n',
      '    Expected 8000, got 21440\n',
      '    at index.test.ts:118\n',
      '  \n',
      '  1 failing, 82 passing\n',
      'So the cut is applied after the prompt is assembled, not before. Let me read the fold.\n',
      '\x1b[2m[10:15:07]\x1b[0m \x1b[36m⚙ Read\x1b[0m \x1b[2mpackages/retrieval/src/index.ts\x1b[0m\n',
      '\n',
      '\x1b[90m  ↳ result\x1b[0m\x1b[2m [10:15:08]\x1b[0m\x1b[2m · 18 lines\x1b[0m\n',
      '  30	  const chosen = ranked.slice(0, topK);\n',
      '  31	  const chosen = ranked.slice(0, topK);\n',
      '  32	  const chosen = ranked.slice(0, topK);\n',
      '  33	  const chosen = ranked.slice(0, topK);\n',
      '  34	  const chosen = ranked.slice(0, topK);\n',
      '  35	  const chosen = ranked.slice(0, topK);\n',
      '  36	  const chosen = ranked.slice(0, topK);\n',
      '  37	  const chosen = ranked.slice(0, topK);\n',
      '  38	  const chosen = ranked.slice(0, topK);\n',
      '  39	  const chosen = ranked.slice(0, topK);\n',
      '  40	  const chosen = ranked.slice(0, topK);\n',
      '  41	  const chosen = ranked.slice(0, topK);\n',
      '  42	  const chosen = ranked.slice(0, topK);\n',
      '  43	  const chosen = ranked.slice(0, topK);\n',
      '  44	  const chosen = ranked.slice(0, topK);\n',
      '  45	  const chosen = ranked.slice(0, topK);\n',
      '  46	  const chosen = ranked.slice(0, topK);\n',
      '  47	  const chosen = ranked.slice(0, topK);\n',
      '`topK` counts sections, not tokens — a section can be 4k on its own. Patching.\n',
    ].join(''),
    'agent-a2': [
      '$ claude --resume rebase-409',
      'git fetch origin main',
      'git rebase origin/main',
      'CONFLICT (content): Merge conflict in packages/git/src/review-decision.ts',
      'Both sides changed reviewDecisionToApproval. Need a human call.',
      '@@LUBBDUBB_WAITING: which mapping wins?@@',
    ].join('\n'),
    'agent-a0': [
      '$ claude implement-364',
      'Added "Why maintenance jobs need two watchers" to docs/architecture.md',
      'npm run build && npm test … all green',
      'git push && opened PR #410',
      '@@LUBBDUBB_DONE@@',
    ].join('\n'),
  };

  // Where the local run could be pointed, and what has happened on each of those
  // branches. **Restated, not imported** — the demo has no server to ask, the same
  // reason the questionnaire fold above is restated. It mirrors `localRunChoices`
  // and `localRunRefFacts` in `src/`: the tip of the stack is the furthest-along part
  // with a branch, and the pull request is the one on *that branch* and never one
  // borrowed from elsewhere on the goal.
  const stale = (status: PlanPart['status']): boolean =>
    status === 'merged' || status === 'retired' || status === 'concluded';
  const allPrs: PullRequest[] = [...state.world.pullRequests, ...(state.world.closedPullRequests ?? [])];
  state.localRunTargets = state.world.issues.map((issue) => {
    const origin = `issue:${String(issue.number)}`;
    const plan = state.plans.find((p) => p.originRef === origin);
    const parts = plan
      ? state.planParts.filter((p) => p.planId === plan.id).sort((a, b) => a.seq - b.seq)
      : ([] as PlanPartView[]);
    const branched = parts.filter((p) => p.branch !== null && p.branch !== '');
    const tip = [...branched].reverse().find((p) => !stale(p.status)) ?? null;
    // The goal's own branch, the way `openPrForIssue` finds it: the conventional
    // name, or whatever its linked pull request is on. A goal nobody decomposed has
    // its whole work there.
    const ownPr =
      state.world.pullRequests.find(
        (r) => r.merged !== true && (r.number === issue.linkedPrNumber || r.branch === `issue/${String(issue.number)}`),
      ) ?? null;
    const facts = (ref: string): LocalRunRefFacts => {
      const part = parts.find((p) => p.branch === ref) ?? null;
      const pr = allPrs.find((r) => r.branch === ref) ?? null;
      const onBranch = state.tasks.filter((t) => t.branch === ref);
      return {
        ref,
        isDefaultBranch: ref === 'main',
        part:
          part === null
            ? null
            : { slug: part.slug, title: part.title, seq: part.seq, total: parts.length, status: part.status },
        pr:
          pr === null
            ? null
            : {
                number: pr.number,
                state: pr.state ?? (pr.merged === true ? 'merged' : 'open'),
                ciStatus: pr.ciStatus,
                failing: [...(pr.ciVerdict?.dispatch ?? []), ...(pr.ciVerdict?.escalate ?? [])].map((c) => c.name),
                approved: pr.approved === true,
                unresolved: pr.unresolvedComments.length,
              },
        mergedParts: parts.filter((p) => p.status === 'merged').length,
        agentOnIt: onBranch.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting'),
        lastActivityAt: onBranch.reduce<string | null>(
          (newest, t) => (newest === null || t.updatedAt > newest ? t.updatedAt : newest),
          null,
        ),
      };
    };
    // Its own branch first, then its parts in plan order — the order
    // `localRunChoices` builds them in.
    const options: LocalRunTargetView['options'] = [];
    if (ownPr !== null) options.push({ option: { ref: ownPr.branch, part: null }, facts: facts(ownPr.branch) });
    for (const part of branched) {
      if (part.branch === null) continue;
      options.push({
        option: { ref: part.branch, part: { slug: part.slug, title: part.title, seq: part.seq, status: part.status } },
        facts: facts(part.branch),
      });
    }
    return {
      originRef: origin,
      issueNumber: issue.number,
      target: facts(tip?.branch ?? ownPr?.branch ?? 'main'),
      options,
      runnable: tip !== null || ownPr !== null,
    };
  });
  if (state.localRun !== null) {
    // Facts for the run's **own** ref, never the goal's default. Falling back to the
    // target is the tempting shortcut and it describes a different branch than the
    // one that is up — which is the whole failure this view exists to end.
    const run: string = state.localRun.ref;
    const parts = state.planParts.filter((p) => {
      const plan = state.plans.find((pl) => pl.id === p.planId);
      return plan?.originRef === state.localRun?.originRef;
    });
    const pr = allPrs.find((r) => r.branch === run) ?? null;
    const part = parts.find((p) => p.branch === run) ?? null;
    state.localRun = {
      ...state.localRun,
      refFacts: {
        ref: run,
        isDefaultBranch: run === 'main',
        part:
          part === null
            ? null
            : { slug: part.slug, title: part.title, seq: part.seq, total: parts.length, status: part.status },
        pr:
          pr === null
            ? null
            : {
                number: pr.number,
                state: pr.state ?? (pr.merged === true ? 'merged' : 'open'),
                ciStatus: pr.ciStatus,
                failing: [...(pr.ciVerdict?.dispatch ?? []), ...(pr.ciVerdict?.escalate ?? [])].map((c) => c.name),
                approved: pr.approved === true,
                unresolved: pr.unresolvedComments.length,
              },
        mergedParts: parts.filter((p) => p.status === 'merged').length,
        agentOnIt: false,
        lastActivityAt: null,
      },
    };
  }

  return { state, transcripts };
}

/**
 * A plan's revision history, for the sheet's "What changed" view.
 *
 * Authored rather than derived, and only for `plan-395` — the demo's world is
 * built fresh in the browser each load, so no replan has ever landed in it and
 * there is nothing to snapshot. The real route reads `plan_revisions`, which
 * `ingestPlanDocument` writes on every submission.
 *
 * The amendment below is the one worth showing: a discussion in which the
 * operator argued the console change was not a fourth pull request, the planner
 * agreed and folded it in. Anything else answers with no revisions, which is what
 * a plan with no history draws — no History control at all.
 */
export function demoPlanHistory(planId: string): PlanHistory {
  if (planId !== 'plan-395') return { revisions: [], diff: null };
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
      id: 'rev-395-1',
      planId,
      seq: 1,
      at: at(40),
      narrative: narrative({
        reason: 'The signer has to exist before the route can verify one, and the guard change touches every route.',
        approach: 'Sign a short-lived capability into the download URL and move the route out from behind the guard.',
      }),
      parts: [
        part({
          slug: 'signer',
          seq: 1,
          title: 'Add the download capability signer',
          touches: ['apps/api/src/features/snapshots/download-capability.ts'],
          size: 's',
        }),
        part({
          slug: 'route',
          seq: 2,
          title: 'Move the download route outside /api',
          touches: ['apps/api/src/app.ts'],
          dependsOn: ['signer'],
          size: 'm',
        }),
        part({
          slug: 'mint',
          seq: 3,
          title: 'Mint capabilities into the snapshot list',
          touches: ['apps/api/src/features/snapshots/list.ts'],
          dependsOn: ['route'],
          size: 's',
        }),
        part({
          slug: 'rows',
          seq: 4,
          title: 'Point the console’s snapshot rows at the minted URL',
          touches: ['apps/web/src/app/snapshots/page.tsx'],
          dependsOn: ['mint'],
          size: 's',
        }),
      ],
    },
    {
      id: 'rev-395-2',
      planId,
      seq: 2,
      at: at(12),
      narrative: narrative({
        reason:
          'The capability signer has to exist before the route can verify one, and the guard change touches every route.',
        approach:
          'Move `/snapshots/:id/download` out from behind the prefix guard and gate it on a short-lived signed capability instead.',
        openQuestions: 'Whether the unauthenticated arm should serve everything or 404.',
      }),
      parts: [
        part({
          slug: 'signer',
          seq: 1,
          title: 'Add the download capability signer',
          touches: ['apps/api/src/features/snapshots/download-capability.ts'],
          size: 's',
        }),
        part({
          slug: 'route',
          seq: 2,
          title: 'Move the download route outside /api and require the capability',
          touches: ['apps/api/src/app.ts', 'apps/api/src/features/snapshots/routes.ts'],
          dependsOn: ['signer'],
          size: 'm',
        }),
        part({
          slug: 'mint',
          seq: 3,
          title: 'Mint capabilities into the snapshot list',
          touches: ['apps/api/src/features/snapshots/list.ts', 'apps/web/src/app/snapshots/page.tsx'],
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
      parts: [
        { slug: 'signer', kind: 'unchanged', title: 'Add the download capability signer', fields: [] },
        {
          slug: 'route',
          kind: 'changed',
          title: 'Move the download route outside /api and require the capability',
          fields: [
            {
              field: 'title',
              from: 'Move the download route outside /api',
              to: 'Move the download route outside /api and require the capability',
            },
            {
              field: 'touches',
              from: 'apps/api/src/app.ts',
              to: 'apps/api/src/app.ts, apps/api/src/features/snapshots/routes.ts',
            },
          ],
        },
        {
          slug: 'mint',
          kind: 'changed',
          title: 'Mint capabilities into the snapshot list',
          fields: [
            {
              field: 'touches',
              from: 'apps/api/src/features/snapshots/list.ts',
              to: 'apps/api/src/features/snapshots/list.ts, apps/web/src/app/snapshots/page.tsx',
            },
            { field: 'dependsOn', from: 'route', to: 'route, signer' },
            { field: 'size', from: 's', to: 'm' },
          ],
        },
        {
          slug: 'rows',
          kind: 'dropped',
          title: 'Point the console’s snapshot rows at the minted URL',
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
