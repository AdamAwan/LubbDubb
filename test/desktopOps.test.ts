import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { desktopDeps } from './support/desktop.js';
import { appraisalHold, goalFingerprint } from '../src/intake/appraisal.js';
import { DESKTOP_TOOL_NAMES } from '../src/mcp/names.js';
import type { ToolCallResult } from '../src/mcp/protocol.js';
import type { WorldSnapshot } from '../src/types.js';

const NOW = '2025-01-01T00:00:00.000Z';

interface Deck {
  system: System;
  server: McpDesktopServer;
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }>;
  close(): Promise<void>;
}

interface LabelWrite {
  number: number;
  label: string;
  present: boolean;
}

async function deck(
  overrides: Record<string, unknown> = {},
  labelWrites: LabelWrite[] = [],
  refuse = false,
): Promise<Deck> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-ops-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: 'lubbdubb',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      ...overrides,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
  const server = new McpDesktopServer({
    ...desktopDeps(system),
    connector: {
      canPlaceWorkItem: () => system.connector.canPlaceWorkItem(),
      setWorkItemParent: (input) => system.connector.setWorkItemParent(input),
      setWorkItemAreaPath: (input) => system.connector.setWorkItemAreaPath(input),
      setIssueLabel: async (input) => {
        if (refuse) throw new Error('the provider is down');
        labelWrites.push({ number: input.number, label: input.label, present: input.present });
        return { ok: true, ref: `label:${input.number}` } as never;
      },
    },
    now: () => NOW,
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\lubbdubb-ops-${Date.now()}` : join(dir, 'ops.sock'),
    credentialPath: join(dir, 'desktop.json'),
  });
  assert.ok(await server.listen(), 'the desktop channel starts on a throwaway path');
  return {
    system,
    server,
    call: async (name, args = {}) => {
      const session = server.session('c1');
      assert.ok(session, 'a listening channel hands out sessions');
      const result = (await session.call(name, args)) as ToolCallResult;
      const text = result.content[0]?.text ?? '';
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // A refusal is prose, not JSON — the caller asserts on `text` instead.
      }
      return { isError: result.isError === true, text, json };
    },
    close: async () => {
      await server.close();
      system.store.close();
    },
  };
}

function world(system: System, numbers: number[], labels: string[] = []): void {
  const snapshot: WorldSnapshot = {
    takenAt: NOW,
    pullRequests: [],
    closedPullRequests: [],
    issues: numbers.map((number) => ({
      number,
      title: `Issue ${number}`,
      body: '',
      state: 'open',
      labels: [...labels],
      url: `https://example.invalid/${number}`,
    })) as WorldSnapshot['issues'],
  };
  system.store.world.setWorldBaseline(snapshot);
}

test('the fleet tools are advertised and none of them dispatches', async () => {
  const d = await deck();
  try {
    const session = d.server.session('c1');
    assert.ok(session);
    const names = await session.list();
    for (const name of [
      'fleet_status',
      'fleet_control',
      'attention_read',
      'escalation_answer',
      'human_task_settle',
      'agent_read',
      'queue_control',
      'goal_control',
    ])
      assert.ok(names.includes(name), `${name} is advertised`);
    assert.deepEqual(names.sort(), [...DESKTOP_TOOL_NAMES].sort(), 'and the list is exactly the declared one');

    await d.call('fleet_control', { cap: 5, paused: false });
    await d.call('queue_control', { order: ['issue:1:plan'] });
    await d.call('goal_control', { issue: 1, priority: true });
    assert.equal(d.system.store.agents.listAgents().length, 0, 'steering the fleet started nothing');
  } finally {
    await d.close();
  }
});

