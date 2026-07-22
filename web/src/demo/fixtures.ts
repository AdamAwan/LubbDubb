// Seed data for the GitHub Pages demo. This is the canned world the fake backend
// (demoBackend.ts) starts from — a plausible slice of an engineering day so every
// cockpit panel has something real-looking to render. No server, no network.
import type { AppState } from '../types.js';

export interface DemoSeed {
  state: AppState;
  // Per-agent scrollback the drawer seeds from before live deltas take over.
  transcripts: Record<string, string>;
}

/** Build a fresh demo world. Timestamps are relative to now so the feed reads as "recent". */
export function buildDemoState(): DemoSeed {
  const now = Date.now();
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();
  const ahead = (mins: number) => new Date(now + mins * 60_000).toISOString();
  // A fixed local wall-clock time, `offsetDays` from today — so the demo agenda
  // reliably spans Today and Tomorrow regardless of when it's opened.
  const dayAt = (offsetDays: number, h: number, m: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offsetDays);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  const state: AppState = {
    config: {
      // Short heartbeat so the countdown bar visibly moves in the demo.
      heartbeatIntervalMs: 15_000,
      maxConcurrentAgents: 3,
      dispatcher: 'rule',
      steeringPriorities: ['unblock humans', 'keep CI green', 'ship reviewed work'],
      prExclusionLabel: 'lubbdubb-ignore',
    },
    control: { cap: 3, paused: false },
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
      issues: [
        {
          id: 'iss-208',
          number: 208,
          title: 'Retry transient GitHub 502s in the snapshotter',
          body: 'Snapshot cycles occasionally fail on a 502 from the REST API. Wrap the calls in a bounded retry.',
          labels: ['bug', 'priority:high'],
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
          id: 'iss-210',
          number: 210,
          title: 'Explore a Slack notification channel',
          body: 'Nice-to-have: mirror escalations into a Slack channel.',
          labels: ['idea'],
          state: 'open',
          linkedPrNumber: null,
          pickup: { eligible: false, status: 'skipped', reasons: ['no pickup label "agent-ready"'] },
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
        },
        {
          id: 'st-9',
          title: 'Per-agent cost accounting in the cockpit',
          description: 'Surface token + wall-clock cost per agent on the fleet card.',
          acceptanceCriteria: 'Cost shown live and persisted; visible in history.',
          wafPillars: ['operational-excellence', 'cost-optimization'],
          state: 'ready',
          priority: 1,
        },
      ],
      calendar: [
        {
          id: 'evt-1',
          title: 'Architecture review',
          startsAt: ahead(95),
          prepDocs: ['design.md', 'ADR-014'],
          prepDone: false,
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
        createdAt: ago(1),
      },
      {
        id: 'dec-3',
        cycleId: 'cycle-102',
        action: { type: 'dispatch_fix_ci', reason: 'PR #142 CI is failing' },
        outcome: 'ok',
        detail: 'Dispatched agent onto feature/rate-limit',
        createdAt: ago(8),
      },
      {
        id: 'dec-2',
        cycleId: 'cycle-101',
        action: { type: 'escalate', reason: 'agent parked on a human' },
        outcome: 'ok',
        detail: 'Rebase conflict on PR #139 needs a call',
        createdAt: ago(2),
      },
      {
        id: 'dec-1',
        cycleId: 'cycle-98',
        action: { type: 'merge_pr', reason: 'PR #141 is merge-ready' },
        outcome: 'held',
        detail: 'auto-merge disabled — leaving for a human',
        createdAt: ago(12),
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
    },
    // The Claude-bridged desk briefing — mail + Teams pings + meetings, all canned.
    briefing: {
      generatedAt: ago(20),
      windowStart: ago(20),
      windowEnd: ahead(600),
      owner: { email: 'you@example.com', name: 'You' },
      areas: ['me', 'statements'],
      meetings: [
        {
          id: 'evt-0',
          subject: 'Standup — Platform',
          start: ago(180),
          end: ago(150),
          isOnline: true,
          joinUrl: 'https://teams.microsoft.com/l/meetup-join/demo0',
          webLink: 'https://outlook.office365.com/owa/?itemid=evt-0',
          organizer: 'You',
          attendeeCount: 8,
          showAs: 'busy',
          relevance: 'mine',
        },
        {
          id: 'evt-1',
          subject: 'Architecture review',
          start: ahead(25),
          end: ahead(85),
          isOnline: true,
          joinUrl: 'https://teams.microsoft.com/l/meetup-join/demo',
          webLink: 'https://outlook.office365.com/owa/?itemid=evt-1',
          organizer: 'Priya',
          attendeeCount: 6,
          responseRequested: true,
          showAs: 'busy',
          relevance: 'mine',
        },
        {
          id: 'evt-2',
          subject: 'Sprint planning',
          start: dayAt(1, 10, 0),
          end: dayAt(1, 10, 45),
          isOnline: true,
          joinUrl: 'https://teams.microsoft.com/l/meetup-join/demo2',
          webLink: 'https://outlook.office365.com/owa/?itemid=evt-2',
          organizer: 'Priya',
          attendeeCount: 9,
          responseRequested: true,
          showAs: 'busy',
          relevance: 'mine',
        },
        {
          id: 'evt-3',
          subject: 'Vendor sync — payments',
          start: dayAt(1, 16, 0),
          end: dayAt(1, 16, 30),
          isOnline: false,
          webLink: 'https://outlook.office365.com/owa/?itemid=evt-3',
          organizer: 'Dana',
          attendeeCount: 4,
          showAs: 'busy',
          relevance: 'area',
        },
      ],
      mail: [
        {
          id: 'mail-1',
          subject: 'Q3 statements ready for review',
          from: 'finance@example.com',
          receivedAt: ago(45),
          isUnread: true,
          isFlagged: true,
          webLink: 'https://outlook.office365.com/mail/inbox/id/mail-1',
          preview: 'The consolidated statements are attached — please confirm the revenue split by EOD.',
          relevance: 'area',
          area: 'statements',
        },
      ],
      pings: [
        {
          id: 'ping-1',
          source: 'teams',
          chatOrChannel: 'Platform',
          from: 'Jo',
          sentAt: ago(12),
          preview: 'Did the rate-limit fix land? CI still looks red on my end.',
          webLink: 'https://teams.microsoft.com/l/message/demo/ping-1',
          relevance: 'mine',
        },
      ],
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
