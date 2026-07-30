import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MAX_RETRO_DOCUMENT, retroOrigin, retroSubmitOrigin, validateRetrospective } from '../src/retro/retro.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Agent } from '../src/types.js';

/** The MCP tool-result shape, as a caller reads it off the wire. */
interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(overrides: Record<string, unknown> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-retro-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      dispatcher: 'rule',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      ...overrides,
    }),
    { backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

/** Spawn an agent on `originRef`. A temp cwd is enough — nothing here touches git. */
function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
    kind: 'desk',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: null,
    originRef,
    originTitle: 'Add a widget',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

// -- the row -----------------------------------------------------------------

test('a retrospective upserts on the issue and lists as an origin', () => {
  const store = new Store(':memory:');
  assert.equal(store.getRetrospective('issue:12'), null);
  assert.deepEqual(store.listRetrospectiveOrigins(), []);

  const first = store.recordRetrospective({
    originRef: 'issue:12',
    summary: 'Delivered in three parts; two agents were spent on a red base.',
    document: '# What shipped\n\n...',
    agentId: 'a1',
    taskId: 't1',
  });
  const second = store.recordRetrospective({
    originRef: 'issue:12',
    summary: 'Revised summary.',
    document: '# What shipped\n\nrevised',
    agentId: 'a1',
    taskId: 't1',
  });

  assert.deepEqual(store.listRetrospectiveOrigins(), ['issue:12'], 'a second submission revises one row');
  assert.equal(store.getRetrospective('issue:12')?.summary, 'Revised summary.');
  assert.equal(second.createdAt, first.createdAt, 'the row still dates when the run was first written up');
  assert.ok(second.updatedAt >= first.updatedAt);
  store.close();
});

// -- the pure layer ----------------------------------------------------------

test('the retro origin is its own, and only a retro agent may submit', () => {
  assert.equal(retroOrigin(12), 'issue:12:retro');
  assert.deepEqual(retroSubmitOrigin('issue:12:retro'), { ok: true, issueOrigin: 'issue:12' });
  for (const other of ['issue:12', 'issue:12:part:schema', 'issue:12:assess', 'pr:42:ci', 'job:j1', null]) {
    const refused = retroSubmitOrigin(other);
    assert.equal(refused.ok, false, `${other} must not write an issue's retrospective`);
    if (refused.ok) continue;
    // Refused by name, and pointed at the tool it actually wants.
    assert.match(refused.error, /conclude_work|conclude_part/);
  }
});

test('a retrospective needs a summary and keeps an over-long document, trimmed', () => {
  assert.equal(validateRetrospective({ document: 'x' }).ok, false, 'a document with no summary is refused');
  assert.equal(validateRetrospective({ summary: 'ok' }).ok, false, 'a summary with no document is refused');
  const long = validateRetrospective({ summary: 'ok', document: 'y'.repeat(MAX_RETRO_DOCUMENT + 10) });
  assert.equal(long.ok, true);
  if (!long.ok) return;
  assert.equal(long.trimmed, true);
  assert.equal(long.document.length, MAX_RETRO_DOCUMENT);
});

// -- the tool ----------------------------------------------------------------

test('only the retro agent may submit, and a second call revises one row', async () => {
  const system = build();
  const retro = spawnAgent(system, 'issue:12:retro');

  const first = await callTool(system, retro, 'retro_submit', {
    summary: 'Three parts, one red base, two agents spent on somebody else’s CI.',
    document: '# What shipped\n\nThe schema part and the dispatcher part.',
  });
  assert.equal(first.isError, false);
  assert.match(system.store.getRetrospective('issue:12')?.document ?? '', /schema part/);

  const again = await callTool(system, retro, 'retro_submit', {
    summary: 'Revised.',
    document: '# What shipped\n\nRevised.',
  });
  assert.equal(again.isError, false);
  assert.deepEqual(system.store.listRetrospectiveOrigins(), ['issue:12'], 'a revision is one row, not two');
  assert.equal(system.store.getRetrospective('issue:12')?.summary, 'Revised.');

  // The agent that did the work cannot write the account of it.
  const worker = spawnAgent(system, 'issue:12');
  const refused = await callTool(system, worker, 'retro_submit', { summary: 'mine', document: 'mine' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /conclude_work/);
  system.store.close();
});

test('a submission with no summary is refused, and an over-long document is kept', async () => {
  const system = build();
  const retro = spawnAgent(system, 'issue:9:retro');

  const noSummary = await callTool(system, retro, 'retro_submit', { document: 'the whole story' });
  assert.equal(noSummary.isError, true);
  assert.equal(system.store.getRetrospective('issue:9'), null, 'a refused submission lands nowhere');

  const long = await callTool(system, retro, 'retro_submit', {
    summary: 'ok',
    document: 'z'.repeat(MAX_RETRO_DOCUMENT + 10),
  });
  assert.equal(long.isError, false);
  assert.match(long.text, /"trimmed":\s*true/);
  assert.equal(system.store.getRetrospective('issue:9')?.document.length, MAX_RETRO_DOCUMENT);
  system.store.close();
});