test('fleet_status reports the cap, the pause and the headroom a pause removes', async () => {
  const d = await deck({ maxConcurrentAgents: 4 });
  try {
    const open = await d.call('fleet_status');
    assert.equal(open.isError, false);
    const control = open.json.control as Record<string, number | boolean>;
    assert.equal(control.cap, 4);
    assert.equal(control.paused, false);
    assert.equal(control.headroom, 4);

    await d.call('fleet_control', { paused: true });
    const paused = await d.call('fleet_status');
    assert.equal((paused.json.control as Record<string, unknown>).headroom, 0);
    assert.equal((paused.json.control as Record<string, unknown>).paused, true);

    const queue = paused.json.queue as Record<string, unknown>;
    assert.deepEqual(queue.items, []);
    assert.ok(typeof queue.note === 'string' && (queue.note as string).includes('no queue yet'));
  } finally {
    await d.close();
  }
});

test('fleet_status reports no account window as null, never as room to spare', async () => {
  const d = await deck();
  try {
    const before = await d.call('fleet_status');
    assert.equal(before.json.accountUsage, null, 'nothing has reported a window');

    d.system.store.rateLimits.recordRateLimits({
      fiveHour: { usedPercentage: 91.5, resetsAt: '2025-01-01T04:00:00.000Z' },
      sevenDay: null,
      capturedAt: NOW,
    });
    const after = await d.call('fleet_status');
    const usage = after.json.accountUsage as Record<string, unknown>;
    assert.equal((usage.fiveHour as Record<string, number>).usedPercentage, 91.5);
  } finally {
    await d.close();
  }
});

test('fleet_control writes through RuntimeControl, and refuses what it refuses', async () => {
  const d = await deck();
  try {
    const set = await d.call('fleet_control', { cap: 7, paused: true });
    assert.equal(set.isError, false);
    assert.equal(d.system.runtimeControl.snapshot().cap, 7);
    assert.equal(d.system.runtimeControl.snapshot().paused, true);

    const bad = await d.call('fleet_control', { cap: -1 });
    assert.ok(bad.isError);
    assert.equal(d.system.runtimeControl.snapshot().cap, 7, 'and a refusal changes nothing');

    const empty = await d.call('fleet_control', {});
    assert.ok(empty.isError);
    assert.ok(empty.text.includes('fleet_status'), 'the refusal names the read');
  } finally {
    await d.close();
  }
});

test('queue_control replaces the pin set, and refuses a duplicate origin', async () => {
  const d = await deck();
  try {
    await d.call('queue_control', { order: ['issue:2:plan', 'issue:3:plan'] });
    assert.deepEqual(
      d.system.store.priority.listPriorityOverrides().map((o) => o.origin),
      ['issue:2:plan', 'issue:3:plan'],
    );

    await d.call('queue_control', { order: ['issue:9:plan'] });
    assert.deepEqual(
      d.system.store.priority.listPriorityOverrides().map((o) => o.origin),
      ['issue:9:plan'],
    );

    const dupe = await d.call('queue_control', { order: ['issue:9:plan', 'issue:9:plan'] });
    assert.ok(dupe.isError);
    assert.equal(d.system.store.priority.listPriorityOverrides().length, 1, 'and nothing was rewritten');

    const empty = await d.call('queue_control', {});
    assert.ok(empty.isError);
  } finally {
    await d.close();
  }
});

test('queue_control cancels a queued job and refuses one that has gone', async () => {
  const d = await deck();
  try {
    const job = d.system.store.jobs.createJob({ title: 'a brief', prompt: 'do a thing', kind: 'desk', branch: null });
    const cancelled = await d.call('queue_control', { cancelJob: job.id });
    assert.equal(cancelled.isError, false);
    assert.equal(d.system.store.jobs.getJob(job.id)?.status, 'cancelled');

    const again = await d.call('queue_control', { cancelJob: job.id });
    assert.ok(again.isError, 'a job that is no longer queued is a refusal, not a silent success');
  } finally {
    await d.close();
  }
});

