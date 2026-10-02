import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { answerWith } from '../src/mcp/askAnswers.js';
import { askQueue } from '../src/server/stateSnapshot.js';
import type { AskRow } from '../src/asks/askRow.js';
import type { ProposalKind } from '../src/types.js';
import type { SetupReading } from '../src/setup/reading.js';
import type { ToolCallResult } from '../src/mcp/protocol.js';
import { desktopDeps } from './support/desktop.js';

/* → docs/spec/11-mcp-tools.md#the-next-ask-loop */

const NOW = '2025-01-01T00:00:00.000Z';

interface Deck {
  system: System;
  call(
    name: string,
    args?: Record<string, unknown>,
    connection?: string,
  ): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function deck(): Promise<Deck> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-asknext-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
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
    now: () => NOW,
    socketPath:
      process.platform === 'win32' ? `\\\\.\\pipe\\lubbdubb-asknext-${Date.now()}` : join(dir, 'asknext.sock'),
    credentialPath: join(dir, 'desktop.json'),
  });
  assert.ok(await server.listen(), 'the desktop channel starts on a throwaway path');
  return {
    system,
    call: async (name, args = {}, connection = 'c1') => {
      const session = server.session(connection);
      assert.ok(session);
      const result = (await session.call(name, args)) as ToolCallResult;
      const text = result.content[0]?.text ?? '';
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // A refusal is prose, not JSON.
      }
      return { isError: result.isError === true, text, json };
    },
    close: async () => {
      await server.close();
      system.store.close();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

async function seed(system: System): Promise<{ question: string; merge: string; bench: string; proposal: string }> {
  const { escalations, humanTasks } = system.store;
  const bench = humanTasks.recordHumanTask({
    title: 'Provision the staging credentials',
    detail: null,
    agentId: null,
    taskId: null,
    originRef: null,
  }).task;
  await tick();
  const question = escalations.createEscalation({
    type: 'answer_question',
    prompt: 'Which store should this write to?\nThe cache or the database.',
    context: {},
    agentId: null,
    taskId: null,
  });
  await tick();
  const merge = escalations.createEscalation({
    type: 'approve_change',
    prompt: 'Merge PR #7?',
    context: { prNumber: 7 },
    agentId: null,
    taskId: null,
  });
  const proposal = escalations.createProposal({
    kind: 'merge',
    ref: 'pr:7',
    action: { type: 'merge_pr', reason: 'green', prNumber: 7 } as never,
    escalationId: merge.id,
  });
  return { question: question.id, merge: merge.id, bench: bench.id, proposal: proposal.id };
}

test('ask_next hands back the head of askQueue, with where it stands and the call that answers it', async () => {
  const d = await deck();
  try {
    const ids = await seed(d.system);
    assert.equal(askQueue(d.system)[0]?.id, ids.merge, 'the merge leads the one-at-a-time order');

    const next = await d.call('ask_next');
    assert.equal(next.isError, false, next.text);
    assert.equal((next.json.ask as { id: string }).id, ids.merge);
    assert.equal(next.json.position, 1);
    assert.equal(next.json.total, 3);
    assert.equal(next.json.remaining, 3);
    assert.deepEqual(next.json.answerWith, {
      in: 'claude-code',
      tool: 'proposal_decide',
      args: { id: ids.proposal },
      choose: {
        verdict: '"accept" MERGES the pull request — it cannot be undone from here; "reject" leaves it unmerged.',
        note: 'The reason, recorded with the verdict. Ask for one on a rejection.',
      },
      readFirst: [{ tool: 'proposal_read', args: { id: ids.proposal } }],
    });
    assert.equal(next.json.question, undefined, 'a proposal is read with proposal_read, not quoted here');
  } finally {
    await d.close();
  }
});

test('a skip is held by the connection that made it, and never touches the queue itself', async () => {
  const d = await deck();
  try {
    const ids = await seed(d.system);

    const skipped = await d.call('ask_skip', { id: ids.merge });
    assert.equal(skipped.isError, false, skipped.text);

    const next = await d.call('ask_next');
    const ask = next.json.ask as { id: string };
    assert.equal(ask.id, ids.question, 'this session moves on to the one after it');
    assert.equal(next.json.position, 2, 'and says where that one stands in the whole queue');
    assert.equal(next.json.remaining, 2);
    assert.equal(next.json.skipped, 1);
    assert.deepEqual(next.json.answerWith, {
      in: 'claude-code',
      tool: 'escalation_answer',
      args: { id: ids.question },
      choose: {
        response: 'Free text, read by the agent verbatim and acted on.',
        answers: 'One answer per question, in order, where the ask carries `questions` (null for one left unanswered).',
        dismiss: 'true clears it without an answer, releasing the agent told nothing — only on the say-so.',
      },
    });
    assert.equal(
      (next.json.question as { prompt: string }).prompt,
      'Which store should this write to?\nThe cache or the database.',
      "an agent's question is handed back whole, not as the row's one line",
    );

    const other = await d.call('ask_next', {}, 'c2');
    assert.equal((other.json.ask as { id: string }).id, ids.merge, 'a second connection never saw the skip');
    assert.equal(askQueue(d.system)[0]?.id, ids.merge, 'and the queue the cockpit reads is unchanged');

    const passed = await d.call('ask_next', { skip: [ids.question] });
    assert.equal((passed.json.ask as { id: string }).id, ids.bench, '`skip` passes over more, for this call only');
    assert.deepEqual((passed.json.answerWith as { tool: string; args: unknown }).tool, 'human_task_settle');
    assert.deepEqual((passed.json.answerWith as { args: unknown }).args, { id: ids.bench });

    await d.call('ask_skip', { id: ids.merge, undo: true });
    assert.equal(((await d.call('ask_next')).json.ask as { id: string }).id, ids.merge, 'undo brings it back');
  } finally {
    await d.close();
  }
});

test('ask_next with an id hands back that ask, skipped or not, and refuses one not standing', async () => {
  const d = await deck();
  try {
    const ids = await seed(d.system);
    await d.call('ask_skip', { id: ids.bench });

    const picked = await d.call('ask_next', { id: ids.bench });
    assert.equal(picked.isError, false, picked.text);
    assert.equal((picked.json.ask as { id: string }).id, ids.bench, 'the panel picked it, so a skip does not hide it');
    assert.equal(picked.json.position, 3);
    assert.equal((picked.json.answerWith as { tool: string }).tool, 'human_task_settle');

    const gone = await d.call('ask_next', { id: 'nope' });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /No standing ask "nope"/);
  } finally {
    await d.close();
  }
});

