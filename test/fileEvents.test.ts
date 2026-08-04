import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFileEventRecord,
  classifyArtifact,
  FileEventsSpool,
  FILE_EVENTS_SETTINGS,
  HOOK_DEBUG_FILE,
} from '../src/agents/fileEvents.js';
import { buildClaudeArgs, buildClaudeStreamArgs } from '../src/agents/agentProtocol.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store/store.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- pure record parsing -----------------------------------------------------

test('parseFileEventRecord reads path + tool, and rejects junk', () => {
  assert.deepEqual(parseFileEventRecord('{"path":"/wt/out/r.md","tool":"Write"}'), {
    path: '/wt/out/r.md',
    tool: 'Write',
  });
  assert.deepEqual(parseFileEventRecord('{"path":" x "}'), { path: 'x', tool: null }); // trimmed, tool optional
  assert.equal(parseFileEventRecord('not json'), null);
  assert.equal(parseFileEventRecord('{"tool":"Write"}'), null); // no path
  assert.equal(parseFileEventRecord('{"path":"  "}'), null); // blank path
});

// -- classification (report vs. code change) ---------------------------------

test('classifyArtifact promotes reports/docs, not code changes', () => {
  for (const p of ['out/report.md', 'design.html', 'notes.txt', 'paper.pdf', 'data.csv', 'diagram.svg']) {
    assert.equal(classifyArtifact(p).promoted, true, `${p} should promote`);
  }
  for (const p of ['src/index.ts', 'app.py', 'main.go', 'style.css', 'Makefile', 'a.json']) {
    assert.equal(classifyArtifact(p).promoted, false, `${p} should not promote`);
  }
});

test('classifyArtifact promotes anything under a reports/ segment and picks a kind', () => {
  assert.deepEqual(classifyArtifact('reports/build.log'), { promoted: true, kind: 'report' });
  assert.equal(classifyArtifact('out/report.md').kind, 'report');
  assert.equal(classifyArtifact('metrics.csv').kind, 'data');
  assert.equal(classifyArtifact('flow.svg').kind, 'diagram');
});

test('classifyArtifact promotes any extension under the configured docsFolderPrefix', () => {
  // A file the heuristic would ignore is promoted once it lands under the prefix.
  assert.equal(classifyArtifact('src/index.ts').promoted, false);
  assert.equal(classifyArtifact('src/index.ts', 'docs').promoted, false); // outside the prefix
  assert.equal(classifyArtifact('docs/index.ts', 'docs').promoted, true); // under it → promoted
  assert.equal(classifyArtifact('docs/plan', 'docs').promoted, true); // even with no extension
  // Multi-segment prefix, separator-agnostic; a trailing slash is tolerated.
  assert.equal(classifyArtifact('out/reports/x.bin', 'out/reports/').promoted, true);
  // A sibling folder that merely shares a name prefix is not "under" it.
  assert.equal(classifyArtifact('docsy/x.ts', 'docs').promoted, false);
  // The prefix folder file still gets a sensible kind from its extension.
  assert.equal(classifyArtifact('docs/report.md', 'docs').kind, 'report');
});

test('classifyArtifact accepts an array of prefixes; a file promotes under any entry', () => {
  const prefixes = ['docs', 'artifacts'];
  assert.equal(classifyArtifact('docs/x.ts', prefixes).promoted, true);
  assert.equal(classifyArtifact('artifacts/y.bin', prefixes).promoted, true);
  assert.equal(classifyArtifact('src/z.ts', prefixes).promoted, false);
  // An empty list is inert, like an unset prefix.
  assert.equal(classifyArtifact('docs/x.ts', []).promoted, false);
});

test('classifyArtifact matches an absolute prefix, subfolders included', () => {
  // An out-of-worktree write is left absolute by toWorktreeRelative; an absolute
  // prefix matches it (and its subfolders), case-insensitively.
  assert.equal(classifyArtifact('D:/docs/plans/cat.md', 'D:/docs').promoted, true);
  assert.equal(classifyArtifact('D:\\Docs\\plans\\cat.md', 'D:/docs').kind, 'report');
  assert.equal(classifyArtifact('/srv/shared/reports/out.bin', '/srv/shared/reports').promoted, true);
  // A relative prefix never matches an absolute path and vice versa — separate
  // spaces. Use a non-report extension so only the prefix decides promotion.
  assert.equal(classifyArtifact('D:/docs/x.ts', 'docs').promoted, false); // absolute path, relative prefix
  assert.equal(classifyArtifact('docs/x.ts', 'D:/docs').promoted, false); // relative path, absolute prefix
  // Mixed array: relative for in-worktree, absolute for the shared area.
  assert.equal(classifyArtifact('D:/docs/plan', ['docs', 'D:/docs']).promoted, true);
});