test('goal_control writes the priority mark and the watch tag, and says what each is', async () => {
  const writes: LabelWrite[] = [];
  const d = await deck({}, writes);
  try {
    world(d.system, [42]);
    const marked = await d.call('goal_control', { issue: 42, priority: true, watched: true });
    assert.equal(marked.isError, false);
    assert.equal(marked.json.priority, true);
    assert.equal(d.system.store.priority.listGoalPriorities().length, 1, 'the harness’s own record, not a label');

    assert.deepEqual(writes, [{ number: 42, label: 'lubbdubb-watch', present: true }]);

    const dropped = await d.call('goal_control', { issue: 42, watched: false });
    assert.equal(dropped.isError, false);
    assert.deepEqual(
      writes[1],
      { number: 42, label: 'lubbdubb-watch', present: false },
      'and un-watching takes it off again',
    );

    const empty = await d.call('goal_control', { issue: 42 });
    assert.ok(empty.isError, 'a call that names neither mark asks for nothing');
  } finally {
    await d.close();
  }
});

test('goal_control says so rather than lying when the deployment has no watch gate', async () => {
  const writes: LabelWrite[] = [];
  const d = await deck({ labelPrefix: '' }, writes);
  try {
    world(d.system, [42]);
    const res = await d.call('goal_control', { issue: 42, watched: true });
    assert.deepEqual(writes, [], 'there is no tag to write, so nothing was asked of the provider');
    assert.equal(res.isError, false);
    const watch = res.json.watch as Record<string, unknown>;
    assert.equal(watch.wrote, 0);
    assert.ok(typeof watch.note === 'string' && (watch.note as string).includes('no labelPrefix'));
  } finally {
    await d.close();
  }
});

test('goal_control refuses rather than reporting a tag the provider would not take', async () => {
  const d = await deck({}, [], true);
  try {
    world(d.system, [42]);
    const res = await d.call('goal_control', { issue: 42, watched: true });
    assert.ok(res.isError);
    assert.ok(res.text.includes('the provider is down'), 'the provider’s own reason reaches the caller intact');
  } finally {
    await d.close();
  }
});

test('attention_read lists what is open, and escalation_answer settles a question', async () => {
  const d = await deck();
  try {
    const esc = d.system.escalations.create({
      type: 'answer_question',
      prompt: 'Which database should this use?',
      context: { taskTitle: 'wire the export', originRef: 'issue:7' },
      agentId: null,
      taskId: null,
    });

    const inbox = await d.call('attention_read');
    const rows = inbox.json.inbox as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, 'question');
    assert.ok(String(rows[0]?.settledBy).includes('escalation_answer'));

    const answered = await d.call('escalation_answer', { id: esc.id, response: 'the existing one' });
    assert.equal(answered.isError, false);
    assert.equal(answered.json.routing, 'queued_for_dispatch');
    assert.equal(d.system.store.escalations.getEscalation(esc.id)?.response, 'the existing one');

    const twice = await d.call('escalation_answer', { id: esc.id, response: 'again' });
    assert.ok(twice.isError, 'an item already answered is a refusal');
  } finally {
    await d.close();
  }
});

test('a human task is settled by its own verb, and escalation_answer names it rather than failing bare', async () => {
  const d = await deck();
  try {
    const { task } = d.system.store.humanTasks.recordHumanTask({
      title: 'Top the account back up',
      detail: 'The queue is thinning.',
      originRef: null,
      kind: 'supply',
      agentId: null,
      taskId: null,
    });

    const inbox = await d.call('attention_read');
    const rows = inbox.json.humanTasks as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, task.id);
    assert.ok(String(rows[0]?.settledBy).includes('human_task_settle'));

    const wrong = await d.call('escalation_answer', { id: task.id, response: 'done it' });
    assert.ok(wrong.isError);
    assert.ok(wrong.text.includes('human_task_settle'), 'the refusal names the verb that does take it');

    const settled = await d.call('human_task_settle', { id: task.id, status: 'done', note: 'topped up' });
    assert.equal(settled.isError, false);
    assert.equal(d.system.store.humanTasks.getHumanTask(task.id)?.status, 'done');
    assert.equal(d.system.store.humanTasks.getHumanTask(task.id)?.resolution, 'topped up');
    assert.equal(d.system.store.agents.listAgents().length, 0);

    const twice = await d.call('human_task_settle', { id: task.id, status: 'done' });
    assert.ok(twice.isError, 'a row somebody already settled is a refusal');
  } finally {
    await d.close();
  }
});

