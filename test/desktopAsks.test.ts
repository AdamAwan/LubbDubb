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
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { desktopDeps } from './support/desktop.js';
import type { ToolCallResult } from '../src/mcp/protocol.js';
import type { DesktopChange } from '../src/mcp/desktopContext.js';
import type { ActionSink, PrAssignInput, PrAssignSink } from '../src/sink/actionSink.js';
import type { Issue, IssueRelative, PrPerson, PullRequest } from '../src/types.js';

const NOW = '2025-01-01T00:00:00.000Z';

interface Deck {
  system: System;
  assigned: PrAssignInput[];
  /** What the channel told the cockpit, in order — the hub broadcasts each one. */
  changes: DesktopChange[];
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }>;
  close(): Promise<void>;
}

function assignSink(assigned: PrAssignInput[]): ActionSink & PrAssignSink {
  const own: Partial<ActionSink & PrAssignSink> = {
    canAssignPr: () => true,
    assignPr: async (input) => {
      assigned.push(input);
      return { ok: true };
    },
  };
  return new Proxy(own, {
    get: (target, key) => target[key as keyof typeof target] ?? (() => false),
  }) as ActionSink & PrAssignSink;
}

async function deck(planWithheld = false): Promise<Deck> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-asks-'));
  const assigned: PrAssignInput[] = [];
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
      userId: 'me',
    }),
    {
      sink: assignSink(assigned),
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
  const server = new McpDesktopServer({
    ...desktopDeps(system),
    ...(planWithheld ? { planWithheld: () => true } : {}),
    now: () => NOW,
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\lubbdubb-asks-${Date.now()}` : join(dir, 'asks.sock'),
    credentialPath: join(dir, 'desktop.json'),
  });
  assert.ok(await server.listen(), 'the desktop channel starts on a throwaway path');
  const changes: DesktopChange[] = [];
  server.on('changed', (change) => changes.push(change));
  return {
    system,
    assigned,
    changes,
    call: async (name, args = {}) => {
      const session = server.session('c1');
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

test('the answering tools are the operator’s and never the fleet’s', () => {
  for (const name of ['sequence_answer', 'pr_assign', 'description_dismiss', 'description_write']) {
    assert.ok(DESKTOP_TOOL_NAMES.includes(name as never), `${name} is a desktop tool`);
    assert.ok(!MCP_TOOL_NAMES.includes(name as never), `${name} is not one the fleet can call`);
  }
});

const FEATURE: IssueRelative = {
  number: 500,
  title: 'Export',
  issueType: 'Feature',
  workItemState: 'Active',
  state: 'open',
  body: '',
};

function story(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Story ${number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    issueType: 'User Story',
    parent: FEATURE,
    ...over,
  };
}

function proposeOrder(system: System): void {
  system.store.world.setWorldBaseline({
    takenAt: NOW,
    pullRequests: [],
    issues: [story(500, { title: 'Export', issueType: 'Feature', parent: null }), story(11), story(12)],
  });
  system.store.sequences.recordFeatureSequence({
    originRef: 'issue:500',
    status: 'proposed',
    reason: '#12 reads the table #11 writes',
    unsure: null,
    standingKey: 'k',
    edges: [{ issue: 12, dependsOn: 11, source: 'inferred', reason: 'reads the table' }],
    members: [11, 12],
    agentId: null,
    taskId: null,
  });
}

test('sequence_answer accepts a proposed order through the store the route writes, as this session', async () => {
  const d = await deck();
  try {
    proposeOrder(d.system);
    const done = await d.call('sequence_answer', { issue: 12, answer: 'accept' });
    assert.equal(done.isError, false, done.text);
    assert.equal(done.json.feature, 500, 'a story resolves to its Feature');
    assert.equal(done.json.was, 'proposed');
    const stored = d.system.store.sequences.getFeatureSequence('issue:500');
    assert.equal(stored?.status, 'accepted');
    assert.match(String(stored?.answeredBy), /^desktop/, 'answered by the desktop session, by its label');
    assert.equal(stored?.edges.length, 1, 'answering keeps the order it answers');
  } finally {
    await d.close();
  }
});

test('sequence_answer declines, which releases every story, and refuses a Feature with no order', async () => {
  const d = await deck();
  try {
    proposeOrder(d.system);
    const declined = await d.call('sequence_answer', { issue: 500, answer: 'decline' });
    assert.equal(declined.isError, false, declined.text);
    assert.equal(d.system.store.sequences.getFeatureSequence('issue:500')?.status, 'declined');
    assert.match(String(declined.json.means), /eligible again/);

    d.system.store.world.setWorldBaseline({
      takenAt: NOW,
      pullRequests: [],
      issues: [story(21, { parent: { ...FEATURE, number: 600 } })],
    });
    const none = await d.call('sequence_answer', { issue: 600, answer: 'accept' });
    assert.ok(none.isError);
    assert.match(none.text, /no order to answer/);
    assert.equal(d.system.store.sequences.getFeatureSequence('issue:600'), null, 'nothing was written');

    const wrong = await d.call('sequence_answer', { issue: 500, answer: 'proposed' });
    assert.ok(wrong.isError, 'only a person’s two answers are accepted — "proposed" is an agent’s');
  } finally {
    await d.close();
  }
});

const carol: PrPerson = { id: 'carol', name: 'Carol' };
const dave: PrPerson = { id: 'dave', name: 'Dave' };

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `Change ${number}`,
    branch: `issue/${number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    state: 'open',
    author: 'me',
    viewerAuthored: true,
    assignees: [],
    ...over,
  };
}

function seedPrs(system: System): void {
  system.store.prArchive.archiveClosedPrs([
    pr(1, { state: 'merged', merged: true, assignees: [carol] }),
    pr(2, { state: 'merged', merged: true, assignees: [dave] }),
    pr(3, { state: 'merged', merged: true, assignees: [carol] }),
  ]);
  system.store.world.setWorldBaseline({ takenAt: NOW, pullRequests: [pr(7), pr(8)], issues: [] });
}

test('pr_assign reads the shortlist, assigns by name through the desk, and declines', async () => {
  const d = await deck();
  try {
    seedPrs(d.system);
    const read = await d.call('pr_assign', { pr: 7 });
    assert.equal(read.isError, false, read.text);
    assert.deepEqual(read.json.shortlist, [carol, dave], 'the same shortlist the cockpit offers');
    assert.equal(d.assigned.length, 0, 'reading assigns nobody');

    assert.deepEqual(d.changes, [], 'and tells the cockpit nothing');

    const stranger = await d.call('pr_assign', { pr: 7, person: 'eve' });
    assert.ok(stranger.isError);
    assert.match(stranger.text, /not on the shortlist/);

    const done = await d.call('pr_assign', { pr: 7, person: 'Carol' });
    assert.equal(done.isError, false, done.text);
    assert.deepEqual(d.assigned, [{ prNumber: 7, personId: 'carol' }]);
    assert.ok(d.system.store.prAssignAsks.isAnswered(7));
    assert.deepEqual(d.changes, [{ type: 'world:changed' }], 'the cockpit is told, as the route tells it');

    const twice = await d.call('pr_assign', { pr: 7, person: 'dave' });
    assert.ok(twice.isError, 'an answered ask is not answered again');

    const declined = await d.call('pr_assign', { pr: 8, decline: true });
    assert.equal(declined.isError, false, declined.text);
    assert.ok(d.system.store.prAssignAsks.isAnswered(8));
    assert.equal(d.assigned.length, 1, 'declining writes nothing to the tracker');
    assert.equal(d.changes.length, 2, 'a decline is broadcast too, and a refusal never is');

    const gone = await d.call('pr_assign', { pr: 99, decline: true });
    assert.ok(gone.isError, 'a pull request that is not open is refused');
  } finally {
    await d.close();
  }
});

test('description_dismiss leaves a check’s findings as they are, and refuses a description with none', async () => {
  const d = await deck();
  try {
    const originRef = 'issue:4:part:a';
    d.system.store.prDescriptions.recordPrBody({ originRef, prNumber: 12, tail: 'footer' });
    const version = d.system.store.prDescriptions.appendDescription({ originRef, text: 'Adds X.', author: 'me' });

    const unchecked = await d.call('description_dismiss', { pr: 12 });
    assert.ok(unchecked.isError, 'nothing to leave on an unchecked description');

    d.system.store.prDescriptions.recordCheck({
      id: version.id,
      findings: [{ kind: 'contradicted', note: 'it does not add X', question: null }],
    });
    const left = await d.call('description_dismiss', { pr: 12 });
    assert.equal(left.isError, false, left.text);
    const current = d.system.store.prDescriptions.currentDescription(originRef);
    assert.notEqual(current?.dismissedAt, null, 'the version is stamped');
    assert.equal(current?.findings.length, 1, 'and the findings stay readable');
    assert.equal(current?.text, 'Adds X.', 'the text is untouched — this channel never writes one');
    assert.deepEqual(d.changes, [{ type: 'dirty', sections: ['plans'] }], 'the route’s own broadcast, once');
  } finally {
    await d.close();
  }
});

test('description_write saves the operator’s words verbatim as a new version, marked as entered here', async () => {
  const d = await deck();
  try {
    const originRef = 'issue:4:part:a';
    d.system.store.prDescriptions.recordPrBody({ originRef, prNumber: 12, tail: 'footer' });

    const written = await d.call('description_write', { pr: 12, text: '  Reconciles the empty statements.  ' });
    assert.equal(written.isError, false, written.text);
    const current = d.system.store.prDescriptions.currentDescription(originRef);
    assert.equal(current?.text, 'Reconciles the empty statements.', 'their words, trimmed and nothing else');
    assert.equal(current?.author, 'me', 'under the operator, as the cockpit writes it');
    assert.equal(current?.via, 'claude-code', 'and recorded as entered through their session');
    assert.equal(current?.version, 1);
    assert.deepEqual(d.changes, [{ type: 'dirty', sections: ['plans'] }], 'the route’s own broadcast, once');

    const rewrite = await d.call('description_write', { pr: 12, text: 'Second go.' });
    assert.equal(rewrite.isError, false, rewrite.text);
    assert.equal(d.system.store.prDescriptions.currentDescription(originRef)?.version, 2, 'a rewrite is a new version');

    const cockpit = d.system.store.prDescriptions.appendDescription({
      originRef,
      text: 'From the field.',
      author: 'me',
    });
    assert.equal(cockpit.via, 'cockpit', 'the field on the page is the default channel');

    assert.ok((await d.call('description_write', { pr: 12, text: '   ' })).isError, 'an empty description is refused');
    assert.ok((await d.call('description_write', { pr: 99, text: 'x' })).isError, 'as is a pull request no part owns');
  } finally {
    await d.close();
  }
});

test('escalation_answer dismisses a question without answering it, and sends a proposal to proposal_decide', async () => {
  const d = await deck();
  try {
    const esc = d.system.escalations.create({
      type: 'answer_question',
      prompt: 'Which database?',
      context: { originRef: 'issue:7' },
      agentId: null,
      taskId: null,
    });
    const dismissed = await d.call('escalation_answer', { id: esc.id, dismiss: true, note: 'moot now' });
    assert.equal(dismissed.isError, false, dismissed.text);
    const row = d.system.store.escalations.getEscalation(esc.id);
    assert.notEqual(row?.status, 'open');
    assert.equal(row?.response ?? null, null, 'no answer was recorded');

    const asked = d.system.escalations.create({
      type: 'answer_question',
      prompt: 'Merge it?',
      context: {},
      agentId: null,
      taskId: null,
    });
    const proposal = d.system.store.escalations.createProposal({
      kind: 'merge',
      ref: 'pr:42:merge',
      action: { type: 'merge_pr', prNumber: 42, method: 'squash', confidence: 0.9, reason: 'green' },
      escalationId: asked.id,
    });
    const inbox = await d.call('attention_read');
    const rows = inbox.json.inbox as Record<string, unknown>[];
    const proposalRow = rows.find((r) => r.id === asked.id);
    assert.equal(proposalRow?.kind, 'proposal');
    assert.match(String(proposalRow?.settledBy), /proposal_decide/, 'the row names the tool, not the cockpit');
    assert.doesNotMatch(String(proposalRow?.settledBy), /cockpit/);

    const refused = await d.call('escalation_answer', { id: asked.id, dismiss: true });
    assert.ok(refused.isError);
    assert.match(refused.text, new RegExp(`proposal_decide on id ${proposal.id}`));
    assert.equal(
      d.system.store.escalations.listProposals().find((p) => p.id === proposal.id)?.status,
      'pending',
      'a dismissal never decides an act',
    );
  } finally {
    await d.close();
  }
});

test('proposal_decide refuses a withheld plan, as the cockpit’s routes do, and keeps `declined` to check sets', async () => {
  const d = await deck(true);
  try {
    const plan = d.system.store.escalations.createProposal({
      kind: 'plan',
      ref: 'issue:12:plan',
      action: { type: 'propose_plan', reason: 'x', planId: 'plan_hidden' } as never,
      escalationId: null,
    });
    for (const verdict of ['accept', 'reject', 'hold_ticket']) {
      const refused = await d.call('proposal_decide', { id: plan.id, verdict });
      assert.ok(refused.isError, `${verdict} is refused`);
      assert.match(refused.text, /not been revealed/);
    }
    assert.equal(d.system.store.escalations.listProposals().find((p) => p.id === plan.id)?.status, 'pending');
  } finally {
    await d.close();
  }

  const e = await deck();
  try {
    const merge = e.system.store.escalations.createProposal({
      kind: 'merge',
      ref: 'pr:42:merge',
      action: { type: 'merge_pr', prNumber: 42, method: 'squash', confidence: 0.9, reason: 'green' },
      escalationId: null,
    });
    const wrong = await e.call('proposal_decide', {
      id: merge.id,
      verdict: 'accept',
      declined: [{ letter: 'A', reason: 'no' }],
    });
    assert.ok(wrong.isError);
    assert.match(wrong.text, /validation check set only/);
    assert.equal(e.system.store.escalations.listProposals().find((p) => p.id === merge.id)?.status, 'pending');
  } finally {
    await e.close();
  }
});
