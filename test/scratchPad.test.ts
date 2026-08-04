import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PAD_NOTE, normalisePadNote, padOriginFor, padWriteTarget } from '../src/scratch/pad.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Agent } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildApp } from '../src/server/app.js';

/** The MCP tool-result shape, as a caller reads it off the wire. */
interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pad-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

/** Spawn an agent on `originRef`. A temp cwd is enough — nothing here touches git. */
function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Big thing',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('padOriginFor maps every origin in an issue subtree to the issue', () => {
  assert.equal(padOriginFor('issue:12'), 'issue:12');
  assert.equal(padOriginFor('issue:12:plan'), 'issue:12');
  assert.equal(padOriginFor('issue:12:assay'), 'issue:12');
  assert.equal(padOriginFor('issue:12:assess'), 'issue:12');
  assert.equal(padOriginFor('issue:12:retro'), 'issue:12');
  assert.equal(padOriginFor('issue:12:part:schema'), 'issue:12');
});

test('padOriginFor refuses everything outside one issue', () => {
  assert.equal(padOriginFor('pr:42:ci'), null);
  assert.equal(padOriginFor('job:job_abc'), null);
  assert.equal(padOriginFor('epic:e-1:work'), null);
  assert.equal(padOriginFor(null), null);
  assert.equal(padOriginFor('issue:notanumber'), null);
});

test('padWriteTarget names the tool a refused caller actually wants', () => {
  assert.deepEqual(padWriteTarget('issue:12:part:schema'), { ok: true, padRef: 'issue:12' });
  const refused = padWriteTarget('pr:42:ci');
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error, /pr:42:ci/);
  assert.match(refused.error, /report_finding|note_progress/);
});

test('a pad note is trimmed rather than refused, and says so', () => {
  const long = normalisePadNote('x'.repeat(MAX_PAD_NOTE + 50), undefined);
  assert.equal(long.ok, true);
  if (!long.ok) return;
  assert.equal(long.trimmed, true);
  assert.equal(long.note.length, MAX_PAD_NOTE);
  assert.equal(long.topic, null);
});

test('pad entries are appended and read back oldest first, one pad per issue', () => {
  const store = new Store(':memory:');
  store.appendScratchEntry({
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:schema',
    agentId: 'a1',
    taskId: 't1',
    topic: 'store',
    note: 'the migration needed a PRAGMA check',
  });
  store.appendScratchEntry({
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:dispatcher',
    agentId: 'a2',
    taskId: 't2',
    topic: null,
    note: 'reused the schema part branch as a base',
  });
  store.appendScratchEntry({
    padRef: 'issue:99',
    authorOriginRef: 'issue:99',
    agentId: 'a3',
    taskId: 't3',
    topic: null,
    note: 'another goal entirely',
  });

  const entries = store.listScratchEntries('issue:12');
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.note, 'the migration needed a PRAGMA check');
  assert.equal(entries[0]?.authorOriginRef, 'issue:12:part:schema');
  assert.equal(entries[0]?.topic, 'store');
  assert.equal(entries[1]?.topic, null);
  assert.ok((entries[0]?.createdAt ?? '') <= (entries[1]?.createdAt ?? ''));
  assert.deepEqual(
    store.listScratchEntries('issue:99').map((e) => e.note),
    ['another goal entirely'],
  );
  assert.deepEqual(store.listScratchEntries('issue:7'), []);
});

test('an empty note is refused; a topic is collapsed to one short line', () => {
  assert.equal(normalisePadNote('   ', undefined).ok, false);
  const withTopic = normalisePadNote('the migration needed a PRAGMA check', '  store\nschema  ');
  assert.equal(withTopic.ok, true);
  if (!withTopic.ok) return;
  assert.equal(withTopic.topic, 'store schema');
  assert.equal(withTopic.trimmed, false);
});

// -- the tool channel --------------------------------------------------------

test('the pad is shared across one issue and reached only through the credential', async () => {
  const system = build();
  const partA = spawnAgent(system, 'issue:12:part:schema');
  const partB = spawnAgent(system, 'issue:12:part:dispatcher');
  const other = spawnAgent(system, 'issue:99');

  const wrote = await callTool(system, partA, 'scratch_append', {
    note: 'the store needed a PRAGMA check before the ALTER',
    topic: 'store',
  });
  assert.equal(wrote.isError, false);
  assert.match(wrote.text, /issue:12/);

  // The point of the pad: a sibling reads what it never saw happen.
  const read = await callTool(system, partB, 'scratch_read', {});
  assert.equal(read.isError, false);
  assert.match(read.text, /PRAGMA check/);
  assert.match(read.text, /issue:12:part:schema/, 'entries are attributed to the origin that wrote them');

  // ...and another goal's agent sees none of it, without having to be told.
  const elsewhere = await callTool(system, other, 'scratch_read', {});
  assert.equal(elsewhere.isError, false);
  assert.doesNotMatch(elsewhere.text, /PRAGMA check/);
  system.store.close();
});

