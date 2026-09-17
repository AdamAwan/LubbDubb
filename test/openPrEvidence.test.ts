import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../src/mcp/tools.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { ActionSink, PrCreateInput, SendResult } from '../src/sink/actionSink.js';
import type { McpTool } from '../src/mcp/protocol.js';
import type { Agent } from '../src/types.js';

// → docs/spec/07-pull-requests.md#the-four-questions-a-reviewer-has

const DIFF = [
  'diff --git a/src/store/sync.ts b/src/store/sync.ts',
  '--- a/src/store/sync.ts',
  '+++ b/src/store/sync.ts',
  '@@ -1,1 +1,2 @@',
  "+db.exec('ALTER TABLE sync_cursor ADD COLUMN last_seen TEXT');",
  'diff --git a/src/sync/resume.ts b/src/sync/resume.ts',
  '--- a/src/sync/resume.ts',
  '+++ b/src/sync/resume.ts',
  '@@ -1,1 +1,2 @@',
  '+const cursor = store.sync.lastSeen();',
].join('\n');

const BULLETS = [
  '- Sync cursors were rebuilt on every boot, so a restart replayed the whole backlog.',
  '- Stores the cursor per source and reads it at startup.',
].join('\n');

const FULL = {
  summary: 'sync cursor table',
  body: BULLETS,
  satisfies: ['`src/store/sync.ts:41` holds one row per source.', '`src/sync/resume.ts:88` reads it at boot.'],
  one_way: ['`src/store/sync.ts:41` adds a column by ALTER TABLE, backfilled to the epoch.'],
  unverified: ['`src/sync/resume.ts:88` has no test for a database that already held rows.'],
  reach: ['`src/sync/resume.ts:88` runs on every boot, with no config flag on it.'],
  decided: ['A cursor per source, not one cursor for the whole feed.'],
};

test('a part agent that gives the reviewer coordinates opens a pull request carrying them', async () => {
  const { tool, opened } = wire();
  const result = await tool.handler(FULL);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(opened.length, 1);
  const body = opened[0]!.body;

  assert.match(body, /Sync cursors were rebuilt on every boot/, 'the bullets ship as written, first');
  assert.match(body, /\*\*Asked for\*\*/);
  assert.match(body, /1\. The cursor is stored per source\./, 'the ask comes from the plan, not from the agent');
  assert.match(body, /\*\*Cannot be undone\*\*\n- `src\/store\/sync\.ts:41` adds a column/);
  assert.match(body, /\*\*Not verified\*\*/);
  assert.match(body, /\*\*How far it reaches\*\*/);
  assert.match(body, /\*\*Decided, where the ask did not say\*\*/);
  assert.match(body, /Touches the database schema and its migrations: `src\/store\/sync\.ts`/);
  assert.match(body, /Tests changed: no/);
  assert.match(body, /Relates to #12\.$/, 'the reference is still last, and still not a closing keyword');
});

test('a diff that alters a table refuses a body that names nothing a revert would not take back', async () => {
  const { tool, opened } = wire();
  const result = await tool.handler({ ...FULL, one_way: [] });
  assert.equal(result.isError, true);
  assert.match(text(result), /`oneWay` is empty/);
  assert.match(text(result), /database schema/);
  assert.equal(opened.length, 0, 'nothing is opened when the evidence is refused');
});

test('a criterion left unaccounted for is refused, and the refusal lists the criteria', async () => {
  const { tool } = wire();
  const result = await tool.handler({ ...FULL, satisfies: ['`src/store/sync.ts:41` holds one row per source.'] });
  assert.equal(result.isError, true);
  assert.match(text(result), /has 1 entries and this part has 2 acceptance criteria/);
  assert.match(text(result), /2\. Resume reads the cursor at boot\./);
});

test('a reassuring entry is refused by the word it used', async () => {
  const { tool } = wire();
  const result = await tool.handler({ ...FULL, reach: ['`src/sync/resume.ts:88` is a safe read at boot.'] });
  assert.equal(result.isError, true);
  assert.match(text(result), /says "safe"/);
});

test('a clone that cannot diff opens the pull request anyway, and says so in the body', async () => {
  const { tool, opened } = wire({ diff: false });
  const result = await tool.handler({ summary: 'sync cursor table', body: BULLETS, satisfies: FULL.satisfies });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.match(opened[0]!.body, /The clone could not read this diff\./);
  assert.match(opened[0]!.body, /\*\*How far it reaches\*\*\n- _none named_/, 'silence is on the record, not hidden');
});

function text(result: { content?: { text?: string }[] }): string {
  return result.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

function wire(opts: { diff?: boolean } = {}): { tool: McpTool; opened: PrCreateInput[] } {
  const system = build();
  const opened: PrCreateInput[] = [];
  const sink = {
    createPullRequest: async (input: PrCreateInput): Promise<SendResult> => {
      opened.push(input);
      return { ok: true };
    },
  } as unknown as ActionSink;

  const git = new FakeGitObserver();
  if (opts.diff !== false) git.setDiff('main', 'issue/12/cursor', DIFF);

  const agent = spawnAgent(system);
  const tool = buildTools(
    {
      store: system.store,
      agents: system.agents,
      openPr: { sink, defaultBranch: 'main', prompts: system.prompts, watchLabel: '', prRefStyle: '#', git },
    },
    { agent, task: system.store.tasks.getTask(agent.taskId)! },
  ).find((t) => t.name === 'open_pr');
  assert.ok(tool, 'open_pr is built');
  return { tool, opened };
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-previdence-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  system.store.world.setWorldBaseline({
    takenAt: '2026-09-01T00:00:00.000Z',
    pullRequests: [],
    issues: [
      {
        id: 'issue_12',
        number: 12,
        title: 'Resume the sync',
        body: '',
        state: 'open',
        labels: [],
        linkedPrNumber: null,
      },
    ],
  });
  const plan = system.store.plans.upsertPlan({ originRef: 'issue:12', title: 'Resume the sync', status: 'active' });
  system.store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'cursor',
      seq: 1,
      title: 'The cursor',
      scope: 'src/store/',
      touches: [],
      dependsOn: [],
      rationale: null,
      acceptance: '- The cursor is stored per source.\n- Resume reads the cursor at boot.',
      size: null,
      expectedKind: null,
    },
  ]);
  return system;
}

function spawnAgent(system: System): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Work issue:12 part cursor',
    prompt: 'do it',
    branch: 'issue/12/cursor',
    originRef: 'issue:12:part:cursor',
    originTitle: 'The cursor',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}