test('ask_skip refuses an ask that is not standing', async () => {
  const d = await deck();
  try {
    const refused = await d.call('ask_skip', { id: 'nope' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /No standing ask "nope"/);
  } finally {
    await d.close();
  }
});

test('an empty queue says so, and one emptied by skips says what is left', async () => {
  const d = await deck();
  try {
    const empty = await d.call('ask_next');
    assert.equal(empty.isError, false);
    assert.equal(empty.json.empty, true);
    assert.equal(empty.json.said, 'Nothing in "Needs you" is waiting on the operator.');

    const ids = await seed(d.system);
    for (const id of [ids.merge, ids.question, ids.bench]) await d.call('ask_skip', { id });
    const skipped = await d.call('ask_next');
    assert.equal(skipped.json.empty, true);
    assert.deepEqual(skipped.json.skipped, [ids.merge, ids.question, ids.bench]);
    assert.match(String(skipped.json.said), /skipped in this session/);
  } finally {
    await d.close();
  }
});

test('a settled ask leaves the head, which is how the loop moves on', async () => {
  const d = await deck();
  try {
    const ids = await seed(d.system);
    d.system.store.escalations.answerEscalation(ids.merge, 'merged by hand');
    assert.equal(((await d.call('ask_next')).json.ask as { id: string }).id, ids.question);
  } finally {
    await d.close();
  }
});

function row(over: Partial<AskRow>): AskRow {
  return {
    id: 'r1',
    kind: 'escalation',
    subject: { type: 'issue', issueNumber: 284 },
    group: 'yours',
    urgency: 'next',
    focusRank: 0,
    standing: true,
    title: 'x',
    goalRef: 'issue:284',
    originRef: 'issue:284',
    opens: 'goal',
    agentId: null,
    agentLabel: null,
    holding: 0,
    raisedAt: NOW,
    ...over,
  };
}

const CTX = {
  link: 'http://127.0.0.1:4300/?ask=r1',
  profileNames: ['fast', 'deep'],
  proposalKind: (): ProposalKind | null => 'plan',
};

test('answerWith sends the cockpit-only kinds to the cockpit, with a link and a reason', () => {
  for (const kind of ['sitting', 'config', 'upgrade', 'limit'] as const) {
    const answer = answerWith(row({ kind }), CTX);
    assert.equal(answer.in, 'cockpit', kind);
    assert.equal(answer.in === 'cockpit' ? answer.link : null, CTX.link);
    assert.ok(answer.in === 'cockpit' && answer.why.length > 0);
  }
  for (const kind of ['assigned', 'dispatch'] as const) {
    assert.equal(answerWith(row({ kind }), CTX).in, 'nowhere', `${kind} has no decision to make`);
  }
});

test('answerWith fills the ids each kind is answered by', () => {
  assert.deepEqual(answerWith(row({ kind: 'intake' }), CTX), {
    in: 'claude-code',
    tool: 'goal_gate',
    args: { issue: 284 },
    choose: {
      appraisal: '"workable" works it anyway; "unclear" agrees and keeps it held; "clear" has it appraised afresh.',
      summary: 'Why, in the operator’s words.',
    },
    readFirst: [{ tool: 'goal_read', args: { issue: 284 } }],
  });
  const profile = answerWith(row({ kind: 'profile' }), CTX);
  assert.ok(profile.in === 'claude-code' && profile.tool === 'goal_control');
  assert.match(profile.choose.profile ?? '', /One of: fast, deep/);

  const placement = answerWith(row({ kind: 'placement', placementField: 'areaPath' }), CTX);
  assert.ok(placement.in === 'claude-code' && 'areaPath' in placement.choose);

  const recovery = answerWith(row({ kind: 'recovery', subject: { type: 'recovery', taskIds: ['t1', 't2'] } }), CTX);
  assert.ok(recovery.in === 'claude-code');
  assert.deepEqual(recovery.args, { taskId: 't1' });
  assert.match(recovery.note ?? '', /t2/);

  const describe = answerWith(
    row({ kind: 'describe', subject: { type: 'part', originRef: 'issue:284:part:a', prNumber: 312 } }),
    CTX,
  );
  assert.ok(describe.in === 'claude-code' && describe.tool === 'description_write');
  assert.deepEqual(describe.args, { pr: 312 }, 'the ask names the pull request; the words are the operator’s');
  assert.match(describe.choose.text ?? '', /verbatim/, 'and the session is told to carry them, never to draft');

  const assign = answerWith(row({ kind: 'assign', subject: { type: 'pull_request', prNumber: 312 } }), CTX);
  assert.ok(assign.in === 'claude-code' && assign.tool === 'pr_assign');
  assert.deepEqual(assign.args, { pr: 312 });

  const mismatchedPlan = answerWith(row({ kind: 'plan' }), CTX);
  assert.equal(mismatchedPlan.in, 'cockpit');

  const mismatched = answerWith(row({ kind: 'bench', subject: { type: 'issue', issueNumber: 284 } }), CTX);
  assert.equal(mismatched.in, 'cockpit', 'a row whose record no tool here answers goes to its panel');
});

test('a withheld plan goes to the cockpit on the withheld fact, whatever page the row opens', () => {
  const subject = { type: 'escalation' as const, escalationId: 'e1', proposalId: 'p1' };
  for (const opens of ['prediction', 'goal', null] as const) {
    const withheld = answerWith(row({ kind: 'plan', opens, subject: { ...subject, planWithheld: true } }), CTX);
    assert.equal(withheld.in, 'cockpit', `withheld, opening ${opens}`);
    assert.match(withheld.in === 'cockpit' ? withheld.why : '', /reveals it/);
  }
  const revealed = answerWith(row({ kind: 'plan', opens: 'prediction', subject }), CTX);
  assert.ok(revealed.in === 'claude-code' && revealed.tool === 'proposal_decide', 'a revealed plan is decided here');
});

test('a plan amendment is offered only the verdicts an amendment takes', () => {
  const subject = { type: 'escalation' as const, escalationId: 'e1', proposalId: 'p1' };
  const plan = answerWith(row({ kind: 'plan', subject }), CTX);
  assert.ok(plan.in === 'claude-code');
  assert.match(plan.choose.verdict ?? '', /close_ticket/, 'a plan has the ticket verdicts');

  const amendment = answerWith(row({ kind: 'plan', subject }), { ...CTX, proposalKind: () => 'plan_amendment' });
  assert.ok(amendment.in === 'claude-code');
  assert.doesNotMatch(amendment.choose.verdict ?? '', /close_ticket|hold_ticket/, 'which the server refuses here');
  assert.match(amendment.choose.verdict ?? '', /"accept".*"reject"/);
});

const SETUP: SetupReading = {
  configFile: '/x/lubbdubb.config.json',
  configFileExists: true,
  prefill: { email: null, repoRoot: '/x', repoRootIsSelf: false },
  checks: [
    { id: 'gh', label: 'GitHub CLI', verdict: 'bad', detail: 'gh is not logged in' },
    { id: 'node', label: 'Node', verdict: 'ok', detail: 'Node is fine' },
  ],
};

test('ask_next reads the setup reading the cockpit reads, and sends a config ask to the cockpit', async () => {
  const d = await deck();
  try {
    d.system.setupReading.latest = SETUP;
    const next = await d.call('ask_next');
    const ask = next.json.ask as { id: string; kind: string };
    assert.equal(ask.id, 'setup:gh', 'the standing config row is in the queue, as the board sees it');
    assert.equal(next.json.total, 1, 'and a check reading ok is not');
    assert.deepEqual(next.json.answerWith, {
      in: 'cockpit',
      why: 'A deployment setting, changed on the setup page where it can show what it changes.',
      link: 'http://127.0.0.1:4300/?ask=setup%3Agh',
    });
  } finally {
    await d.close();
  }
});