test('human_task_settle refuses a decline with no note, and an id nothing holds', async () => {
  const d = await deck();
  try {
    const { task } = d.system.store.humanTasks.recordHumanTask({
      title: 'Provide the fixture archive',
      detail: null,
      originRef: 'issue:7',
      kind: 'ask',
      agentId: null,
      taskId: null,
    });

    const bare = await d.call('human_task_settle', { id: task.id, status: 'declined' });
    assert.ok(bare.isError);
    assert.equal(d.system.store.humanTasks.getHumanTask(task.id)?.status, 'open', 'and nothing was written');

    const declined = await d.call('human_task_settle', { id: task.id, status: 'declined', note: 'not ours to do' });
    assert.equal(declined.isError, false);
    assert.equal(d.system.store.humanTasks.getHumanTask(task.id)?.status, 'declined');

    const missing = await d.call('human_task_settle', { id: 'hum_nope', status: 'done' });
    assert.ok(missing.isError);
    assert.ok(missing.text.includes('escalation_answer'), 'and it names the other list a stray id may be on');
  } finally {
    await d.close();
  }
});

test('escalation_answer refuses a permission request as free text and names the arm that settles it', async () => {
  const d = await deck();
  try {
    const esc = d.system.escalations.create({
      type: 'approve_change',
      prompt: 'Agent wants to run rm -rf build',
      context: { permission: { toolName: 'Bash', summary: 'rm -rf build' } },
      agentId: null,
      taskId: null,
    });

    const kind = ((await d.call('attention_read')).json.inbox as Record<string, unknown>[])[0];
    assert.equal(kind?.kind, 'permission');

    const text = await d.call('escalation_answer', { id: esc.id, response: 'go ahead' });
    assert.ok(text.isError);
    assert.ok(text.text.includes('permission'), 'and the refusal names what does settle it');
    assert.equal(d.system.store.escalations.getEscalation(esc.id)?.status, 'open', 'nothing was settled');

    const verdict = await d.call('escalation_answer', { id: esc.id, permission: 'allow' });
    assert.ok(verdict.isError);
  } finally {
    await d.close();
  }
});

test('escalation_answer folds a questionnaire, and refuses one that does not match', async () => {
  const d = await deck();
  try {
    const esc = d.system.escalations.create({
      type: 'answer_question',
      prompt: 'Two things',
      context: { questions: [{ question: 'Which store?' }, { question: 'Which branch?' }] },
      agentId: null,
      taskId: null,
    });

    const short = await d.call('escalation_answer', { id: esc.id, answers: ['only one'] });
    assert.ok(short.isError, 'a mismatched array is a caller disagreeing about what was asked');
    assert.equal(d.system.store.escalations.getEscalation(esc.id)?.status, 'open');

    const blank = await d.call('escalation_answer', { id: esc.id, answers: [null, '  '] });
    assert.ok(blank.isError, 'and answering none of them is not an answer');

    const ok = await d.call('escalation_answer', { id: esc.id, answers: ['sqlite', null] });
    assert.equal(ok.isError, false);
    const response = d.system.store.escalations.getEscalation(esc.id)?.response ?? '';
    assert.ok(
      response.includes('Which store?') && response.includes('sqlite'),
      'the fold is the server’s, not the caller’s',
    );
  } finally {
    await d.close();
  }
});

test('agent_read names an unknown agent rather than answering emptily', async () => {
  const d = await deck();
  try {
    const missing = await d.call('agent_read', { agentId: 'nope' });
    assert.ok(missing.isError);
    assert.ok(missing.text.includes('fleet_status'), 'the refusal points at where the ids come from');
  } finally {
    await d.close();
  }
});

