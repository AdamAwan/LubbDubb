import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { desktopDeps } from './support/desktop.js';
import { DESKTOP_TOOL_NAMES } from '../src/mcp/names.js';
import type { ToolCallResult } from '../src/mcp/protocol.js';
import type { WorldSnapshot } from '../src/types.js';

/**
 * The fleet half of the desktop channel: what an operator's own agent may read
 * about the harness, and the four verbs it may steer it with.
 *
 * Three properties carry the design, and each is asserted in both directions
 * because each has a plausible twin that would be wrong:
 *
 * 1. **It steers and never dispatches.** The whole reason a long-lived credential
 *    in a home directory may hold these at all. A control that could start work
 *    would be the fleet's surface behind the operator's fence.
 * 2. **Every write goes through the object the cockpit's click goes through.** A
 *    second implementation beside `RuntimeControl`, `EscalationInbox` or
 *    `applyIssueWatch` would be a second opinion about what a pause or a watch
 *    means, free to disagree on the next change to either.
 * 3. **A row that cannot be settled here says where it is settled.** A proposal, a
 *    permission request answered as free text and a crashed agent's question are
 *    three refusals the cockpit's route already makes; a bare failure would leave
 *    the operator finding the row hours later.
 */

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

/** What the provider was asked to write — the only place a tag write is observable. */
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
      // Without this the suite cuts a real branch in whatever checkout it is
      // running in — see CLAUDE.md. Nothing here is about git behaviour.
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
  const server = new McpDesktopServer({
    ...desktopDeps(system),
    // The tag write is recorded rather than read back off the world baseline: the
    // cycle every steering call ends with refreshes the baseline from the provider,
    // so an assertion on the mirror would be asserting what the *fake provider*
    // last said rather than what the harness asked it to write.
    connector: {
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

/** A world with one issue in it, so `goal_control` has something to tag. */
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
  system.store.setWorldBaseline(snapshot);
}

// -- the surface -------------------------------------------------------------

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
      'agent_read',
      'queue_control',
      'goal_control',
    ])
      assert.ok(names.includes(name), `${name} is advertised`);
    assert.deepEqual(names.sort(), [...DESKTOP_TOOL_NAMES].sort(), 'and the list is exactly the declared one');

    // The fence, asserted as a fact about the fleet rather than about the tools:
    // no steering call may leave an agent behind it. `raw` mode would happily
    // start one, so this is a real assertion and not a tautology.
    await d.call('fleet_control', { cap: 5, paused: false });
    await d.call('queue_control', { order: ['issue:1:plan'] });
    await d.call('goal_control', { issue: 1, priority: true });
    assert.equal(d.system.store.listAgents().length, 0, 'steering the fleet started nothing');
  } finally {
    await d.close();
  }
});

// -- reading -----------------------------------------------------------------

