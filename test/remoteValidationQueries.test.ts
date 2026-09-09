import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { CommandStateReader } from '../src/remoteValidation/stateReader.js';
import { parseWatchResult } from '../src/environments/watchResult.js';
import { StateSchema } from '../src/validation/stateDocument.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import { stateDeclareNote } from '../src/plans/planning.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Agent } from '../src/types.js';

// → docs/spec/36-remote-validation.md

interface ToolResultText {
  isError?: boolean;
  content: { text?: string }[];
}

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  validate: { permits: ['state'], state: { run: './scripts/validation-query.sh acceptance' } },
};

const PRODUCTION: EnvironmentConfig = {
  name: 'production',
  at: 'echo unused',
  validate: { permits: ['state'], state: { run: './scripts/validation-query.sh production' } },
};

const QUERY = {
  id: 'orders-carry-a-channel',
  title: 'Every order written since the change carries a channel',
  query: "select id, channel from orders where created_at > '2026-01-01' and channel is null",
  presence: 'select id from orders limit 5',
};

function answering(): FakeStateReader {
  return new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([watchRow(QUERY.id, { id: 7, channel: 'web' })]),
  });
}

function build(reader: FakeStateReader, environments: EnvironmentConfig[] = [ACCEPTANCE]): System & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-state-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    repoRoot: dir,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments,
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    stateReader: reader,
    projectConfigFile: join(dir, 'absent.json'),
    environmentObserver: new FakeEnvironmentObserver(),
    errorMirror: () => {},
  });
  return Object.assign(system, { dir });
}

function spawnWorker(system: System, originRef = 'issue:12'): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'fix it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Orders lose their channel',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  const text = result.content[0]?.text ?? '{}';
  return {
    isError: result.isError === true,
    text,
    payload: result.isError === true ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

test('the fake is the only thing a configured deployment reaches, and it spawns no process', async () => {
  const reader = answering();
  const system = build(reader);
  const res = await callTool(system, spawnWorker(system), 'state_declare', { queries: [QUERY] });

  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.payload['declared'], [QUERY.id]);
  assert.deepEqual(
    reader.asked.map((a) => `${a.environment}:${a.kind}`),
    ['acceptance:presence', 'acceptance:state'],
    'every project-supplied command reached the fake, on the fake’s own record',
  );
  assert.ok(
    reader.asked.every((a) => a.command === ACCEPTANCE.validate!.state!.run),
    'and it was handed the command from committed project config rather than one the harness assembled',
  );
  system.store.close();
});