test('proposal_read says which kind a row is and what accepting it would do', async () => {
  const d = await deck();
  try {
    const merge = d.system.store.escalations.createProposal({
      kind: 'merge',
      ref: 'pr:42:merge',
      action: { type: 'merge_pr', prNumber: 42, method: 'squash', confidence: 0.9, reason: 'green' },
      escalationId: null,
    });
    const read = await d.call('proposal_read', { id: merge.id });
    assert.equal(read.isError, false);
    assert.equal(read.json.kind, 'merge');
    assert.match(String(read.json.acceptWouldMean), /MERGED/, 'and it says so in the words a session reads out');
    assert.equal(read.json.backOutAvailable, false, 'only a plan has a ticket to back out of');

    const missing = await d.call('proposal_read', { id: 'nope' });
    assert.ok(missing.isError);
  } finally {
    await d.close();
  }
});

test('proposal_decide rejects without performing, and refuses an already-decided row', async () => {
  const d = await deck();
  try {
    const proposal = d.system.store.escalations.createProposal({
      kind: 'merge',
      ref: 'pr:42:merge',
      action: { type: 'merge_pr', prNumber: 42, method: 'squash', confidence: 0.9, reason: 'green' },
      escalationId: null,
    });
    const rejected = await d.call('proposal_decide', { id: proposal.id, verdict: 'reject', note: 'not yet' });
    assert.equal(rejected.isError, false);
    assert.equal(d.system.store.escalations.listProposals().find((p) => p.id === proposal.id)?.status, 'rejected');

    const again = await d.call('proposal_decide', { id: proposal.id, verdict: 'accept' });
    assert.ok(again.isError);
    assert.match(again.text, /already rejected/);
  } finally {
    await d.close();
  }
});

test('proposal_decide refuses the ticket verdicts on anything but a plan', async () => {
  const d = await deck();
  try {
    const merge = d.system.store.escalations.createProposal({
      kind: 'merge',
      ref: 'pr:42:merge',
      action: { type: 'merge_pr', prNumber: 42, method: 'squash', confidence: 0.9, reason: 'green' },
      escalationId: null,
    });
    const wrong = await d.call('proposal_decide', { id: merge.id, verdict: 'hold_ticket' });
    assert.ok(wrong.isError);
    assert.match(wrong.text, /only a plan/);
    assert.equal(d.system.store.escalations.listProposals().find((p) => p.id === merge.id)?.status, 'pending');

    const plan = d.system.store.escalations.createProposal({
      kind: 'plan',
      ref: 'issue:12:plan',
      action: { type: 'propose_plan', reason: 'x' },
      escalationId: null,
    });
    const noNote = await d.call('proposal_decide', { id: plan.id, verdict: 'close_ticket' });
    assert.ok(noNote.isError);
    assert.match(noNote.text, /note is required/);
    assert.equal(d.system.store.escalations.listProposals().find((p) => p.id === plan.id)?.status, 'pending');
  } finally {
    await d.close();
  }
});

test('proposal_decide will not release a plan whose caveats are unacknowledged', async () => {
  const d = await deck();
  try {
    const plan = d.system.store.escalations.createProposal({
      kind: 'plan',
      ref: 'issue:12:plan',
      action: {
        type: 'propose_plan',
        reason: 'x',
        caveats: [{ id: 'schema', label: 'This changes the schema', detail: 'and there is no migration yet' }],
      },
      escalationId: null,
    });

    const gated = await d.call('proposal_decide', { id: plan.id, verdict: 'accept' });
    assert.equal(gated.isError, false);
    assert.equal(gated.json.verdict, 'refused');
    assert.deepEqual(
      (gated.json.unacknowledged as Record<string, unknown>[]).map((c) => c.id),
      ['schema'],
    );
    assert.equal(
      d.system.store.escalations.listProposals().find((p) => p.id === plan.id)?.status,
      'pending',
      'and the plan is not released',
    );

    const read = await d.call('proposal_read', { id: plan.id });
    assert.deepEqual(
      (read.json.caveats as Record<string, unknown>[]).map((c) => c.id),
      ['schema'],
    );
  } finally {
    await d.close();
  }
});

