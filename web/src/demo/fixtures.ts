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
        },
        {
          id: 'iss-205',
          number: 205,
          title: 'Document the sentinel protocol in the README',
          body: 'Explain @@LUBBDUBB_DONE@@ / @@LUBBDUBB_WAITING@@ and where detection lives.',
          labels: ['docs'],
          state: 'open',
          linkedPrNumber: 141,
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
