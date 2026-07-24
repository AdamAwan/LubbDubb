import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFileEventRecord,
  classifyArtifact,
  FileEventsSpool,
  FILE_EVENTS_SETTINGS,
} from '../src/agents/fileEvents.js';
import { buildClaudeArgs, buildClaudeStreamArgs } from '../src/agents/agentProtocol.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';

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

// -- settings wiring ---------------------------------------------------------

test('the file-events hook targets the file-writing tools and reads $LUBBDUBB_EVENTS_DIR', () => {
  const post = FILE_EVENTS_SETTINGS.hooks.PostToolUse[0]!;
  assert.match(post.matcher, /Write/);
  assert.match(post.matcher, /Edit/);
  assert.match(post.hooks[0]!.command, /LUBBDUBB_EVENTS_DIR/);
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

test('docsFolderPrefix is carried through loadConfig', () => {
  assert.equal(
    loadConfig({ dispatcher: 'rule', agentMode: 'raw', docsFolderPrefix: 'artifacts' }).docsFolderPrefix,
    'artifacts',
  );
  assert.equal(loadConfig({ dispatcher: 'rule', agentMode: 'raw' }).docsFolderPrefix, undefined);
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

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-fe-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

test('a captured write records a file for every path and an artifact chip only for reports', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), errorMirror: () => {} });

  // Drive a real spawn so the agent gets a spool key (a store.createAgent would not).
  system.connector.inject({ kind: 'new_story', title: 'Write a report', wafPillars: ['Reliability'] });
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