test('the query text reaches the spawned command’s env only, never the command string or its argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-state-cmd-'));
  const record = join(dir, 'record.json');
  const script = join(dir, 'query.sh');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `printf '%s' "$*" > ${JSON.stringify(join(dir, 'argv.txt'))}`,
      `printf '%s' "$LUBBDUBB_WATCH_QUERY" > ${JSON.stringify(join(dir, 'env.txt'))}`,
      `cat ${JSON.stringify(record)}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(record, JSON.stringify([watchRow(QUERY.id, { id: 7, channel: 'web' })]));

  const command = `${JSON.stringify(script)} acceptance`;
  const result = await new CommandStateReader(dir).read({
    environment: 'acceptance',
    command,
    queryId: QUERY.id,
    query: QUERY.query,
    kind: 'state',
  });

  assert.equal(result.verdict, 'answered');
  assert.ok(!command.includes(QUERY.query), 'the query is never interpolated into the command string');
  assert.equal(readFileSync(join(dir, 'argv.txt'), 'utf8'), 'acceptance', 'and no fragment of it rides in the argv');
  assert.match(readFileSync(join(dir, 'env.txt'), 'utf8'), /channel is null/, 'it reaches the env, and only the env');
});

test('CommandStateReader parses through the same watchResult the observer does', async () => {
  const withoutEcho = JSON.stringify([{ id: 7, channel: 'web' }]);
  const aggregated = JSON.stringify([watchRow(QUERY.id, { count_: 3 })]);

  /* Drive one scripted output through the observer's path and the state reader's, and compare. */
  const observed = parseWatchResult(withoutEcho, QUERY.id, 'signal');
  const readerResult = await new FakeStateReader({ [`${QUERY.id}:state`]: withoutEcho }).read({
    environment: 'acceptance',
    command: './q.sh',
    queryId: QUERY.id,
    query: QUERY.query,
    kind: 'state',
  });
  assert.deepEqual(readerResult, observed, 'the id echo is one implementation, not two');
  assert.equal(observed.verdict, 'unknown');
  assert.match(observed.detail!, /without the query it was given/);

  const counted = parseWatchResult(aggregated, QUERY.id, 'signal');
  assert.equal(counted.rows!.length, 1, 'rows, never counts — and only the shared parser decides what a row is');
});

test('a command that fails, times out or answers nothing is an observation failure, never a reading', async () => {
  for (const [label, stdout] of [
    ['empty output', ''],
    ['not a list of rows', '{"ok":true}'],
    ['a list of something else', '[1,2,3]'],
  ] as const) {
    const reader = new FakeStateReader({ [`${QUERY.id}:state`]: stdout, [`${QUERY.id}:presence`]: stdout });
    const system = build(reader);
    system.store.saveStateQueries('issue:12', [{ ...QUERY, seq: 1, why: null }], 'agent');
    const reading = await system.stateQueries.read(ACCEPTANCE, system.store.listStateQueries()[0]!);
    assert.equal(reading.verdict, 'unknown', label);
    assert.ok(reading.blocked !== null, `${label} is blocked — no reading was taken`);
    assert.equal(reading.rows, null, `${label} carries no reading anybody could act on`);
    system.store.close();
  }
});

test('an aggregating state query is refused at ingestion, through the shared aggregatingTail', () => {
  const parsed = StateSchema.safeParse({
    queries: [{ ...QUERY, query: 'traces | where kind == "order" | count' }],
  });
  assert.equal(parsed.success, false);
  assert.match(parsed.error!.issues.map((i) => i.message).join('; '), /ends in "count"/);

  const presence = StateSchema.safeParse({
    queries: [{ ...QUERY, presence: 'traces | where kind == "order" | count' }],
  });
  assert.equal(presence.success, false);
  assert.match(presence.error!.issues.map((i) => i.message).join('; '), /can never answer zero/);

  assert.equal(StateSchema.safeParse({ queries: [QUERY] }).success, true);
});

test('both transports answer the same document identically', async () => {
  const aggregating = { ...QUERY, query: 'traces | where kind == "order" | count' };
  const doc = {
    version: 1 as const,
    reason: 'One part.',
    parts: [{ slug: 'fix', title: 'Fix it', scope: 'src/orders' }],
    state: { queries: [aggregating] },
  };
  const drained = validatePlanDocument(doc);
  assert.equal(drained.ok, false);

  const system = build(answering());
  const planner = spawnWorker(system, 'issue:12:plan');
  const submitted = await callTool(system, planner, 'plan_submit', {
    reason: 'One part.',
    parts: [{ slug: 'fix', title: 'Fix it', scope: 'src/orders' }],
    state: { queries: [aggregating] },
  });
  assert.equal(submitted.isError, true);
  assert.match(submitted.text, /ends in "count"/);
  assert.match(drained.ok ? '' : drained.error, /ends in "count"/);
  system.store.close();
});

test('the planner is refused state_declare by name, and a part agent is not', async () => {
  const system = build(answering());
  const refused = await callTool(system, spawnWorker(system, 'issue:12:plan'), 'state_declare', { queries: [QUERY] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /plan_submit's "state" block/);

  const part = await callTool(system, spawnWorker(system, 'issue:12:part:fix'), 'state_declare', { queries: [QUERY] });
  assert.equal(part.isError, false, part.text);
  assert.deepEqual(
    system.store.listStateQueries().map((q) => q.originRef),
    ['issue:12'],
  );
  system.store.close();
});

test('the origin comes off the credential — an agent working goal A cannot declare on goal B', async () => {
  const system = build(answering());
  await callTool(system, spawnWorker(system, 'issue:12'), 'state_declare', {
    queries: [QUERY],
    originRef: 'issue:99',
    goal: 99,
  });
  assert.deepEqual(
    system.store.listStateQueries().map((q) => q.originRef),
    ['issue:12'],
  );
  system.store.close();
});

test('with no validate.state anywhere, state_declare is named to no agent and refuses a caller by name', async () => {
  const off = build(answering(), [{ name: 'acceptance', at: 'echo unused' }]);
  assert.equal(off.stateQueries.configured(), false);
  assert.equal(stateDeclareNote(off.config.environments), '', 'the note is not appended where nothing can run one');
  const res = await callTool(off, spawnWorker(off), 'state_declare', { queries: [QUERY] });
  assert.equal(res.isError, true);
  assert.match(res.text, /validate\.state\.run/);
  assert.deepEqual(off.store.listStateQueries(), [], 'and nothing nothing can ever run is stored');
  off.store.close();

  const on = build(answering());
  assert.equal(on.stateQueries.configured(), true);
  assert.match(stateDeclareNote(on.config.environments), /state_declare/);
  assert.match(stateDeclareNote(on.config.environments), /acceptance/);
  const declared = await callTool(on, spawnWorker(on), 'state_declare', { queries: [QUERY] });
  assert.equal(declared.isError, false, declared.text);
  on.store.close();
});

test('declaring runs the dry run in the same call and keeps what it returned beside the query', async () => {
  const reader = answering();
  const system = build(reader);
  await callTool(system, spawnWorker(system), 'state_declare', { queries: [QUERY] });

  const [stored] = system.store.listStateQueries();
  assert.ok(stored);
  assert.equal(stored!.query, QUERY.query, 'the query text itself');
  assert.equal(stored!.dryRunEnvironment, 'acceptance');
  assert.equal(stored!.dryRunPresence, 'fires');
  assert.equal(stored!.dryRunVerdict, 'fires');
  assert.equal(stored!.dryRunRows, 1);
  assert.match(stored!.dryRunSample!, /"channel":"web"/, 'and what it actually returned');
  assert.equal(stored!.authored, 'agent');
  system.store.close();
});

test('approval keys on (digest, environment): approved here is still blocked there', async () => {
  const reader = answering();
  const system = build(reader, [ACCEPTANCE, PRODUCTION]);
  await callTool(system, spawnWorker(system), 'state_declare', { queries: [QUERY] });
  const query = system.store.listStateQueries()[0]!;

  const ruled = await system.stateQueries.rule('issue:12', QUERY.id, 'acceptance', true);
  assert.ok(ruled?.approval);
  assert.equal(ruled!.approval!.environment, 'acceptance');

  const approvals = system.store.listStateQueryApprovals();
  assert.equal(approvals.length, 1);
  assert.ok(
    approvals.some((a) => a.digest === query.digest && a.environment === 'acceptance'),
    'accepted against the place it was read on',
  );
  assert.ok(
    !approvals.some((a) => a.environment === 'production'),
    'and still unapproved against production — consent to a place is not transferable',
  );
  system.store.close();
});

test('editing a query clears its approval everywhere; a re-declaration word for word does not', async () => {
  const reader = answering();
  const system = build(reader, [ACCEPTANCE, PRODUCTION]);
  const agent = spawnWorker(system);
  await callTool(system, agent, 'state_declare', { queries: [QUERY] });
  await system.stateQueries.rule('issue:12', QUERY.id, 'acceptance', true);
  await system.stateQueries.rule('issue:12', QUERY.id, 'production', true);
  assert.equal(system.store.listStateQueryApprovals().length, 2);

  await callTool(system, agent, 'state_declare', { queries: [QUERY] });
  assert.equal(
    system.store.listStateQueryApprovals().length,
    2,
    'a re-declaration word for word is the same question and keeps its consent',
  );

  await callTool(system, agent, 'state_declare', {
    queries: [{ ...QUERY, query: `${QUERY.query} and tenant_id = 4` }],
  });
  assert.deepEqual(
    system.store.listStateQueryApprovals(),
    [],
    'an edited one is a new question everywhere, on every environment',
  );
  system.store.close();
});

test('presence is approved on the same terms as the query it belongs to', async () => {
  const system = build(answering(), [ACCEPTANCE]);
  const agent = spawnWorker(system);
  await callTool(system, agent, 'state_declare', { queries: [QUERY] });
  await system.stateQueries.rule('issue:12', QUERY.id, 'acceptance', true);
  assert.equal(system.store.listStateQueryApprovals().length, 1);

  await callTool(system, agent, 'state_declare', {
    queries: [{ ...QUERY, presence: 'select id from orders limit 50' }],
  });
  assert.deepEqual(
    system.store.listStateQueryApprovals(),
    [],
    'an edited presence query is an edited question — the digest covers both',
  );
  assert.equal(queryDigest(QUERY.query, QUERY.presence) === queryDigest(QUERY.query, 'other'), false);
  system.store.close();
});

test('a query the operator declines is unapproved, and one it cannot read is never approved', async () => {
  const system = build(answering());
  const agent = spawnWorker(system);
  await callTool(system, agent, 'state_declare', { queries: [QUERY] });
  await system.stateQueries.rule('issue:12', QUERY.id, 'acceptance', true);
  assert.equal(system.store.listStateQueryApprovals().length, 1);
  await system.stateQueries.rule('issue:12', QUERY.id, 'acceptance', false);
  assert.deepEqual(system.store.listStateQueryApprovals(), []);
  system.store.close();

  const silent = build(new FakeStateReader({ [`${QUERY.id}:presence`]: JSON.stringify([]) }));
  silent.store.saveStateQueries('issue:12', [{ ...QUERY, seq: 1, why: null }], 'agent');
  const ruled = await silent.stateQueries.rule('issue:12', QUERY.id, 'acceptance', true);
  assert.ok(ruled?.reading?.blocked);
  assert.equal(ruled!.approval, null, 'a query that answered nothing is not something to consent to');
  assert.deepEqual(silent.store.listStateQueryApprovals(), []);
  silent.store.close();
});

test("state_declare merges on the slug, withdraws nothing, and leaves an operator's own row alone", async () => {
  const system = build(answering());
  const agent = spawnWorker(system);
  system.store.saveStateQueries('issue:12', [{ ...QUERY, id: 'mine', seq: 1, why: null }], 'operator');
  await callTool(system, agent, 'state_declare', { queries: [{ ...QUERY, id: 'theirs' }] });
  await callTool(system, agent, 'state_declare', { queries: [{ ...QUERY, id: 'mine', title: 'Overwritten' }] });

  const held = system.store.listStateQueries();
  assert.deepEqual(
    held.map((q) => q.id).sort(),
    ['mine', 'theirs'],
    'a query it does not name is left exactly as it is, and nothing is withdrawn',
  );
  assert.equal(held.find((q) => q.id === 'mine')!.title, QUERY.title, "an operator's row is not overwritten");
  assert.equal(held.find((q) => q.id === 'mine')!.authored, 'operator');
  system.store.close();
});

test('a declared query is never written to any file — the store is the only writer', async () => {
  const system = build(answering());
  await callTool(system, spawnWorker(system), 'state_declare', { queries: [QUERY] });
  assert.equal(system.store.listStateQueries().length, 1);
  assert.equal(filesMentioning(system.dir, 'channel is null').length, 0);
  system.store.close();
});

function filesMentioning(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (readFileSync(path, 'utf8').includes(needle)) hits.push(path);
    }
  };
  walk(root);
  return hits;
}