test('an agent outside an issue subtree is refused, and told which tool it wants', async () => {
  const system = build();
  for (const origin of ['pr:42:ci', 'job:job_abc', 'epic:e-1:work']) {
    const agent = spawnAgent(system, origin);
    const res = await callTool(system, agent, 'scratch_append', { note: 'anything' });
    assert.equal(res.isError, true, `${origin} must not reach a pad`);
    assert.match(res.text, /report_finding|note_progress/);
    const read = await callTool(system, agent, 'scratch_read', {});
    assert.equal(read.isError, true, 'a refused reader is refused, never handed an empty pad');
  }
  system.store.close();
});

test('an over-long note is stored trimmed, and an empty one is refused', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  const long = await callTool(system, agent, 'scratch_append', { note: 'y'.repeat(MAX_PAD_NOTE + 10) });
  assert.equal(long.isError, false);
  assert.match(long.text, /"trimmed":\s*true/);
  assert.equal(system.store.listScratchEntries('issue:12')[0]?.note.length, MAX_PAD_NOTE);

  const empty = await callTool(system, agent, 'scratch_append', { note: '   ' });
  assert.equal(empty.isError, true);
  assert.equal(system.store.listScratchEntries('issue:12').length, 1, 'a refused note lands nowhere');
  system.store.close();
});

test('nothing in the dispatcher reads the pad', () => {
  const dir = join(process.cwd(), 'src', 'dispatcher');
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes('scratch/pad'));
  assert.deepEqual(
    offenders,
    [],
    'a rule reading pad notes would let one agent’s prose suppress another agent’s dispatch',
  );
});

// -- what the cockpit is served ----------------------------------------------

test('the snapshot ships the pad reading and the trail is fetched on demand', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'Something nobody wrote about' });
  await system.harness.runCycle('manual');

  const part = spawnAgent(system, 'issue:12:part:schema');
  await callTool(system, part, 'scratch_append', {
    note: 'the ALTER needed a PRAGMA check first, and the migration is where that has to go',
    topic: 'store',
  });
  await callTool(system, part, 'scratch_append', { note: 'second thing learned' });

  const built = await buildApp(system);
  const app = built.app;
  const state = await app.inject({ method: 'GET', url: '/api/state' });
  const issues = state.json().world.issues as { number: number; scratchpad: unknown }[];
  assert.deepEqual(issues.find((i) => i.number === 12)?.scratchpad, {
    entries: 2,
    updatedAt: system.store.listScratchEntries('issue:12')[1]?.createdAt,
  });
  // A goal nobody wrote about is null, never a zero: the control that opens the
  // pad is keyed on this, and a button whose only answer is "nothing here" is
  // worse than no button.
  assert.equal(issues.find((i) => i.number === 13)?.scratchpad, null);
  // The snapshot is polled continuously, so the prose itself must not ride on it.
  assert.doesNotMatch(state.body, /PRAGMA check/);

  const pad = await app.inject({ method: 'GET', url: '/api/scratchpads/issue:12' });
  assert.equal(pad.statusCode, 200);
  assert.equal(pad.json().padRef, 'issue:12');
  assert.deepEqual(
    (pad.json().entries as { note: string }[]).map((e) => e.note.slice(0, 6)),
    ['the AL', 'second'],
    'the trail is served oldest first, the order it was written in',
  );

  // The route resolves a ref through the same `padOriginFor` an agent's write goes
  // through, so any origin on the goal names the one pad — the cockpit and the
  // tool channel cannot disagree about which pad a ref means.
  const viaPart = await app.inject({ method: 'GET', url: '/api/scratchpads/issue:12:part:schema' });
  assert.equal(viaPart.json().padRef, 'issue:12');
  assert.equal((viaPart.json().entries as unknown[]).length, 2);

  // An untouched pad is an empty trail, which is an ordinary answer...
  const untouched = await app.inject({ method: 'GET', url: '/api/scratchpads/issue:13' });
  assert.equal(untouched.statusCode, 200);
  assert.deepEqual(untouched.json().entries, []);
  // ...while a ref that names no pad at all is a bad request, not an empty one.
  const notAPad = await app.inject({ method: 'GET', url: '/api/scratchpads/pr:42' });
  assert.equal(notAPad.statusCode, 400);

  await app.close();
  system.store.close();
});
