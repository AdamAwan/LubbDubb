import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { goalOriginFor, padOriginFor } from '../src/scratch/pad.js';
import { buildTools } from '../src/mcp/tools.js';
import { padTestimony } from '../src/retro/dossier.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import type { Agent, PadDecision, ScratchEntry } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildApp } from '../src/server/app.js';

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-witness-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
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

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: `work/${originRef.replace(/:/g, '-')}`,
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

const FORK: PadDecision = {
  chose: 'Add the column through ensureColumns',
  because: 'CREATE TABLE IF NOT EXISTS never alters an existing table',
  rejected: [
    { alternative: 'Rebuild the table', because: 'loses the rowid order the pad is read in' },
    { alternative: 'Store the fork in a new table', because: 'a second pad under another name' },
  ],
  paths: ['src/store/scratch.ts', 'src/store/schema.ts'],
};

test("a pull request's concerns resolve to the pull request's own pad, which is not a goal", () => {
  for (const origin of ['pr:42', 'pr:42:ci', 'pr:42:review', 'pr:42:comment:abc', 'pr:42:merge']) {
    assert.equal(padOriginFor(origin), 'pr:42', origin);
    assert.equal(goalOriginFor(origin), null, origin);
  }
  assert.equal(goalOriginFor('issue:12:part:schema'), 'issue:12');
  assert.equal(goalOriginFor('job:job_abc'), null);
});

test('a fork is replayed with its decision wherever the pad is read', () => {
  const entry: ScratchEntry = {
    id: 's1',
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:schema',
    agentId: 'a1',
    taskId: 't1',
    topic: null,
    note: 'went through the migration',
    decision: FORK,
    createdAt: '2026-07-30T09:00:00Z',
  };
  const text = padTestimony([entry]);
  assert.match(text, /> went through the migration/);
  assert.match(text, /chose: Add the column through ensureColumns/);
  assert.match(text, /Rejected: Rebuild the table — loses the rowid order/);
  assert.match(text, /Paths: src\/store\/scratch\.ts, src\/store\/schema\.ts/);
  assert.doesNotMatch(padTestimony([{ ...entry, decision: null }]), /Rejected|chose:/, 'a note carries no fork lines');
});

test('the tool takes no decision, and a fork already stored is read back whole', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:part:schema');

  const task = system.store.tasks.getTask(agent.taskId)!;
  const append = buildTools({ store: system.store, agents: system.agents }, { agent, task }).find(
    (t) => t.name === 'scratch_append',
  );
  assert.ok(append);
  const schema = append.inputSchema as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['note', 'topic'], 'scratch_append offers no decision');

  system.store.scratch.appendScratchEntry({
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:schema',
    agentId: agent.id,
    taskId: agent.taskId,
    topic: 'store',
    note: 'the migration is where the guard has to go',
    decision: FORK,
  });
  const plain = await callTool(system, agent, 'scratch_append', { note: 'an ordinary note' });
  assert.equal(plain.isError, false, plain.text);

  const entries = system.store.scratch.listScratchEntries('issue:12');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0]?.decision, FORK, 'the store hands the decision back exactly as written');
  assert.equal(entries[1]?.decision, null);
  assert.equal(entries[1]?.note, 'an ordinary note');

  const read = await callTool(system, agent, 'scratch_read', {});
  const payload = JSON.parse(read.text) as { entries: { note: string; decision: PadDecision | null }[] };
  assert.deepEqual(payload.entries[0]?.decision, FORK);
  assert.equal(payload.entries[1]?.decision, null);

  const built = await buildApp(system);
  const pad = await built.app.inject({ method: 'GET', url: '/api/scratchpads/issue:12' });
  assert.equal(pad.statusCode, 200);
  assert.deepEqual(
    (pad.json().entries as ScratchEntry[]).map((e) => e.decision),
    [FORK, null],
  );
  await built.app.close();
  system.store.close();
});