test('recovery_decide hands back the desk’s own refusal rather than a generic failure', async () => {
  const d = await deck();
  try {
    const bad = await d.call('recovery_decide', { taskId: 'task_nope', verdict: 'restore' });
    assert.ok(bad.isError);
    assert.match(bad.text, /no orphaned work/);

    const verdict = await d.call('recovery_decide', { taskId: 'task_nope', verdict: 'sideways' });
    assert.ok(verdict.isError);
    assert.match(verdict.text, /restore/);
  } finally {
    await d.close();
  }
});

test('job_create queues a desk brief and says it is not running yet', async () => {
  const d = await deck();
  try {
    const created = await d.call('job_create', { prompt: 'summarise the release notes', kind: 'desk' });
    assert.equal(created.isError, false);
    const job = created.json.job as Record<string, unknown>;
    assert.equal(job.kind, 'desk');
    assert.equal(job.status, 'queued');
    assert.equal(d.system.store.jobs.listJobs().length, 1);
    assert.match(String(created.json.means), /not running yet/);

    const empty = await d.call('job_create', { prompt: '   ' });
    assert.ok(empty.isError, 'a brief with no words in it asks for nothing');
    assert.equal(d.system.store.jobs.listJobs().length, 1);
  } finally {
    await d.close();
  }
});

test('agent_control tells a dead agent from one that never existed', async () => {
  const d = await deck();
  try {
    const missing = await d.call('agent_control', { agentId: 'nope', action: 'kill' });
    assert.ok(missing.isError);
    assert.match(missing.text, /No agent/, 'a typo is not "not live"');

    const badAction = await d.call('agent_control', { agentId: 'nope', action: 'detonate' });
    assert.ok(badAction.isError);
    assert.match(badAction.text, /respond/);

    const noText = await d.call('agent_control', { agentId: 'nope', action: 'respond' });
    assert.ok(noText.isError);
  } finally {
    await d.close();
  }
});

test('goal_control pins the goal to a profile as a tag, and settles the question the gate is holding', async () => {
  const writes: LabelWrite[] = [];
  const d = await deck(
    {
      agentModels: {
        profiles: {
          cheap: { model: 'haiku', rank: 0, description: 'the cheap one, for small changes' },
          deep: { model: 'opus', rank: 1, description: 'the expensive one' },
        },
      },
    },
    writes,
  );
  try {
    world(d.system, [42]);
    const origin = 'issue:42';
    d.system.store.verdicts.recordAppraisal({
      originRef: origin,
      verdict: 'workable',
      summary: 'workable, but this wants the deep profile',
      goalRef: goalFingerprint('Issue 42', ''),
      by: 'appraiser',
      proposedProfile: 'deep',
      profileDiverges: true,
    });
    assert.equal(d.system.store.verdicts.getAppraisal(origin)?.profileAnsweredAt, null);

    const bad = await d.call('goal_control', { issue: 42, profile: 'enormous' });
    assert.ok(bad.isError);
    assert.match(bad.text, /cheap/);
    assert.equal(writes.length, 0);
    assert.equal(d.system.store.verdicts.getAppraisal(origin)?.profileAnsweredAt, null);

    const ok = await d.call('goal_control', { issue: 42, profile: 'deep' });
    assert.equal(ok.isError, false);
    assert.deepEqual(
      writes.map((w) => `${w.label}:${w.present}`),
      ['lubbdubb-model-cheap:false', 'lubbdubb-model-deep:true'],
    );
    assert.equal(d.system.store.profileOverrides.listProfileOverrides().length, 0);
    assert.equal(ok.json.profileQuestionAnswered, true);
    assert.notEqual(d.system.store.verdicts.getAppraisal(origin)?.profileAnsweredAt, null);

    writes.length = 0;
    const cleared = await d.call('goal_control', { issue: 42, profile: '' });
    assert.equal(cleared.isError, false);
    assert.deepEqual(
      writes.map((w) => w.present),
      [false, false],
    );
  } finally {
    await d.close();
  }
});

