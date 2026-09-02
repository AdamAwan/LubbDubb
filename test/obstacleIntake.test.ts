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

/**
 * The intake, end to end: **reporting is the lookup**.
 *
 * There is no search tool, and that is a decision rather than an omission — an
 * agent does not search on a hunch, and searching would require it to guess the
 * words somebody else used. So the call it makes the moment it is in pain has to
 * come back with the answer, in one round trip, with no model call and nothing to
 * wait for. What is asserted here is what that answer is allowed to contain at
 * each state, and the one thing the tool refuses.
 * → `docs/spec/32-obstacles.md#the-intake`
 */

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

/** A dispatch about one check, which is what the harness reads a bare report against. */
function spawnAgent(system: System, originRef: string, ciChecks: string[] = ['test (windows)']): Agent {
  const task = system.store.createTask({
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

const WHAT = 'test/knowledge.test.ts is timing out on the windows runner';

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
  // The directive is the harness's and never the agent's, and at one voice it says
  // the thing the harness cannot rule out: this may be your own change.
  assert.match(answer.directive, /may be your own change/);
  // Withheld, and not out of politeness: an agent shown the first report's words
  // and then counted as agreeing with them is not independent evidence, and the
  // count cannot see the difference.
  assert.deepEqual(answer.what_others_saw, []);

  const [row, ...rest] = system.store.listObstacles();
  assert.equal(rest.length, 0);
  assert.equal(row!.state, 'sighted');
  // The dispatch supplied the key the agent never named — extraction, not a form.
  assert.deepEqual(
    system.store
      .listObstacleKeys(row!.id)
      .map((k) => `${k.kind}:${k.value}`)
      .sort(),
    ['check:test (windows)', 'test:test/knowledge.test.ts'],
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
    what: 'the windows job hangs in test/knowledge.test.ts',
    why_not_mine: 'Fresh worktree, no changes of mine in that file.',
    fix_makes_it_go_away: true,
  });
  const answer = JSON.parse(res.text) as Lookup;

  // One row, two voices: two agents who hit one wall in their own words used to
  // file two singletons, which is the failure the keys replace.
  assert.equal(system.store.listObstacles().length, 1);
  assert.equal(answer.status, 'standing');
  assert.equal(answer.seen_by, 2);
  assert.match(answer.directive, /Two independent voices/);
  // The re-payment saving, in the call the agent was going to make anyway.
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

  // Anything the count cannot tell apart from an echo is not a second voice — so
  // an agent cannot promote its own report by making the call twice.
  assert.equal(answer.seen_by, 1);
  assert.equal(answer.status, 'sighted');
  assert.deepEqual(answer.what_others_saw, []);
  system.store.close();
});

test('an agent may not report its own breakage, and nothing is recorded when it tries', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:412:ci');
  system.store.recordFile(agent.id, { path: 'test/knowledge.test.ts', tool: 'Edit', promoted: false });

  const res = await callTool(system, agent, 'raise', {
    what: WHAT,
    why_not_mine: 'I am sure this is unrelated.',
    fix_makes_it_go_away: true,
  });
  // The only enforcement of *fix what you broke* that is not a sentence in a
  // prompt — and it names the file, so the refusal is one the agent can act on.
  assert.equal(res.isError, true);
  assert.match(res.text, /test\/knowledge\.test\.ts/);
  assert.deepEqual(system.store.listObstacles(), []);
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
  // Filed, with the keys that resolved and without the two that did not. A refusal
  // an agent cannot satisfy is a report that was never filed.
  assert.equal(res.isError, false);
  const row = system.store.listObstacles()[0]!;
  const values = system.store.listObstacleKeys(row.id).map((k) => k.value);
  assert.ok(!values.includes('nightly-smoke'));
  assert.ok(!values.includes('src/does/not/exist.ts'));
  assert.ok(values.includes('test/knowledge.test.ts'));
  system.store.close();
});

test('a note is not an obstacle: it goes on being a claim about the repository', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const res = await callTool(system, agent, 'raise', {
    what: 'knip runs every rule at error, so an unimported export fails check.',
    why_not_mine: 'Saw it on my own run of npm run check.',
    fix_makes_it_go_away: false,
  });
  assert.equal(res.isError, false);
  // The discriminator, and the whole of the routing. Nothing lands on the board,
  // and the claim store is where it has always been until the last of 32 lands.
  assert.deepEqual(system.store.listObstacles(), []);
  assert.equal(system.store.listFacts().length, 1);
  system.store.close();
});