test('fleet_status reports the cap, the pause and the headroom a pause removes', async () => {
  const d = await deck({ maxConcurrentAgents: 4 });
  try {
    const open = await d.call('fleet_status');
    assert.equal(open.isError, false);
    const control = open.json.control as Record<string, number | boolean>;
    assert.equal(control.cap, 4);
    assert.equal(control.paused, false);
    assert.equal(control.headroom, 4);

    // The one number a session reading `cap` alone gets wrong: a paused fleet
    // with slots free dispatches nothing, and reporting 4 would be a reading that
    // says there is room.
    await d.call('fleet_control', { paused: true });
    const paused = await d.call('fleet_status');
    assert.equal((paused.json.control as Record<string, unknown>).headroom, 0);
    assert.equal((paused.json.control as Record<string, unknown>).paused, true);

    // Null until a cycle has run, and said out loud rather than shipped as an
    // empty queue: the dispatcher has not yet decided anything.
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

    d.system.store.recordRateLimits({
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

// -- steering ----------------------------------------------------------------

test('fleet_control writes through RuntimeControl, and refuses what it refuses', async () => {
  const d = await deck();
  try {
    const set = await d.call('fleet_control', { cap: 7, paused: true });
    assert.equal(set.isError, false);
    // The point of the assertion: the same object the cockpit's POST /api/control
    // writes, not a copy of the number kept beside it.
    assert.equal(d.system.runtimeControl.snapshot().cap, 7);
    assert.equal(d.system.runtimeControl.snapshot().paused, true);

    // One answer to "which numbers are a legal cap", and it is RuntimeControl's.
    const bad = await d.call('fleet_control', { cap: -1 });
    assert.ok(bad.isError);
    assert.equal(d.system.runtimeControl.snapshot().cap, 7, 'and a refusal changes nothing');

    // A call that changes nothing is a session that meant to read.
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
      d.system.store.listPriorityOverrides().map((o) => o.origin),
      ['issue:2:plan', 'issue:3:plan'],
    );

    // It replaces rather than appends — which is a real thing to want and a
    // surprising thing to do by accident, so the tool says so in its description.
    await d.call('queue_control', { order: ['issue:9:plan'] });
    assert.deepEqual(
      d.system.store.listPriorityOverrides().map((o) => o.origin),
      ['issue:9:plan'],
    );

    // Two ranks for one row is meaningless, and would make the stored order
    // depend on insertion accident.
    const dupe = await d.call('queue_control', { order: ['issue:9:plan', 'issue:9:plan'] });
    assert.ok(dupe.isError);
    assert.equal(d.system.store.listPriorityOverrides().length, 1, 'and nothing was rewritten');

    const empty = await d.call('queue_control', {});
    assert.ok(empty.isError);
  } finally {
    await d.close();
  }
});

test('queue_control cancels a queued job and refuses one that has gone', async () => {
  const d = await deck();
  try {
    const job = d.system.store.createJob({ title: 'a brief', prompt: 'do a thing', kind: 'desk', branch: null });
    const cancelled = await d.call('queue_control', { cancelJob: job.id });
    assert.equal(cancelled.isError, false);
    assert.equal(d.system.store.getJob(job.id)?.status, 'cancelled');

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
    assert.equal(d.system.store.listGoalPriorities().length, 1, 'the harness’s own record, not a label');

    // The tag is the tracker's, and it is what actually opts the work in — so the
    // assertion is on what the provider was asked to write.
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
    // Reporting `watched: true` with nothing written would be a change that did
    // not happen and could not have — the gate is off and everything is worked.
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
    // Told "watched" on a write the provider refused, an operator would leave the
    // ticket believing the fleet will pick it up. It never will, and nothing is red.
    assert.ok(res.isError);
    assert.ok(res.text.includes('the provider is down'), 'the provider’s own reason reaches the caller intact');
  } finally {
    await d.close();
  }
});

// -- the inbox ---------------------------------------------------------------

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
    // No live agent was holding it, so the answer is on the record rather than in
    // a session — and the reply says which, because they are different futures.
    assert.equal(answered.json.routing, 'queued_for_dispatch');
    assert.equal(d.system.store.getEscalation(esc.id)?.response, 'the existing one');

    const twice = await d.call('escalation_answer', { id: esc.id, response: 'again' });
    assert.ok(twice.isError, 'an item already answered is a refusal');
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
    // The agent is blocked inside a tool call, not at a prompt: text would go
    // nowhere, and settling the row would leave it blocked for good.
    assert.ok(text.text.includes('permission'), 'and the refusal names what does settle it');
    assert.equal(d.system.store.getEscalation(esc.id)?.status, 'open', 'nothing was settled');

    // No desk is holding this one (no agent ever blocked on it), so the verdict
    // is refused rather than reported as delivered.
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
    assert.equal(d.system.store.getEscalation(esc.id)?.status, 'open');

    const blank = await d.call('escalation_answer', { id: esc.id, answers: [null, '  '] });
    assert.ok(blank.isError, 'and answering none of them is not an answer');

    const ok = await d.call('escalation_answer', { id: esc.id, answers: ['sqlite', null] });
    assert.equal(ok.isError, false);
    const response = d.system.store.getEscalation(esc.id)?.response ?? '';
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