test('queue_control prices one queued row, and refuses a profile the deployment does not configure', async () => {
  const d = await deck({
    agentModels: { profiles: { cheap: { model: 'haiku', rank: 0, description: 'the cheap one, for small changes' } } },
  });
  try {
    const bad = await d.call('queue_control', { origin: 'issue:42:plan', profile: 'enormous' });
    assert.ok(bad.isError);
    assert.match(bad.text, /cheap/);
    assert.equal(d.system.store.profileOverrides.listProfileOverrides().length, 0);

    const ok = await d.call('queue_control', { origin: 'issue:42:plan', profile: 'cheap' });
    assert.equal(ok.isError, false);
    assert.equal(d.system.store.profileOverrides.listProfileOverrides()[0]?.profile, 'cheap');

    const cleared = await d.call('queue_control', { origin: 'issue:42:plan', profile: '' });
    assert.equal(cleared.isError, false);
    assert.equal(d.system.store.profileOverrides.listProfileOverrides().length, 0);

    const bare = await d.call('queue_control', { profile: 'cheap' });
    assert.ok(bare.isError);
    assert.match(bare.text, /origin required/);
  } finally {
    await d.close();
  }
});

test('goal_gate releases a goal an appraiser called unclear, and clears the verdict outright', async () => {
  const d = await deck();
  try {
    world(d.system, [42]);
    const origin = 'issue:42';
    const issue = d.system.store.world.getWorldBaseline()!.issues[0]!;
    d.system.store.verdicts.recordAppraisal({
      originRef: origin,
      verdict: 'unclear',
      summary: 'the goal does not say what done means',
      goalRef: goalFingerprint(issue.title, issue.body),
      by: 'appraiser',
    });
    assert.notEqual(appraisalHold(d.system.store.verdicts.getAppraisal(origin), issue), null, 'the goal is held');

    const worked = await d.call('goal_gate', { issue: 42, appraisal: 'workable', summary: 'it is clear enough' });
    assert.equal(worked.isError, false);
    assert.equal(appraisalHold(d.system.store.verdicts.getAppraisal(origin), issue), null, 'the hold is gone');
    assert.equal(d.system.store.verdicts.getAppraisal(origin)?.by, 'operator');

    const cleared = await d.call('goal_gate', { issue: 42, appraisal: 'clear' });
    assert.equal(cleared.isError, false);
    assert.equal(d.system.store.verdicts.getAppraisal(origin), null);
  } finally {
    await d.close();
  }
});

test('goal_gate refuses a verdict on a goal the last snapshot does not carry', async () => {
  const d = await deck();
  try {
    const missing = await d.call('goal_gate', { issue: 99, appraisal: 'workable' });
    assert.ok(missing.isError);
    assert.match(missing.text, /not in the last world snapshot/);
    assert.equal(d.system.store.verdicts.getAppraisal('issue:99'), null);
  } finally {
    await d.close();
  }
});

test('goal_gate overrules a shortfall as a delivery plus an instruction, and refuses when none stands', async () => {
  const d = await deck();
  try {
    world(d.system, [42]);
    const origin = 'issue:42';
    const bare = await d.call('goal_gate', { issue: 42, overrule: 'the assessor is wrong, it shipped last week' });
    assert.ok(bare.isError);
    assert.match(bare.text, /no standing shortfall/);
    assert.equal(d.system.store.verdicts.getDelivery(origin), null, 'nothing is delivered by a refused overrule');

    d.system.store.verdicts.recordShortfall({
      originRef: origin,
      cause: 'goal',
      summary: 'the export is missing',
      by: 'assessor',
    });
    const ok = await d.call('goal_gate', { issue: 42, overrule: 'the export is there; the assessor looked in the UI' });
    assert.equal(ok.isError, false);
    assert.equal(d.system.store.verdicts.getShortfall(origin), null);
    assert.match(d.system.store.verdicts.getDelivery(origin)?.summary ?? '', /assessor looked in the UI/);
    assert.equal(d.system.store.instructions.listStandingInstructions(origin).length, 1);
  } finally {
    await d.close();
  }
});

