// Seed data for the GitHub Pages demo. This is the canned world the fake backend
// (demoBackend.ts) starts from — a plausible slice of an engineering day so every
// cockpit panel has something real-looking to render. No server, no network.
import type { AppState } from '../types.js';

interface DemoSeed {
  state: AppState;
  // Per-agent scrollback the drawer seeds from before live deltas take over.
  transcripts: Record<string, string>;
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
      dispatcher: 'rule',
      steeringPriorities: ['unblock humans', 'keep CI green', 'ship reviewed work'],
      watchLabel: 'lubbdubb-watch',
      ignoreLabel: 'lubbdubb-ignore',
      // The demo world is all-fake, so the inject panel stays available — and by
      // the same token there is no tracker to file a ticket into, so that button
      // is hidden exactly as it would be on a `fake` deployment.
      injectable: true,
      canFileTickets: false,
    },
    control: { cap: 3, paused: false },
    worldObservedAt: ago(0),
    world: {
      takenAt: ago(0),
      pullRequests: [
        {
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
          mergeableState: 'unstable',
          merged: false,
          health: { blocked: true, reasons: ['CI failing', '1 unresolved comment'] },
        },
        {
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
        },
        {
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
        },
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
        {
          id: 'iss-208',
          number: 208,
          title: 'Retry transient GitHub 502s in the snapshotter',
          body: 'Snapshot cycles occasionally fail on a 502 from the REST API. Wrap the calls in a bounded retry.',
          labels: ['bug', 'priority:high', 'lubbdubb-watch'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: true, status: 'eligible', reasons: [] },
        },
        {
          id: 'iss-205',
          number: 205,
          title: 'Document the sentinel protocol in the README',
          body: 'Explain @@LUBBDUBB_DONE@@ / @@LUBBDUBB_WAITING@@ and where detection lives.',
          labels: ['docs'],
          state: 'open',
          linkedPrNumber: 141,
          pickup: { eligible: false, status: 'has_pr', reasons: ['has open PR #141'] },
        },
        {
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
        },
        {
          id: 'iss-210',
          number: 210,
          title: 'Explore a Slack notification channel',
          body: 'Nice-to-have: mirror escalations into a Slack channel.',
          labels: ['idea'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'unwatched', reasons: ['no watch label "lubbdubb-watch"'] },
        },
      ],
      stories: [
        {
          id: 'st-12',
          title: 'Password reset flow',
          description: null,
          acceptanceCriteria: null,
          wafPillars: [],
          state: 'new',
          priority: 2,
          labels: [],
        },
        {
          id: 'st-9',
          title: 'Per-agent cost accounting in the cockpit',
          description: 'Surface token + wall-clock cost per agent on the fleet card.',
          acceptanceCriteria: 'Cost shown live and persisted; visible in history.',
          wafPillars: ['operational-excellence', 'cost-optimization'],
          state: 'ready',
          priority: 1,
          labels: ['lubbdubb-watch'],
        },
      ],
    },
    tasks: [
      {
        id: 'task-a1',
        kind: 'fix_ci',
        title: 'Fix failing CI on PR #142',
        prompt: 'CI is red on feature/rate-limit. Investigate the failing test and push a fix.',
        branch: 'feature/rate-limit',
        originRef: 'pr:142',
        originTitle: 'Add token-bucket rate limiting to the ingest API',
        originSummary: 'PR #142 on branch feature/rate-limit · CI failing',
        dispatchReason: 'PR #142 has failing CI and no agent is on it.',
        status: 'active',
        agentId: 'agent-a1',
        createdAt: ago(8),
        updatedAt: ago(1),
      },
      {
        id: 'task-a2',
        kind: 'address_review',
        title: 'Rebase PR #139 on main',
        prompt: 'PR #139 is behind base. Rebase on main and resolve any conflicts.',
        branch: 'feature/azure-approval',
        originRef: 'pr:139',
        originTitle: 'Map Azure DevOps reviewer votes to approval state',
        originSummary: 'PR #139 on branch feature/azure-approval · behind main',
        dispatchReason: 'PR #139 is behind main and no agent is on it.',
        status: 'active',
        agentId: 'agent-a2',
        createdAt: ago(4),
        updatedAt: ago(2),
      },
      {
        id: 'task-a0',
        kind: 'implement_issue',
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
    plans: [
      {
        id: 'plan-212',
        originRef: 'issue:212',
        title: 'Move the store behind a repository interface',
        status: 'active',
        reason: 'The schema move has to merge before anything reads through the new interface.',
        risks:
          'The repository interface has to cover every query the harness makes today, or a missed one surfaces as a runtime error instead of a compile error.',
        outOfScope: 'Swapping the underlying engine off SQLite — this only adds the seam, it does not use it.',
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
        createdAt: ago(90),
        updatedAt: ago(6),
      },
    ],
    planParts: [
      {
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
        branch: 'issue/212/schema',
        prNumber: 140,
        status: 'merged',
        taskId: null,
        createdAt: ago(90),
        updatedAt: ago(30),
      },
      {
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
      },
      {
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
        branch: null,
        prNumber: null,
        status: 'ready',
        taskId: null,
        createdAt: ago(90),
        updatedAt: ago(6),
      },
    ],
    jobs: [],
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
        summary:
          'The retry helper in src/net/backoff.ts squares the delay instead of doubling it, so the 5th retry waits ~17 minutes. Not what I was sent to fix, but it is why the flaky test times out.',
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
        summary: 'This asks for the same provider seam as #118, which already has a merged design doc.',
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
        summary:
          'The real fix is in the upstream azure-devops-node-api types — the field exists on the wire but not in the published typings. Nothing I can change from this repo.',
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
        summary:
          'The ingest API has no request-size limit, so a 200MB body is buffered before anything rejects it. Unrelated to the CI failure I was sent for.',
        status: 'filed',
        jobId: 'job-filed-1',
        ticketRef: 'issue:214',
        createdAt: ago(64),
        updatedAt: ago(58),
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
        id: 'esc-1',
        type: 'agent_waiting',
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
    ],
    decisions: [
      {
        id: 'dec-4',
        cycleId: 'cycle-103',
        action: { type: 'reply_on_pr', reason: 'reviewer asked for a config change on #142' },
        outcome: 'executed',
        detail: 'Drafted a reply and escalated for approval (confidence 0.62 below threshold)',
        rule: null,
        createdAt: ago(1),
      },
      {
        id: 'dec-3',
        cycleId: 'cycle-102',
        action: { type: 'dispatch_fix_ci', reason: 'PR #142 CI is failing' },
        outcome: 'ok',
        detail: 'Dispatched agent onto feature/rate-limit',
        rule: 'pr-ci-failing',
        createdAt: ago(8),
      },
      {
        id: 'dec-2',
        cycleId: 'cycle-101',
        action: { type: 'escalate', reason: 'agent parked on a human' },
        outcome: 'ok',
        detail: 'Rebase conflict on PR #139 needs a call',
        rule: 'pr-base-update',
        createdAt: ago(2),
      },
      {
        id: 'dec-1',
        cycleId: 'cycle-98',
        action: { type: 'merge_pr', reason: 'PR #141 is merge-ready' },
        outcome: 'held',
        detail: 'auto-merge disabled — leaving for a human',
        rule: 'pr-merge-ready',
        createdAt: ago(12),
      },
    ],
    // The dispatcher's ranked pickup plan from the "last pulse": cap 3 with two
    // live agents leaves headroom 1, so the top candidate dispatches and the
    // story pickup sits below the cut waiting for a slot.
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
          origin: 'story:st-9:work',
          rule: 'story-pickup',
          title: 'Implement "Per-agent cost accounting in the cockpit"',
          kind: 'code',
          branch: 'story/st-9',
          status: 'waiting',
          reason: 'Idle capacity; "Per-agent cost accounting in the cockpit" is the highest-priority ready story.',
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
    },
    // The rule book the server ships in /api/state (src/dispatcher/rules.ts) —
    // canned to just the rules the demo's decisions reference.
    dispatchRules: {
      'pr-ci-failing': {
        number: '1',
        name: 'Failing CI',
        description:
          'A PR with failing CI gets a code agent on its branch to investigate and push a fix — broken builds block everything downstream, so this outranks all other work.',
      },
      'pr-base-update': {
        number: '2',
        name: 'Base out of date',
        description:
          'A PR that is behind its base branch (clean update) or conflicts with it (resolve and push) gets a code agent, so it never sits unmergeable while the base moves on.',
      },
      'branch-notify': {
        number: '1–2b',
        name: 'One agent per branch',
        description:
          'At most one code agent works a PR branch: a fresh signal for a branch that already has a running agent is delivered to that agent as a note instead of spawning a second one.',
      },
      'plan-part': {
        number: '4a',
        name: 'Plan part ready',
        description:
          "One part of a multi-PR plan whose dependency has pushed a branch worth stacking on, and which has no agent, gets a code agent on `issue/<n>/<slug>` — based on that dependency's branch while it is still open, on the default branch once it merged. A part held by the plan's concurrency cap is queued as `capped` rather than skipped, so the limit is visible instead of looking like nothing happened.",
      },
      'pr-merge-ready': {
        number: '3',
        name: 'Merge-ready PR',
        description:
          'A green, approved, mergeable PR with no open comments is driven the last mile — merged in, gated by the auto-send policy (below the confidence bar it escalates for approval instead).',
      },
      'issue-pickup': {
        number: '4',
        name: 'Open issue without a PR',
        description:
          'An open, pickup-eligible issue with no linked PR gets a code agent to resolve it into a PR — the front of the issue → PR → merge loop, ordered by label-encoded priority.',
      },
      'story-pickup': {
        number: '7',
        name: 'Idle capacity pickup',
        description:
          'With headroom left and nothing urgent, the highest-priority ready story (already groomed) is picked up by a code agent — idle capacity should always pull work.',
      },
      idle: {
        number: '8',
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
    },
  };

  const transcripts: Record<string, string> = {
    'agent-a1': [
      '$ claude --resume fix-ci',
      'Reading feature/rate-limit …',
      'npm test',
      '  ✗ ratelimit › rejects over the window',
      '  Expected 429, got 200',
      'Opening src/ingest/rateLimit.ts …',
      'The window comparison uses <= but should be <. Patching.',
    ].join('\n'),
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
