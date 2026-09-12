import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Agent } from '../src/types.js';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obstacles-'));
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

function spawnAgent(system: System, originRef: string, ciChecks: string[] = ['test (windows)']): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Big thing',
    ciChecks,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

interface Lookup {
  id: string;
  status: string;
  seen_by: number;
  owner: string | null;
  directive: string;
  what_others_saw: string[];
  near: { id: string; what: string }[];
}

const WHAT = 'test/obstacleMatch.test.ts is timing out on the windows runner';

test('one report is not evidence: it lands sighted, reaches nobody, and is told so', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:412:ci');
  const res = await callTool(system, agent, 'raise', {
    what: WHAT,
    why_not_mine: 'My diff is all in src/pool/; I never touched the suite.',
    fix_makes_it_go_away: true,
  });
  assert.equal(res.isError, false);
  const answer = JSON.parse(res.text) as Lookup;

  assert.equal(answer.status, 'sighted');
  assert.equal(answer.seen_by, 1);
  assert.match(answer.directive, /may be your own change/);
  assert.deepEqual(answer.what_others_saw, []);

  const [row, ...rest] = system.store.obstacles.listObstacles();
  assert.equal(rest.length, 0);
  assert.equal(row!.state, 'sighted');
  assert.deepEqual(
    system.store.obstacles
      .listObstacleKeys(row!.id)
      .map((k) => `${k.kind}:${k.value}`)
      .sort(),
    ['check:test (windows)', 'test:test/obstacleMatch.test.ts'],
  );
  system.store.close();
});

test('a second goal carries it to standing, and only then are the first words handed back', async () => {
  const system = build();
  const first = spawnAgent(system, 'pr:412:ci');
  await callTool(system, first, 'raise', {
    what: WHAT,
    why_not_mine: 'Nothing of mine is near the suite.',
    fix_makes_it_go_away: true,
  });
  const second = spawnAgent(system, 'issue:88');
  const res = await callTool(system, second, 'raise', {
    what: 'the windows job hangs in test/obstacleMatch.test.ts',
    why_not_mine: 'Fresh worktree, no changes of mine in that file.',
    fix_makes_it_go_away: true,
  });
  const answer = JSON.parse(res.text) as Lookup;

  assert.equal(system.store.obstacles.listObstacles().length, 1);
  assert.equal(answer.status, 'standing');
  assert.equal(answer.seen_by, 2);
  assert.match(answer.directive, /Two independent voices/);
  assert.deepEqual(answer.what_others_saw, [WHAT]);
  system.store.close();
});

test('one goal saying it twice is one voice', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:412:ci');
  const args = { what: WHAT, why_not_mine: 'not mine.', fix_makes_it_go_away: true };
  await callTool(system, agent, 'raise', args);
  const again = await callTool(system, agent, 'raise', args);
  const answer = JSON.parse(again.text) as Lookup;

  assert.equal(answer.seen_by, 1);
  assert.equal(answer.status, 'sighted');
  assert.deepEqual(answer.what_others_saw, []);
  system.store.close();
});

test('an agent may not report its own breakage, and nothing is recorded when it tries', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:412:ci');
  system.store.agents.recordFile(agent.id, { path: 'test/obstacleMatch.test.ts', tool: 'Edit', promoted: false });

  const res = await callTool(system, agent, 'raise', {
    what: WHAT,
    why_not_mine: 'I am sure this is unrelated.',
    fix_makes_it_go_away: true,
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /test\/obstacleMatch\.test\.ts/);
  assert.deepEqual(system.store.obstacles.listObstacles(), []);
  system.store.close();
});

test('why_not_mine is required, and a key that names nothing is dropped rather than refused', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:412:ci');

  const bare = await callTool(system, agent, 'raise', { what: WHAT, fix_makes_it_go_away: true });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /why_not_mine is required/);

  const res = await callTool(system, agent, 'raise', {
    what: WHAT,
    why_not_mine: 'not mine.',
    fix_makes_it_go_away: true,
    keys: ['check:nightly-smoke', 'path:src/does/not/exist.ts', 'nonsense'],
  });
  assert.equal(res.isError, false);
  const row = system.store.obstacles.listObstacles()[0]!;
  const values = system.store.obstacles.listObstacleKeys(row.id).map((k) => k.value);
  assert.ok(!values.includes('nightly-smoke'));
  assert.ok(!values.includes('src/does/not/exist.ts'));
  assert.ok(values.includes('test/obstacleMatch.test.ts'));
  system.store.close();
});

test('a note lands on the board like an obstacle, and is marked as one', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const res = await callTool(system, agent, 'raise', {
    what: 'knip runs every rule at error, so an unimported export fails check.',
    why_not_mine: 'Saw it on my own run of npm run check.',
    fix_makes_it_go_away: false,
  });
  assert.equal(res.isError, false);
  const rows = system.store.obstacles.listObstacles();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, 'note');
  system.store.close();
});