test("a pull request's agents write to the pull request's own pad, never the issue's", async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'Adds the thing', branch: 'issue/12' });
  system.connector.inject({ kind: 'issue_linked_pr', number: 12, prNumber: 42 });
  await system.harness.runCycle('manual');

  const issueAgent = spawnAgent(system, 'issue:12:part:schema');
  const ciAgent = spawnAgent(system, 'pr:42:ci');
  const commentAgent = spawnAgent(system, 'pr:42:comment:abc');

  const onIssue = await callTool(system, issueAgent, 'scratch_append', { note: 'the issue side of things' });
  assert.equal(onIssue.isError, false);
  const onPr = await callTool(system, ciAgent, 'scratch_append', {
    note: 'the failing check was the base branch',
  });
  assert.equal(onPr.isError, false, onPr.text);
  assert.match(onPr.text, /"pad":\s*"pr:42"/);

  assert.deepEqual(
    system.store.scratch.listScratchEntries('pr:42').map((e) => e.note),
    ['the failing check was the base branch'],
  );
  assert.deepEqual(
    system.store.scratch.listScratchEntries('issue:12').map((e) => e.note),
    ['the issue side of things'],
  );

  const prRead = await callTool(system, commentAgent, 'scratch_read', {});
  assert.equal(prRead.isError, false);
  assert.match(prRead.text, /"pad":\s*"pr:42"/);
  assert.match(prRead.text, /base branch/, 'a sibling concern on the same PR reads the PR pad');
  assert.doesNotMatch(prRead.text, /issue side/, "a PR agent cannot read the linked issue's pad");

  const issueRead = await callTool(system, issueAgent, 'scratch_read', {});
  assert.doesNotMatch(issueRead.text, /base branch/, "an issue agent cannot read the PR's pad");

  const built = await buildApp(system);
  const viaConcern = await built.app.inject({ method: 'GET', url: '/api/scratchpads/pr:42:ci' });
  assert.equal(viaConcern.statusCode, 200);
  assert.equal(viaConcern.json().padRef, 'pr:42');
  assert.equal((viaConcern.json().entries as unknown[]).length, 1);
  const viaPr = await built.app.inject({ method: 'GET', url: '/api/scratchpads/pr:42' });
  assert.equal(viaPr.json().padRef, 'pr:42');
  const state = await built.app.inject({ method: 'GET', url: '/api/state' });
  const issues = state.json().world.issues as { number: number; scratchpad: { entries: number } | null }[];
  assert.equal(issues.find((i) => i.number === 12)?.scratchpad?.entries, 1);
  await built.app.close();
  system.store.close();
});

test('a database created before the column reads every old row as a note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-witness-migrate-'));
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE scratch_entries (
      id                TEXT PRIMARY KEY,
      pad_ref           TEXT NOT NULL,
      author_origin_ref TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      task_id           TEXT NOT NULL,
      topic             TEXT,
      note              TEXT NOT NULL,
      created_at        TEXT NOT NULL
    )`);
  old
    .prepare(
      `INSERT INTO scratch_entries (id, pad_ref, author_origin_ref, agent_id, task_id, topic, note, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run('scr_old', 'issue:12', 'issue:12:plan', 'a1', 't1', 'store', 'from before forks', '2026-01-01T00:00:00.000Z');
  old.close();

  const store = new Store(path);
  const columns = new Set(
    (new Database(path).prepare(`PRAGMA table_info(scratch_entries)`).all() as { name: string }[]).map((c) => c.name),
  );
  assert.ok(columns.has('decision'), 'the column was added rather than the table recreated');

  const [row] = store.scratch.listScratchEntries('issue:12');
  assert.equal(row?.id, 'scr_old', 'the pre-existing row is still there');
  assert.equal(row?.note, 'from before forks');
  assert.equal(row?.decision, null, 'an old row is a note');

  store.scratch.appendScratchEntry({
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:schema',
    agentId: 'a2',
    taskId: 't2',
    topic: null,
    note: 'a fork after the migration',
    decision: FORK,
  });
  assert.deepEqual(
    store.scratch.listScratchEntries('issue:12').map((e) => e.decision),
    [null, FORK],
  );
  store.close();
});

test('no dispatch prompt carries an instruction to record forks', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Something', branch: 'feature/x' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 7 });
  system.store.scratch.appendScratchEntry({
    padRef: 'pr:7',
    authorOriginRef: 'pr:7:review',
    agentId: 'a0',
    taskId: 't0',
    topic: null,
    note: 'a note already on the pull request pad',
    decision: null,
  });
  system.store.jobs.createJob({ title: 'Write a report', prompt: 'Report on X.', kind: 'desk' });
  await system.harness.runCycle('manual');

  const tasks = system.store.tasks
    .listTasks()
    .map((t) => system.store.tasks.getTask(t.id))
    .filter((t) => t !== null);
  const code = tasks.filter((t) => t.kind === 'code');
  const desk = tasks.filter((t) => t.kind === 'desk');
  assert.ok(code.length > 0, 'a code agent was dispatched');
  assert.ok(desk.length > 0, 'a desk agent was dispatched');
  for (const t of code) assert.doesNotMatch(t.prompt, /already on the pull request pad/, 'the PR pad is not replayed');
  for (const t of [...code, ...desk]) assert.doesNotMatch(t.prompt, /Record the forks/, `${t.originRef}`);
  system.store.close();
});