// -- settings wiring ---------------------------------------------------------

test('the file-events hook targets the file-writing tools and reads $LUBBDUBB_EVENTS_DIR', () => {
  const post = FILE_EVENTS_SETTINGS.hooks.PostToolUse[0]!;
  assert.match(post.matcher, /Write/);
  assert.match(post.matcher, /Edit/);
  // Exec form: `node` is the executable, the script (carrying the env guard) rides
  // in args — never a shell string, so it can't be mangled by PowerShell/cmd.
  const hook = post.hooks[0]!;
  assert.equal(hook.command, 'node');
  assert.deepEqual(hook.args?.slice(0, 1), ['-e']);
  assert.match(hook.args![1]!, /LUBBDUBB_EVENTS_DIR/);
});

test('the file-events hook actually captures a write when spawned shell-free (Windows-safe)', () => {
  // Replicate exactly what Claude Code does with exec form: spawn the executable
  // with the argv, no shell tokenization. This is the regression guard for the
  // Windows failure — a POSIX `if [ -n … ]` string here would write nothing under
  // PowerShell/cmd; the exec form must work regardless of the ambient shell.
  const hook = FILE_EVENTS_SETTINGS.hooks.PostToolUse[0]!.hooks[0]!;
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-hook-'));
  const res = spawnSync(process.execPath, hook.args!, {
    input: '{"tool_name":"Write","tool_input":{"file_path":"docs/plan.md"}}',
    env: { ...process.env, LUBBDUBB_EVENTS_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const records = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(records.length, 1, 'exactly one record spooled');
  assert.deepEqual(parseFileEventRecord(readFileSync(join(dir, records[0]!), 'utf8')), {
    path: 'docs/plan.md',
    tool: 'Write',
  });

  // No env var → the guard short-circuits inside the script; nothing is written.
  const dir2 = mkdtempSync(join(tmpdir(), 'lubbdubb-hook-'));
  const bare = { ...process.env };
  delete bare.LUBBDUBB_EVENTS_DIR;
  const res2 = spawnSync(process.execPath, hook.args!, {
    input: '{"tool_name":"Write","tool_input":{"file_path":"docs/plan.md"}}',
    env: bare,
    encoding: 'utf8',
  });
  assert.equal(res2.status, 0);
  assert.equal(readdirSync(dir2).length, 0, 'no env var → no-op');
});

test('LUBBDUBB_EVENTS_DEBUG makes the hook drop a breadcrumb (and readDebug reads it); off by default', () => {
  const hook = FILE_EVENTS_SETTINGS.hooks.PostToolUse[0]!.hooks[0]!;
  // A key'd spool dir, exactly as the harness lays it out (base/<key>).
  const base = mkdtempSync(join(tmpdir(), 'lubbdubb-dbg-'));
  const spool = new FileEventsSpool(base);
  const key = 'agentX';
  const dir = spool.dirFor(key);

  // Debug on: the hook both spools the record AND leaves a breadcrumb naming the
  // tool, the input key names, and the path.
  const res = spawnSync(process.execPath, hook.args!, {
    input: '{"tool_name":"Write","tool_input":{"file_path":"docs/plan.md","content":"x"}}',
    env: { ...process.env, LUBBDUBB_EVENTS_DIR: dir, LUBBDUBB_EVENTS_DEBUG: '1' },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  // The record still spools, and drain ignores the `.log` breadcrumb file.
  assert.deepEqual(spool.drain(key), [{ path: 'docs/plan.md', tool: 'Write' }]);
  const crumbs = spool.readDebug(key);
  assert.equal(crumbs.length, 1);
  assert.match(crumbs[0]!, /fired tool=Write/);
  assert.match(crumbs[0]!, /path=docs\/plan\.md/);
  // Key *names* are logged (diagnostic), never their values — no content leak.
  assert.match(crumbs[0]!, /keys=file_path,content/);
  assert.doesNotMatch(crumbs[0]!, /"x"/);
  // readDebug is non-destructive — the breadcrumb survives a re-read.
  assert.equal(spool.readDebug(key).length, 1);

  // Debug off: no breadcrumb file at all, so readDebug is empty.
  const dir2 = spool.dirFor('agentY');
  spawnSync(process.execPath, hook.args!, {
    input: '{"tool_name":"Write","tool_input":{"file_path":"a.md"}}',
    env: { ...process.env, LUBBDUBB_EVENTS_DIR: dir2, LUBBDUBB_EVENTS_DEBUG: '' },
    encoding: 'utf8',
  });
  assert.equal(spool.readDebug('agentY').length, 0);
  assert.ok(!readdirSync(dir2).includes(HOOK_DEBUG_FILE), 'no breadcrumb file when debug off');
});

test('buildClaudeArgs merges file-events + status-line into one --settings; stream args get the hook headless', () => {
  const pty = buildClaudeArgs({ statusLine: true, fileEvents: true });
  const at = pty.indexOf('--settings');
  assert.ok(at >= 0, 'expected --settings');
  // A single settings object carries both fragments (the flag has no array form).
  assert.match(pty[at + 1]!, /statusLine/);
  assert.match(pty[at + 1]!, /PostToolUse/);

  const stream = buildClaudeStreamArgs({ fileEvents: true });
  const sAt = stream.indexOf('--settings');
  assert.ok(sAt >= 0, 'stream wires the hook (hooks fire headless)');
  assert.match(stream[sAt + 1]!, /PostToolUse/);
  assert.ok(!stream[sAt + 1]!.includes('statusLine'), 'no status line headless');

  assert.ok(!buildClaudeArgs({}).includes('--settings'), 'off by default');
  assert.ok(!buildClaudeStreamArgs({}).includes('--settings'), 'off by default');
});

test('docsFolderPrefix is carried through loadConfig (string or array, unresolved)', () => {
  assert.equal(loadConfig({ agentMode: 'raw', docsFolderPrefix: 'artifacts' }).docsFolderPrefix, 'artifacts');
  // An array carries through verbatim — relative entries are NOT resolved (they're
  // worktree-relative), and absolute entries are left absolute.
  assert.deepEqual(loadConfig({ agentMode: 'raw', docsFolderPrefix: ['docs', 'D:/shared'] }).docsFolderPrefix, [
    'docs',
    'D:/shared',
  ]);
  assert.equal(loadConfig({ agentMode: 'raw' }).docsFolderPrefix, undefined);
});

// -- spool round-trip --------------------------------------------------------

test('FileEventsSpool drains each record once, then dispose removes the dir', () => {
  const spool = new FileEventsSpool(mkdtempSync(join(tmpdir(), 'lubbdubb-ev-')));
  const dir = spool.dirFor('agent-key');
  writeFileSync(join(dir, '1-aaa.json'), JSON.stringify({ path: 'out/a.md', tool: 'Write' }));
  writeFileSync(join(dir, '2-bbb.json'), JSON.stringify({ path: 'src/b.ts', tool: 'Edit' }));

  const first = spool.drain('agent-key');
  assert.deepEqual(
    first.map((r) => r.path),
    ['out/a.md', 'src/b.ts'],
  );
  assert.deepEqual(spool.drain('agent-key'), [], 'records are handed out exactly once');

  spool.dispose('agent-key');
  assert.throws(() => readdirSync(dir), /ENOENT/);
});

// -- end-to-end through AgentManager -----------------------------------------

function testConfig(agentMode: 'raw' | 'pty' = 'raw', sessionTranscriptRoot?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-fe-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode,
    sessionTranscriptRoot,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

test('a captured write records a file for every path and an artifact chip only for reports', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });

  // Drive a real spawn so the agent gets a spool key (a store.createAgent would not).
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Write a report' });
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0];
  assert.ok(agent, 'an agent was dispatched');

  const flags: unknown[] = [];
  system.agents.on('flag', (e) => flags.push(e.flag));

  const dir = system.agents.fileEventsDir(agent!.id);
  assert.ok(dir, 'the spawned agent has a spool dir');
  writeFileSync(join(dir!, '1-a.json'), JSON.stringify({ path: join(agent!.cwd, 'out/summary.md'), tool: 'Write' }));
  writeFileSync(join(dir!, '2-b.json'), JSON.stringify({ path: join(agent!.cwd, 'src/index.ts'), tool: 'Edit' }));

  system.agents.drainFileEvents(agent!.id);

  const files = system.store.listFiles(agent!.id);
  assert.equal(files.length, 2, 'both writes tracked');
  // Absolute paths inside the worktree are stored worktree-relative.
  assert.deepEqual(files.map((f) => f.path).sort(), ['out/summary.md', 'src/index.ts']);
  assert.equal(files.find((f) => f.path === 'out/summary.md')?.promoted, true);
  assert.equal(files.find((f) => f.path === 'src/index.ts')?.promoted, false);

  // Only the report became an artifact chip (via the shared flag path).
  const allFlags = system.store.listFlags(agent!.id);
  assert.equal(allFlags.length, 1);
  assert.equal(allFlags[0]?.ref, 'out/summary.md');
  assert.equal(flags.length, 1, 'flag event emitted for the report only');

  system.store.close();
});

/** Spawn one agent in a fake-PTY system and hand back it plus the driving backend. */
async function spawnedPtyAgent(sessionRoot?: string): Promise<{
  system: ReturnType<typeof buildSystem>;
  backend: FakePtyBackend;
  agent: NonNullable<ReturnType<Store['getAgent']>>;
}> {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig('pty', sessionRoot), {
    worktrees: new FakeWorktreeManager(),
    backend,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Write a report' });
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0];
  assert.ok(agent, 'an agent was dispatched');
  return { system, backend, agent };
}

test('a captured write surfaces on a session-file update mid-run', async () => {
  // A mid-run report must not sit spooled until the agent finishes (never, if it
  // is waiting on a human to review that very file). PTY transcript updates come
  // from the session file rather than the screen, so that is the stream the drain
  // has to ride.
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-fe-sess-'));
  const { system, agent } = await spawnedPtyAgent(root);
  const sessionId = system.store.getAgent(agent.id)?.sessionId;
  assert.ok(sessionId, 'a pty agent pins a session id');

  const projectDir = join(root, 'project');
  mkdirSync(projectDir);
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, '');

  const dir = system.agents.fileEventsDir(agent.id);
  writeFileSync(join(dir!, '1-a.json'), JSON.stringify({ path: join(agent.cwd, 'reports/x.md'), tool: 'Write' }));

  const deltas: string[] = [];
  system.agents.on('output', (e) => deltas.push(e.delta));
  const record = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'wrote the report' }] },
  };
  appendFileSync(sessionFile, `${JSON.stringify(record)}\n`);
  await tick(900);

  assert.ok(
    deltas.some((d) => d.includes('wrote the report')),
    'the session-file record arrived as an output delta',
  );
  assert.deepEqual(
    system.store.listFlags(agent.id).map((f) => f.ref),
    ['reports/x.md'],
  );
  system.store.close();
});

test('a captured write surfaces when the agent parks on a human', async () => {
  // The escalation is often "review the file I just wrote", and a waiting agent
  // reaches no terminal drain — so parking must flush the spool.
  const { system, backend, agent } = await spawnedPtyAgent();

  const dir = system.agents.fileEventsDir(agent.id);
  writeFileSync(join(dir!, '1-a.json'), JSON.stringify({ path: join(agent.cwd, 'reports/x.md'), tool: 'Write' }));

  // The sentinel is stripped, so the settled text never changes: no output and no
  // transcript update fire, leaving `waiting` as the only drain trigger.
  backend.last().emit('@@LUBBDUBB_WAITING:Review reports/x.md@@\r\n');
  await tick(300);

  assert.equal(system.store.getAgent(agent.id)?.status, 'waiting');
  assert.deepEqual(
    system.store.listFlags(agent.id).map((f) => f.ref),
    ['reports/x.md'],
  );
  system.store.close();
});