test('goal_gate will not release an environment gate without an account of why', async () => {
  const d = await deck();
  try {
    world(d.system, [42]);
    const bare = await d.call('goal_gate', { issue: 42, environmentGate: true });
    assert.ok(bare.isError);
    assert.match(bare.text, /note/);
    assert.equal(d.system.store.environments.listEnvironmentGateReleases().length, 0);

    const ok = await d.call('goal_gate', { issue: 42, environmentGate: true, note: 'docs only — it never deploys' });
    assert.equal(ok.isError, false);
    assert.equal(d.system.store.environments.listEnvironmentGateReleases()[0]?.goalRef, 'issue:42');

    const back = await d.call('goal_gate', { issue: 42, environmentGate: false });
    assert.equal(back.isError, false);
    assert.equal(d.system.store.environments.listEnvironmentGateReleases().length, 0);
  } finally {
    await d.close();
  }
});

test('goal_gate does nothing on a call that names no hold', async () => {
  const d = await deck();
  try {
    world(d.system, [42]);
    const nothing = await d.call('goal_gate', { issue: 42 });
    assert.ok(nothing.isError);
    assert.match(nothing.text, /goal_read/);
  } finally {
    await d.close();
  }
});

test('goal_placement refuses where the tracker has no parent or area path', async () => {
  const d = await deck();
  try {
    world(d.system, [42]);
    const refused = await d.call('goal_placement', { issue: 42, parent: 7 });
    assert.ok(refused.isError);
    assert.match(refused.text, /no parent or area path/);

    const nothing = await d.call('goal_placement', { issue: 42 });
    assert.ok(nothing.isError);
    assert.match(nothing.text, /goal_read/);
  } finally {
    await d.close();
  }
});

test('goal_instruct puts words in front of the next agent and restarts the goal', async () => {
  const d = await deck();
  try {
    world(d.system, [42]);
    const origin = 'issue:42';
    d.system.store.verdicts.recordDelivery({ originRef: origin, summary: 'assessed as delivered', by: 'assessor' });

    const wrote = await d.call('goal_instruct', { issue: 42, text: 'the button is the wrong colour' });
    assert.equal(wrote.isError, false);
    assert.equal(d.system.store.instructions.listStandingInstructions(origin).length, 1);
    assert.equal(d.system.store.verdicts.getIssueConclusion(origin)?.verdict, 'more_work');
    assert.equal(d.system.store.verdicts.getDelivery(origin), null);

    const id = (wrote.json.instruction as { id: string }).id;
    const back = await d.call('goal_instruct', { issue: 42, withdraw: id });
    assert.equal(back.isError, false);
    assert.equal(d.system.store.instructions.listStandingInstructions(origin).length, 0);
    assert.equal(d.system.store.verdicts.getIssueConclusion(origin), null);
    assert.equal(d.system.store.verdicts.getDelivery(origin), null);
  } finally {
    await d.close();
  }
});

test('goal_instruct refuses a write and a withdrawal in one call', async () => {
  const d = await deck();
  try {
    world(d.system, [42]);
    const both = await d.call('goal_instruct', { issue: 42, text: 'do the thing', withdraw: 'ins_1' });
    assert.ok(both.isError);
    assert.equal(d.system.store.instructions.listStandingInstructions('issue:42').length, 0);

    const gone = await d.call('goal_instruct', { issue: 42, withdraw: 'ins_nope' });
    assert.ok(gone.isError);
    assert.match(gone.text, /goal_read/);
  } finally {
    await d.close();
  }
});
