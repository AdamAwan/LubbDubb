import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeStreamArgs, DONE_REMINDER, MCP_PROTOCOL_ADDENDUM } from '../src/agents/agentProtocol.js';
import { DONE_SENTINEL } from '../src/agents/sentinels.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { handleRequest, parseFrame, type McpTool, toolJson } from '../src/mcp/protocol.js';
import {
  ALLOWED_MCP_TOOLS,
  MCP_SERVER_ID,
  MCP_TOOL_NAMES,
  PERMISSION_PROMPT_TOOL,
  RETIRED_TOOL_NAMES,
  TOOL_NAMING,
} from '../src/mcp/names.js';
import { defaultSocketPath, McpBridgeServer } from '../src/mcp/server.js';
import { parseWorldRef, readWorldItem, WORLD_READ_KINDS } from '../src/mcp/worldRead.js';
import { parseItemRef } from '../src/mcp/findings.js';
import { assessmentOrigin } from '../src/mcp/assessment.js';
import { appraiserOrigin } from '../src/mcp/goalAppraisal.js';
import { conclusionOrigin } from '../src/issueConclusion.js';
import { partConclusionOrigin } from '../src/mcp/partOutcome.js';
import { planOriginIssue } from '../src/plans/planning.js';
import { MAX_NOTE_LENGTH, normaliseNote } from '../src/mcp/progress.js';
import { buildTools } from '../src/mcp/tools.js';
import { buildApp } from '../src/server/app.js';
import { escalationTypeForAsk } from '../src/escalation/context.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import type { Agent, Issue, PullRequest, WorldSnapshot } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { repoText } from './support/paths.js';

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const echoTool: McpTool = {
  name: 'echo',
  description: 'echo',
  inputSchema: { type: 'object', properties: {} },
  handler: (args) => toolJson({ got: args }),
};

test('parseFrame accepts requests and rejects anything that is not one', () => {
  assert.equal(parseFrame('{"jsonrpc":"2.0","id":1,"method":"ping"}')?.method, 'ping');
  assert.equal(parseFrame('{"jsonrpc":"2.0","method":"notifications/initialized"}')?.id, undefined);
  assert.equal(parseFrame('not json'), null);
  assert.equal(parseFrame('[]'), null);
  assert.equal(parseFrame('{"jsonrpc":"2.0","id":1}'), null);
});

test('initialize and tools/list answer with the advertised surface', async () => {
  const init = await handleRequest(parseFrame('{"jsonrpc":"2.0","id":1,"method":"initialize"}')!, [echoTool]);
  const capabilities = (init?.result as { capabilities: Record<string, unknown> }).capabilities;
  assert.ok('tools' in capabilities);

  const list = await handleRequest(parseFrame('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')!, [echoTool]);
  const tools = (list?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['echo'],
  );
  assert.ok(tools[0]?.inputSchema, 'every advertised tool carries a schema');
});

test('notifications get no frame at all, and an unknown method is an error not silence', async () => {
  const note = await handleRequest(parseFrame('{"jsonrpc":"2.0","method":"notifications/initialized"}')!, []);
  assert.equal(note, null);
  const unknownNote = await handleRequest(parseFrame('{"jsonrpc":"2.0","method":"who/knows"}')!, []);
  assert.equal(unknownNote, null);

  const unknown = await handleRequest(parseFrame('{"jsonrpc":"2.0","id":3,"method":"who/knows"}')!, []);
  assert.match(unknown?.error?.message ?? '', /unknown method/);
});

test('a handler that throws becomes a tool error, never a dead channel', async () => {
  const boom: McpTool = {
    ...echoTool,
    handler: () => {
      throw new Error('kaboom');
    },
  };
  const res = await handleRequest(
    parseFrame('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo"}}')!,
    [boom],
  );
  const result = res?.result as ToolResultText;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /kaboom/);
});

test('--mcp-config is wired only when a config path was minted', () => {
  {
    const build = buildClaudeStreamArgs;
    const off = build({});
    assert.equal(off.includes('--mcp-config'), false);
    assert.equal(off[off.indexOf('--append-system-prompt') + 1]?.includes(MCP_PROTOCOL_ADDENDUM), false);

    const on = build({ mcpConfigPath: '/tmp/agent.json' });
    assert.equal(on[on.indexOf('--mcp-config') + 1], '/tmp/agent.json');
    assert.ok(on[on.indexOf('--append-system-prompt') + 1]?.includes(MCP_PROTOCOL_ADDENDUM));
    assert.equal(on.includes('--strict-mcp-config'), false);
    assert.equal(on[on.indexOf('--allowedTools') + 1], ALLOWED_MCP_TOOLS.join(','));
    const withExtra = build({ mcpConfigPath: '/tmp/agent.json', extraArgs: ['--allowedTools', 'Bash'] });
    assert.ok(withExtra.lastIndexOf('--allowedTools') > withExtra.indexOf('--allowedTools'));
  }
});

test('the permission backstop tool is wired only alongside the channel it lives on (#130)', () => {
  {
    const build = buildClaudeStreamArgs;
    const noChannel = build({ permissionPromptTool: PERMISSION_PROMPT_TOOL });
    assert.equal(noChannel.includes('--permission-prompt-tool'), false);
    const disabled = build({ mcpConfigPath: '/tmp/agent.json' });
    assert.equal(disabled.includes('--permission-prompt-tool'), false);
    const on = build({ mcpConfigPath: '/tmp/agent.json', permissionPromptTool: PERMISSION_PROMPT_TOOL });
    assert.equal(on[on.indexOf('--permission-prompt-tool') + 1], PERMISSION_PROMPT_TOOL);
  }
});

test('the granted permission names are exactly the tools the server exposes', () => {
  assert.deepEqual(
    ALLOWED_MCP_TOOLS,
    MCP_TOOL_NAMES.map((name) => `mcp__${MCP_SERVER_ID}__${name}`),
  );
  assert.ok(ALLOWED_MCP_TOOLS.includes(PERMISSION_PROMPT_TOOL));
  assert.equal(PERMISSION_PROMPT_TOOL, `mcp__${MCP_SERVER_ID}__request_permission`);
});

test('the addendum names every tool an agent has to choose to call', () => {
  for (const name of MCP_TOOL_NAMES) {
    const named = MCP_PROTOCOL_ADDENDUM.includes(name);
    if (TOOL_NAMING[name] === 'addendum') {
      assert.ok(named, `${name} is named nowhere else — the addendum must describe it`);
    } else {
      assert.equal(named, false, `${name} is named at its point of use; the addendum stays short`);
    }
  }
});

test('a retired name is no longer a tool, and no longer granted', () => {
  for (const name of RETIRED_TOOL_NAMES) {
    assert.ok(!(MCP_TOOL_NAMES as readonly string[]).includes(name), `${name} is retired, not advertised`);
    assert.ok(
      !ALLOWED_MCP_TOOLS.includes(`mcp__${MCP_SERVER_ID}__${name}`),
      `${name} is retired — granting it would advertise a door that only refuses`,
    );
  }
  assert.ok(RETIRED_TOOL_NAMES.includes('report_finding'));
  assert.ok(RETIRED_TOOL_NAMES.includes('knowledge_ask'));
});

test('a retired name is answered, so an override that still names one is not a dead channel', () => {
  const tools = retiredAwareTools();
  for (const name of RETIRED_TOOL_NAMES) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} must still be dispatchable`);
    assert.equal(tool.hidden, true, `${name} must not be advertised in tools/list`);
    assert.match(tool.description, /raise/, 'the refusal names the door that replaced it');
  }
});

test('tools/list advertises the live tools and never a retired one', async () => {
  const listed = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, retiredAwareTools());
  const names = ((listed?.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
  assert.deepEqual(names, [...MCP_TOOL_NAMES], 'the advertised set is the granted set, in its own order');
  for (const name of RETIRED_TOOL_NAMES) assert.ok(!(names as string[]).includes(name));
});

function retiredAwareTools(): McpTool[] {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  return buildTools(
    { store: system.store, agents: system.agents },
    { agent, task: system.store.tasks.getTask(agent.taskId)! },
  );
}

test('the addendum keeps the sentinels as the floor rather than withdrawing them', () => {
  assert.match(MCP_PROTOCOL_ADDENDUM, /@@LUBBDUBB_DONE@@/);
  assert.match(MCP_PROTOCOL_ADDENDUM, /fall back to the sentinels/i);
});

test('an escalate kind files as an inbox type, unknown kinds landing where the sentinel does', () => {
  assert.equal(escalationTypeForAsk('approve'), 'approve_change');
  assert.equal(escalationTypeForAsk('choose'), 'resolve_ambiguity');
  assert.equal(escalationTypeForAsk('clarify'), 'resolve_ambiguity');
  assert.equal(escalationTypeForAsk('review'), 'review_reply');
  assert.equal(escalationTypeForAsk(undefined), 'answer_question');
  assert.equal(escalationTypeForAsk('nonsense'), 'answer_question');
});

const TAKEN_AT = '2026-01-01T00:00:00.000Z';

function fakePr(number: number, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `PR ${number}`,
    branch: `feat/${number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    ...extra,
  };
}

function fakeIssue(number: number, extra: Partial<Issue> = {}): Issue {
  return {
    id: `i_${number}`,
    number,
    title: `Issue ${number}`,
    body: 'Body.',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...extra,
  };
}

function fakeWorld(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return { takenAt: TAKEN_AT, pullRequests: [], issues: [], ...overrides };
}

function target(kind: string, ref: string) {
  const parsed = parseWorldRef(kind, ref);
  assert.ok(parsed.ok, `${kind}/${ref} should parse`);
  return parsed.target;
}

test('the kind vocabulary is the one the dispatcher already models', () => {
  assert.deepEqual([...WORLD_READ_KINDS], ['pr', 'issue']);
});

test('a ref is accepted in every shape the harness itself writes', () => {
  const cases: [string, string, string][] = [
    ['pr', 'pr:42', 'pr:42'],
    ['pr', '42', 'pr:42'],
    ['pr', '#42', 'pr:42'],
    ['pr', 'pr:42:ci', 'pr:42'],
    ['pr', 'pr:42:comment:c_9', 'pr:42'],
    ['issue', 'issue:12', 'issue:12'],
    ['issue', 'issue:12:plan', 'issue:12'],
    ['issue', 'issue:12:part:schema', 'issue:12'],
  ];
  for (const [kind, ref, canonical] of cases) {
    const parsed = parseWorldRef(kind, ref);
    assert.equal(parsed.ok, true, `${kind}/${ref} should parse`);
    assert.equal(parsed.ok && parsed.target.canonical, canonical);
  }
});

test('a ref that disagrees with its kind is reported rather than guessed at', () => {
  const mismatch = parseWorldRef('pr', 'issue:12');
  assert.equal(mismatch.ok, false);
  assert.match(!mismatch.ok ? mismatch.error : '', /is a issue ref, but kind is "pr"/);

  const badKind = parseWorldRef('epic', '12');
  assert.equal(badKind.ok, false);
  assert.match(!badKind.ok ? badKind.error : '', /kind must be one of pr, issue/);

  const noNumber = parseWorldRef('pr', 'pr:main');
  assert.equal(noNumber.ok, false);
  assert.match(!noNumber.ok ? noNumber.error : '', /does not contain a pr number/);

  assert.equal(parseWorldRef('pr', '   ').ok, false);
});

test('a PR reads back with the same health verdict and stack attribution the cockpit shows', () => {
  const world = fakeWorld({
    pullRequests: [
      fakePr(7, { branch: 'issue/12/schema', baseBranch: 'main', ciStatus: 'failing' }),
      fakePr(12, {
        branch: 'issue/12/reader',
        baseBranch: 'issue/12/schema',
        ciStatus: 'failing',
        unresolvedComments: [{ id: 'c1', author: 'rev', body: 'rename this', handled: false }],
      }),
    ],
  });

  const read = readWorldItem(world, target('pr', 'pr:12'));
  assert.equal(read.ok, true);
  assert.ok(read.ok);
  const item = prPayload(read.item);
  assert.equal(item.ciFailingOnBasePr, 7);
  assert.equal(item.basePr?.number, 7);
  assert.ok(item.health.reasons.includes('CI failing on base PR #7'));
  assert.deepEqual(
    item.unresolvedComments.map((c) => c.body),
    ['rename this'],
  );
});

function prPayload(item: Record<string, unknown>) {
  return item as unknown as {
    ciFailingOnBasePr: number | null;
    basePr: { number: number } | null;
    health: { blocked: boolean; reasons: string[] };
    unresolvedComments: { body: string; replies: { id: string; author: string; body: string; ours: boolean }[] }[];
    state: string;
  };
}

test('a recently-closed PR is still readable, so a stacked agent can tell a merge from an abandonment', () => {
  const world = fakeWorld({
    pullRequests: [fakePr(12)],
    closedPullRequests: [fakePr(7, { state: 'merged', merged: true, closedAt: TAKEN_AT })],
  });
  const merged = readWorldItem(world, target('pr', '7'));
  assert.equal(merged.ok, true);
  assert.ok(merged.ok);
  assert.equal(prPayload(merged.item).state, 'merged');
});

test('a miss names what the harness is tracking instead of just saying no', () => {
  const world = fakeWorld({ pullRequests: [fakePr(7), fakePr(12)], issues: [fakeIssue(3)] });
  const missPr = readWorldItem(world, target('pr', '99'));
  assert.equal(missPr.ok, false);
  assert.match(!missPr.ok ? missPr.error : '', /no PR pr:99\. PRs the harness is tracking: #7, #12\./);

  const empty = readWorldItem(fakeWorld(), target('issue', '404'));
  assert.match(!empty.ok ? empty.error : '', /tracking no Issues/);
});

test('an item ref is the harness vocabulary, suffix-tolerant, and optional', () => {
  const cases: [unknown, string | null][] = [
    [undefined, null],
    ['', null],
    ['issue:41', 'issue:41'],
    ['pr:42', 'pr:42'],
    ['pr:42:ci', 'pr:42'],
    ['issue:12:part:schema', 'issue:12'],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseItemRef(input);
    assert.equal(parsed.ok, true, `${JSON.stringify(input)} should parse`);
    assert.equal(parsed.ok && parsed.ref, expected);
  }
});

test('a bare number is refused rather than guessed at, unlike world_read', () => {
  const bare = parseItemRef('41');
  assert.equal(bare.ok, false);
  assert.match(!bare.ok ? bare.error : '', /ambiguous between an issue and a PR/);

  const upstream = parseItemRef('npm:left-pad');
  assert.equal(upstream.ok, false);
  assert.match(!upstream.ok ? upstream.error : '', /omit ref and describe it in the summary/);
  assert.equal(parseItemRef('issue:main').ok, false);
});

test('a progress note is reduced to the one line the fleet card can render', () => {
  const wrapped = normaliseNote('  Reworking the fold\n  so a superseded push   stops poisoning CI  ');
  assert.deepEqual(wrapped, {
    ok: true,
    note: 'Reworking the fold so a superseded push stops poisoning CI',
    trimmed: false,
  });
  assert.equal((normaliseNote('a\nb') as { note: string }).note, 'a b');
});

test('an over-long note is kept and trimmed, where a malformed claim is refused', () => {
  const long = normaliseNote('x'.repeat(MAX_NOTE_LENGTH + 50)) as { ok: true; note: string; trimmed: boolean };
  assert.equal(long.ok, true);
  assert.equal(long.note.length, MAX_NOTE_LENGTH);
  assert.equal(long.trimmed, true);
});

test('an empty note is the one thing refused — there is nothing to store', () => {
  for (const empty of ['', '   ', '\n', undefined, 42]) {
    const res = normaliseNote(empty);
    assert.equal(res.ok, false, `${JSON.stringify(empty)} is not a note`);
    if (!res.ok) assert.match(res.error, /note is required/);
  }
});

class SilentChild extends EventEmitter implements StreamChild {
  pid = 4321;
  stdout = { on: () => {} } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {}
}

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-mcp-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

function build(overrides: Record<string, unknown> = {}): System {
  return buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function spawnAgent(system: System, originRef: string, title = 'Big thing'): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: title,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

function advertisedSchema(system: System, agent: Agent, name: string): { properties: Record<string, unknown> } {
  const task = system.store.tasks.getTask(agent.taskId)!;
  const tool = buildTools({ store: system.store, agents: system.agents }, { agent, task }).find((t) => t.name === name);
  assert.ok(tool, `${name} is built`);
  return tool.inputSchema as { properties: Record<string, unknown> };
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('plan_submit persists the verdict and hands the agent its status back', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:plan');

  const res = await callTool(system, agent, 'plan_submit', {
    reason: 'Schema before reader.',
    parts: [
      { slug: 'schema', title: 'Add the table', scope: 'src/store' },
      { slug: 'reader', title: 'Read it', scope: 'src/dispatcher', dependsOn: ['schema'] },
    ],
  });
  assert.equal(res.isError, false);

  const plan = system.store.plans.getPlanByOrigin('issue:12');
  assert.ok(plan, 'the plan landed against the issue origin, not the planner origin');
  assert.equal(plan!.status, 'awaiting_approval');
  assert.equal(plan!.title, 'Big thing');
  assert.deepEqual(
    system.store.plans.listPlanParts(plan!.id).map((p) => p.slug),
    ['schema', 'reader'],
  );

  const payload = JSON.parse(res.text) as { accepted: boolean; _status: Record<string, unknown> };
  assert.equal(payload.accepted, true);
  assert.equal(payload._status.origin, 'issue:12:plan');
  assert.deepEqual(payload._status.plan, {
    status: 'awaiting_approval',
    parts: [
      { slug: 'schema', status: 'pending' },
      { slug: 'reader', status: 'pending' },
    ],
  });
  system.store.close();
});

test('a malformed plan_submit returns the reason and leaves no partial rows', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:plan');

  const res = await callTool(system, agent, 'plan_submit', {
    reason: 'Circular.',
    parts: [
      { slug: 'a', title: 'A', scope: 'x', dependsOn: ['b'] },
      { slug: 'b', title: 'B', scope: 'y', dependsOn: ['a'] },
    ],
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /dependency cycle/);
  assert.equal(system.store.plans.getPlanByOrigin('issue:12'), null);
  assert.deepEqual(system.store.plans.listPlans(), []);

  const fixed = await callTool(system, agent, 'plan_submit', {
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'Small after all.',
  });
  assert.equal(fixed.isError, false);
  assert.equal(system.store.plans.getPlanByOrigin('issue:12')?.status, 'awaiting_approval');
  assert.match(fixed.text, /nothing is scheduled until an operator approves it/);
  system.store.close();
});

test('plan_submit accepts and persists the widened document', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:231:plan');

  const res = await callTool(system, agent, 'plan_submit', {
    reason: 'the signer must exist first',
    risks: 'part 2 briefly serves artifacts unguarded',
    outOfScope: 'capability revocation',
    document: '# Serving artifacts\n\nThe guard is a prefix, not a per-route opt-in.',
    parts: [
      {
        slug: 'signer',
        title: 'Add the signer',
        scope: 'src/server/artifactCapability.ts',
        dependsOn: [],
        rationale: 'a pure predicate with no callers',
        acceptance: 'round-trips; tampered and expired refused',
        touches: [],
      },
    ],
  });
  assert.equal(res.isError, false);

  const plan = system.store.plans.getPlanByOrigin('issue:231')!;
  assert.equal(plan.risks, 'part 2 briefly serves artifacts unguarded');
  assert.match(plan.document!, /^# Serving artifacts/);
  assert.equal(system.store.plans.listPlanParts(plan.id)[0]!.acceptance, 'round-trips; tampered and expired refused');
  system.store.close();
});

test('plan_submit carries the validation block, on the verdict as well as the parts', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:284:plan');

  const schema = advertisedSchema(system, agent, 'plan_submit');
  assert.ok(schema.properties.validation, 'the tool offers the block the file path accepts');

  const res = await callTool(system, agent, 'plan_submit', {
    reason: 'the reap writer must land before anything reads it',
    verification: 'no stale refs survive a squash merge',
    parts: [{ slug: 'reap-writer', title: 'Delete the branch', scope: 'src/git', touches: [] }],
    validation: {
      resources: [
        { name: 'fixture-repo.tar.gz', kind: 'fixture', note: 'seeded repo, one PR by another author' },
        { name: 'orders-dump.sql', kind: 'data', provided: false },
      ],
      checks: [
        {
          id: 'merged-branch-gone',
          title: 'A squash-merged part branch is gone on both sides',
          do: 'Run the harness against the fixture repo and merge the seeded PR.',
          expect: 'No issue/284/reap ref, locally or on the remote.',
          uses: ['fixture-repo.tar.gz', 'never-declared'],
          covers: ['reap-writer', 'no-such-part'],
          fleetCandidate: true,
          why: 'it is a git assertion and nothing else',
        },
      ],
    },
  });
  assert.equal(res.isError, false);

  const checks = system.store.validation.listValidationChecks('issue:284');
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.letter, 'A');
  assert.equal(checks[0]!.expect, 'No issue/284/reap ref, locally or on the remote.');
  assert.deepEqual(checks[0]!.uses, ['fixture-repo.tar.gz']);
  assert.deepEqual(checks[0]!.covers, ['reap-writer']);
  assert.equal(checks[0]!.candidateWhy, 'it is a git assertion and nothing else');

  const resources = system.store.validation.listValidationResources('issue:284');
  assert.deepEqual(
    resources.map((r) => r.name),
    ['fixture-repo.tar.gz', 'orders-dump.sql'],
  );
  assert.equal(resources.find((r) => r.name === 'orders-dump.sql')!.provided, false);
  assert.equal(resources.find((r) => r.name === 'orders-dump.sql')!.humanTaskId, null);
  assert.equal(system.store.humanTasks.listHumanTasks().length, 0);
  system.store.close();
});

test('plan_submit hands back the reason for a malformed check, and writes nothing', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:285:plan');

  const res = await callTool(system, agent, 'plan_submit', {
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'one PR',
    validation: {
      checks: [{ id: 'a-check', title: 'T', do: 'D', expect: 'E', actor: 'fleet' }],
    },
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /who runs it is not yours to say/);
  assert.equal(system.store.plans.getPlanByOrigin('issue:285'), null);

  const fixed = await callTool(system, agent, 'plan_submit', {
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'one PR',
  });
  assert.equal(fixed.isError, false);
  assert.deepEqual(system.store.validation.listValidationChecks('issue:285'), []);
  system.store.close();
});

test('identity is structural: an agent cannot submit a plan for work it was not dispatched to', async () => {
  const system = build();
  const worker = spawnAgent(system, 'issue:12');

  const res = await callTool(system, worker, 'plan_submit', {
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'Mine now.',
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /only available to a planning agent/);
  assert.equal(system.store.plans.getPlanByOrigin('issue:12'), null);

  const planner = spawnAgent(system, 'issue:41:plan');
  await callTool(system, planner, 'plan_submit', {
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'Just one.',
  });
  assert.ok(system.store.plans.getPlanByOrigin('issue:41'));
  assert.equal(system.store.plans.getPlanByOrigin('issue:12'), null, 'no cross-origin write');
  system.store.close();
});

test('a revoked credential can no longer call tools', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:plan');
  const session = system.mcp.session(agent.id)!;

  system.agents.kill(agent.id);

  assert.equal(system.mcp.session(agent.id), null, 'no fresh session for a dead agent');
  const stale = (await session.call('plan_submit', {
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'x',
  })) as ToolResultText;
  assert.equal(stale.isError, true, 'and the bridge that already held one is refused');
  assert.match(stale.content[0]!.text, /unknown or revoked/);
  assert.equal(system.store.plans.getPlanByOrigin('issue:12'), null);
  system.store.close();
});

test('escalate parks the agent with structure the sentinel could never carry', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  const res = await callTool(system, agent, 'escalate', {
    question: 'Which auth provider should I assume?',
    kind: 'choose',
    options: ['Auth0', 'Cognito', 'roll our own'],
    detail: 'The repo has stubs for two of these.',
  });
  assert.equal(res.isError, false);
  assert.equal((JSON.parse(res.text) as { parked: boolean }).parked, true);

  const [esc, ...rest] = system.store.escalations.listOpenEscalations();
  assert.equal(rest.length, 0);
  assert.equal(esc!.prompt, 'Which auth provider should I assume?');
  assert.equal(esc!.type, 'resolve_ambiguity', 'the kind picks the inbox type');
  assert.deepEqual(esc!.context.options, ['Auth0', 'Cognito', 'roll our own']);
  assert.equal(esc!.context.detail, 'The repo has stubs for two of these.');
  assert.equal(esc!.context.originRef, 'issue:12');
  assert.equal(system.store.agents.getAgent(agent.id)?.status, 'waiting');
  system.store.close();
});

test('escalate and the WAITING sentinel converge on one park, in either order', async () => {
  for (const toolFirst of [true, false]) {
    const backend = new FakePtyBackend();
    const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });
    const agent = spawnAgent(system, 'issue:12');

    const sentinel = (): void => backend.last().emit('@@LUBBDUBB_WAITING:Which auth provider?@@');
    const tool = async (): Promise<unknown> =>
      callTool(system, agent, 'escalate', { question: 'Which auth provider?', options: ['Auth0', 'Cognito'] });

    if (toolFirst) {
      await tool();
      sentinel();
    } else {
      sentinel();
      await tool();
    }

    assert.equal(system.store.escalations.listOpenEscalations().length, 1, `one escalation (toolFirst=${toolFirst})`);
    assert.equal(system.store.agents.getAgent(agent.id)?.status, 'waiting');
    system.store.close();
  }
});

test('answering releases the park, so the next question is a fresh one', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  await callTool(system, agent, 'escalate', { question: 'First?' });
  const first = system.store.escalations.listOpenEscalations()[0]!;
  system.escalations.answer(first.id, 'yes');
  assert.equal(system.store.agents.getAgent(agent.id)?.status, 'running');

  await callTool(system, agent, 'escalate', { question: 'Second?' });
  const open = system.store.escalations.listOpenEscalations();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.prompt, 'Second?', 'the latch does not swallow a later, genuinely new ask');
  system.store.close();
});

test('a whitelisted escalate is auto-answered and says so rather than implying a human saw it', async () => {
  const system = buildSystem(testConfig({ whitelistedApprovals: [{ match: 'run the tests', response: 'yes' }] }), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const agent = spawnAgent(system, 'issue:12');

  const res = await callTool(system, agent, 'escalate', { question: 'May I run the tests?' });
  const payload = JSON.parse(res.text) as { parked: boolean; escalationId: string | null };
  assert.equal(payload.parked, false);
  assert.equal(payload.escalationId, null);
  assert.deepEqual(system.store.escalations.listOpenEscalations(), []);
  assert.equal(system.store.agents.getAgent(agent.id)?.status, 'running');
  system.store.close();
});

test('escalate refuses an empty question instead of parking on nothing', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const res = await callTool(system, agent, 'escalate', { question: '   ' });
  assert.equal(res.isError, true);
  assert.deepEqual(system.store.escalations.listOpenEscalations(), []);
  assert.equal(system.store.agents.getAgent(agent.id)?.status, 'running');
  system.store.close();
});

test('world_read answers out of the harness view, with the status envelope on it', async () => {
  const system = build();
  system.store.world.setWorldBaseline(
    fakeWorld({
      pullRequests: [
        fakePr(42, {
          branch: 'issue/12',
          baseBranch: 'main',
          ciStatus: 'failing',
          unresolvedComments: [
            {
              id: 'c1',
              author: 'rev',
              body: 'this leaks a handle',
              handled: false,
              replies: [{ id: 'r1', author: 'rev', body: 'the one in the retry path, specifically', ours: false }],
            },
          ],
        }),
      ],
      issues: [fakeIssue(12, { labels: ['bug'], linkedPrNumber: 42 })],
    }),
  );
  const agent = spawnAgent(system, 'pr:42:ci');

  const res = await callTool(system, agent, 'world_read', { kind: 'pr' });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as {
    observedAt: string;
    item: Record<string, unknown>;
    _status: Record<string, unknown>;
  };
  assert.equal(payload.item.number, 42);
  assert.equal(payload.item.ciStatus, 'failing');
  assert.deepEqual(payload.item.health, { blocked: true, reasons: ['CI failing', '1 unresolved comment'] });
  assert.equal(prPayload(payload.item).unresolvedComments[0]?.body, 'this leaks a handle');
  assert.deepEqual(prPayload(payload.item).unresolvedComments[0]?.replies, [
    { id: 'r1', author: 'rev', body: 'the one in the retry path, specifically', ours: false },
  ]);
  assert.equal(payload.observedAt, TAKEN_AT);
  assert.equal(payload._status.origin, 'pr:42:ci');
  system.store.close();
});

test('reading an issue carries the plan graph, which lives only in the store', async () => {
  const system = build();
  system.store.world.setWorldBaseline(fakeWorld({ issues: [fakeIssue(12, { body: 'Split me.' })] }));
  const planner = spawnAgent(system, 'issue:12:plan');
  await callTool(system, planner, 'plan_submit', {
    reason: 'Schema before reader.',
    parts: [
      { slug: 'schema', title: 'Add the table', scope: 'src/store' },
      { slug: 'reader', title: 'Read it', scope: 'src/dispatcher', dependsOn: ['schema'] },
    ],
  });

  const part = spawnAgent(system, 'issue:12:part:reader');
  const res = await callTool(system, part, 'world_read', { kind: 'issue', ref: 'issue:12:part:reader' });
  assert.equal(res.isError, false);
  const item = (JSON.parse(res.text) as { item: Record<string, unknown> }).item;
  assert.equal(item.body, 'Split me.');
  const plan = item.plan as { status: string; parts: { slug: string; dependsOn: string[] }[] };
  assert.equal(plan.status, 'awaiting_approval');
  assert.deepEqual(
    plan.parts.map((p) => p.slug),
    ['schema', 'reader'],
  );
  assert.deepEqual(plan.parts[1]!.dependsOn, ['schema']);
  system.store.close();
});

test('world_read is deliberately a general read, not one fenced to the caller origin', async () => {
  const system = build();
  system.store.world.setWorldBaseline(
    fakeWorld({
      pullRequests: [
        fakePr(7, { branch: 'issue/12/schema', baseBranch: 'main', ciStatus: 'failing' }),
        fakePr(12, { branch: 'issue/12/reader', baseBranch: 'issue/12/schema', ciStatus: 'failing' }),
      ],
      issues: [fakeIssue(3)],
    }),
  );
  const agent = spawnAgent(system, 'pr:12:ci');

  const base = await callTool(system, agent, 'world_read', { kind: 'pr', ref: 'pr:7' });
  assert.equal(base.isError, false);
  assert.equal((JSON.parse(base.text) as { item: { number: number } }).item.number, 7);

  const issue = await callTool(system, agent, 'world_read', { kind: 'issue', ref: '3' });
  assert.equal((JSON.parse(issue.text) as { item: { title: string } }).item.title, 'Issue 3');
  system.store.close();
});

test('world_read explains itself rather than failing blankly', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  const early = await callTool(system, agent, 'world_read', { kind: 'issue' });
  assert.equal(early.isError, true);
  assert.match(early.text, /has not completed a cycle yet/);

  system.store.world.setWorldBaseline(fakeWorld({ issues: [fakeIssue(12)] }));
  const missing = await callTool(system, agent, 'world_read', { kind: 'issue', ref: '99' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no issue issue:99\. Issues the harness is tracking: #12\./);

  const wrongKind = await callTool(system, agent, 'world_read', { kind: 'pr', ref: 'issue:12' });
  assert.equal(wrongKind.isError, true);
  assert.match(wrongKind.text, /but kind is "pr"/);
  system.store.close();
});

test('a desk agent with no origin is told to name a ref rather than reading nothing', async () => {
  const system = build();
  system.store.world.setWorldBaseline(fakeWorld({ issues: [fakeIssue(12)] }));
  const task = system.store.tasks.createTask({
    kind: 'desk',
    title: 'Ad-hoc',
    prompt: 'poke about',
    branch: null,
    originRef: null,
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-desk-')));

  const res = await callTool(system, agent, 'world_read', { kind: 'issue' });
  assert.equal(res.isError, true);
  assert.match(res.text, /needs a ref/);
  const named = await callTool(system, agent, 'world_read', { kind: 'issue', ref: '12' });
  assert.equal(named.isError, false);
  system.store.close();
});

test('note_progress lands on the agent row and hands back the status envelope', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:142:ci');

  const before = system.store.agents.getAgent(agent.id)!.status;
  const res = await callTool(system, agent, 'note_progress', {
    note: 'Reading how the dispatcher ranks candidates before touching rule `plan-part`',
  });
  assert.equal(res.isError, false);

  const stored = system.store.agents.getAgent(agent.id)!;
  assert.equal(stored.note, 'Reading how the dispatcher ranks candidates before touching rule `plan-part`');
  assert.ok(stored.notedAt, 'the note is dated so a reader can tell how current it is');
  assert.equal(stored.status, before);
  assert.equal(stored.waitingReason, null);
  assert.deepEqual(system.store.escalations.listOpenEscalations(), []);

  const payload = JSON.parse(res.text) as { noted: boolean; note: string; _status: Record<string, unknown> };
  assert.equal(payload.noted, true);
  assert.equal(payload._status.origin, 'pr:142:ci');
  system.store.close();
});

test('a note is a current value, not a stream — the second one replaces the first', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  await callTool(system, agent, 'note_progress', { note: 'Reading the store schema' });
  await callTool(system, agent, 'note_progress', { note: 'Running the full suite after the rename' });

  const stored = system.store.agents.getAgent(agent.id)!;
  assert.equal(stored.note, 'Running the full suite after the rename');

  system.store.agents.updateAgent(agent.id, { status: 'done', endedAt: new Date().toISOString(), pid: null });
  assert.equal(system.store.agents.getAgent(agent.id)!.note, 'Running the full suite after the rename');
  system.store.close();
});

test('an over-long note is stored trimmed and the agent is told, rather than losing it', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  const res = await callTool(system, agent, 'note_progress', { note: 'y'.repeat(MAX_NOTE_LENGTH + 20) });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { note: string; trimmed?: string };
  assert.equal(payload.note.length, MAX_NOTE_LENGTH);
  assert.match(payload.trimmed ?? '', /trimmed/);
  assert.equal(system.store.agents.getAgent(agent.id)!.note?.length, MAX_NOTE_LENGTH);

  const empty = await callTool(system, agent, 'note_progress', { note: '   ' });
  assert.equal(empty.isError, true);
  assert.equal(system.store.agents.getAgent(agent.id)!.note?.length, MAX_NOTE_LENGTH);
  system.store.close();
});

test('silence is not "no progress": an agent that never notes leaves the card as it was', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });
  const { app } = await buildApp(system);
  const agent = spawnAgent(system, 'issue:12');

  backend.last().emit('Running tests…\n');
  backend.last().emit('@@LUBBDUBB_DONE@@');
  assert.equal(system.store.agents.getAgent(agent.id)!.status, 'done');

  const snap = (await (await app.inject({ method: 'GET', url: '/api/state' })).json()) as {
    agents: Record<string, unknown>[];
  };
  const shipped = snap.agents.find((a) => a.id === agent.id)!;
  assert.equal(shipped.note, null);
  assert.equal(shipped.notedAt, null);
  assert.equal('lastLine' in shipped, false);
  assert.equal('note' in shipped, true);
  await app.close();
  system.store.close();
});

test('a note is dated but nothing reads the date as liveness', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const agent = spawnAgent(system, 'issue:12');
  await callTool(system, agent, 'note_progress', { note: 'Waiting on a twenty-minute test run' });

  const snap = (await (await app.inject({ method: 'GET', url: '/api/state' })).json()) as {
    agents: Record<string, unknown>[];
  };
  const shipped = snap.agents.find((a) => a.id === agent.id)!;
  assert.equal(typeof shipped.notedAt, 'string');
  const derived = Object.keys(shipped).filter((k) => /stale|stuck|idle|silent|heartbeat|alive/i.test(k));
  assert.deepEqual(derived, []);
  assert.equal(shipped.status, system.store.agents.getAgent(agent.id)!.status);
  assert.deepEqual(system.store.errors.listErrors(10), []);
  await app.close();
  system.store.close();
});

test('a note is a write, so it too is attributed structurally — one field, and it is the note', async () => {
  const system = build();
  const one = spawnAgent(system, 'pr:142:ci');
  const two = spawnAgent(system, 'issue:12');

  const schema = advertisedSchema(system, one, 'note_progress');
  assert.deepEqual(Object.keys(schema.properties), ['note']);

  await callTool(system, one, 'note_progress', { note: 'Fixing the CI failure' });
  await callTool(system, two, 'note_progress', { note: 'Reading the issue' });
  assert.equal(system.store.agents.getAgent(one.id)!.note, 'Fixing the CI failure');
  assert.equal(system.store.agents.getAgent(two.id)!.note, 'Reading the issue');
  system.store.close();
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

function startPermission(
  system: System,
  agent: Agent,
  input: Record<string, unknown>,
): Promise<{ content: { text: string }[] }> {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  return session!.call('request_permission', { tool_name: 'Bash', input }) as Promise<{ content: { text: string }[] }>;
}

function verdictOf(result: { content: { text: string }[] }): Record<string, unknown> {
  const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  assert.equal('_status' in parsed, false, 'the permission verdict must be bare, not the tool envelope');
  return parsed;
}

test('an un-allowlisted call blocks, appears in the inbox, and Allow lets the same agent run it', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  const pending = startPermission(system, agent, { command: 'terraform apply' });
  await tick();

  const esc = system.store.escalations.listOpenEscalations().find((e) => e.agentId === agent.id);
  assert.ok(esc, 'the blocked call files an escalation');
  assert.ok(esc!.context.permission, 'marked as a permission request');
  assert.match(esc!.prompt, /terraform apply/);
  assert.equal(system.agents.isLive(agent.id), true);

  assert.equal(system.permissions.decide(esc!.id, true), true);
  const verdict = verdictOf(await pending);
  assert.equal(verdict.behavior, 'allow');
  assert.deepEqual(verdict.updatedInput, { command: 'terraform apply' });
  assert.equal(system.store.escalations.getEscalation(esc!.id)?.status, 'answered');
  system.store.close();
});

test('Deny returns a structured denial the agent reads, and does not orphan the task', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const pending = startPermission(system, agent, { command: 'rm -rf /' });
  await tick();
  const esc = system.store.escalations.listOpenEscalations().find((e) => e.agentId === agent.id)!;

  assert.equal(system.permissions.decide(esc.id, false, 'too destructive'), true);
  const verdict = verdictOf(await pending);
  assert.equal(verdict.behavior, 'deny');
  assert.match(String(verdict.message), /too destructive/);
  assert.equal(system.store.tasks.getTask(agent.taskId)?.status, 'running');
  assert.equal(system.permissions.decide(esc.id, true), false);
  system.store.close();
});

test('killing an agent mid-request resolves its blocked call as a denial (no hung Claude)', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const pending = startPermission(system, agent, { command: 'sleep 999' });
  await tick();
  assert.ok(system.store.escalations.listOpenEscalations().some((e) => e.agentId === agent.id));

  system.agents.kill(agent.id);
  const verdict = verdictOf(await pending);
  assert.equal(verdict.behavior, 'deny');
  system.store.close();
});

test('the ordinary answer route refuses a permission request and names the one that settles it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const agent = spawnAgent(system, 'issue:12');
  const pending = startPermission(system, agent, { command: 'docker run x' });
  await tick();
  const esc = system.store.escalations.listOpenEscalations().find((e) => e.agentId === agent.id)!;

  const answered = await app.inject({
    method: 'POST',
    url: `/api/escalations/${esc.id}/answer`,
    payload: { response: 'sure' },
  });
  assert.equal(answered.statusCode, 409);
  assert.match(answered.json().error, /\/permission/);

  const decided = await app.inject({
    method: 'POST',
    url: `/api/escalations/${esc.id}/permission`,
    payload: { allow: true },
  });
  assert.equal(decided.statusCode, 200);
  assert.equal(verdictOf(await pending).behavior, 'allow');
  const again = await app.inject({
    method: 'POST',
    url: `/api/escalations/${esc.id}/permission`,
    payload: { allow: false },
  });
  assert.equal(again.statusCode, 409);
  await app.close();
  system.store.close();
});

test('a system that never listened still mints credentials but wires no config path', () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });
  const agent = spawnAgent(system, 'issue:12');
  assert.ok(system.mcp.session(agent.id));
  assert.equal(backend.spawned[backend.spawned.length - 1]!.args.includes('--mcp-config'), false);
  system.store.close();
});

test('a listening channel is actually threaded onto the launch (--mcp-config + backstop)', async () => {
  const launches: string[][] = [];
  const spawner: Spawner = (_command, args) => {
    launches.push(args);
    return new SilentChild();
  };
  const system = buildSystem(testConfig({ agentMode: 'stream' }), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  assert.equal(await system.mcp.listen(), true);
  try {
    spawnAgent(system, 'issue:12');
    const args = launches[launches.length - 1]!;
    assert.equal(args.includes('--mcp-config'), true, 'the minted config path is forwarded onto the launch');
    assert.equal(args[args.indexOf('--allowedTools') + 1], ALLOWED_MCP_TOOLS.join(','));
    assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], PERMISSION_PROMPT_TOOL);
  } finally {
    await system.mcp.close();
    system.store.close();
  }
});

test('a bridge connection handshakes, lists tools and calls one over a real socket', async (t) => {
  if (process.platform === 'win32') return t.skip('named pipes are exercised by the same code path');
  const system = build();
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sock-'));
  const socketPath = join(dir, 'mcp.sock');
  const server = new McpBridgeServer({
    store: system.store,
    agents: () => system.agents,
    configDir: join(dir, 'config'),
    socketPath,
  });
  assert.equal(await server.listen(), true);

  const agent = spawnAgent(system, 'issue:12:plan');
  const credential = server.open();
  assert.ok(credential.configPath && existsSync(credential.configPath), 'a listening server writes a launch config');
  server.bind(credential.token, agent.id);

  const replies = await roundTrip(socketPath, [
    JSON.stringify({ lubbdubb: 1, token: credential.token }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'plan_submit',
        arguments: { parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }], reason: 'One PR is right.' },
      },
    }),
  ]);

  assert.deepEqual(
    replies.map((r) => r.id),
    [1, 2, 3],
  );
  assert.deepEqual(
    ((replies[1]!.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name).sort(),
    [...MCP_TOOL_NAMES].sort(),
  );
  assert.equal((replies[2]!.result as ToolResultText).isError, undefined);
  assert.equal(system.store.plans.getPlanByOrigin('issue:12')?.status, 'awaiting_approval');

  server.release(credential.token);
  assert.equal(existsSync(credential.configPath!), false);
  await server.close();
  system.store.close();
});

test('a connection that does not identify itself is dropped without answering', async (t) => {
  if (process.platform === 'win32') return t.skip('named pipes are exercised by the same code path');
  const system = build();
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sock-'));
  const socketPath = join(dir, 'mcp.sock');
  const server = new McpBridgeServer({
    store: system.store,
    agents: () => system.agents,
    configDir: join(dir, 'config'),
    socketPath,
  });
  assert.equal(await server.listen(), true);

  const replies = await roundTrip(socketPath, [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })]);
  assert.deepEqual(replies, []);
  await server.close();
  system.store.close();
});

test('the default socket path is per-pid and stays inside the POSIX length limit', () => {
  const path = defaultSocketPath(1234);
  assert.match(path, /1234/);
  if (process.platform !== 'win32') assert.ok(path.length < 104, `socket path too long: ${path}`);
});

function roundTrip(socketPath: string, lines: string[]): Promise<{ id: unknown; result?: unknown }[]> {
  return new Promise((resolve) => {
    const out: { id: unknown; result?: unknown }[] = [];
    const socket = connect(socketPath, () => socket.write(lines.join('\n') + '\n'));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) out.push(JSON.parse(line) as { id: unknown });
      }
    });
    const settle = (): void => {
      socket.destroy();
      resolve(out);
    };
    socket.on('close', settle);
    setTimeout(settle, 250).unref();
  });
}

test('conclude_part closes a part that produced no PR, and the plan rolls up complete', async () => {
  const system = build();
  const plan = system.store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Investigate',
    status: 'active',
    reason: 'Measure before building.',
  });
  system.store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'probe',
      seq: 1,
      title: 'Investigate',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: 'report',
    },
  ]);
  const part = system.store.plans.listPlanParts(plan.id)[0]!;
  system.store.plans.updatePlanPart(part.id, { status: 'dispatched' });

  const agent = spawnAgent(system, 'issue:12:part:probe');
  const res = await callTool(system, agent, 'conclude_part', {
    kind: 'determination',
    summary: 'Already fixed by #98 — nothing to build.',
    evidenceRef: 'finding:f_1',
  });
  assert.equal(res.isError, false);

  const after = system.store.plans.listPlanParts(plan.id)[0]!;
  assert.equal(after.status, 'concluded');
  assert.equal(after.outcomeKind, 'determination');
  assert.equal(after.outcomeRef, 'finding:f_1');
  assert.equal(system.store.plans.rollUpPlanStatus(plan.id)?.status, 'complete');

  const again = await callTool(system, agent, 'conclude_part', { kind: 'report', summary: 'again' });
  assert.equal(again.isError, true);
  system.store.close();
});

test('conclude_part refuses every caller that is not a part agent, naming the right tool', async () => {
  const system = build();
  for (const [origin, expected] of [
    ['issue:12', 'conclude_work'],
    ['issue:12:plan', 'plan_submit'],
    ['issue:12:assess', 'assess_issue'],
    ['pr:42:ci', 'not a part'],
  ] as const) {
    const agent = spawnAgent(system, origin);
    const res = await callTool(system, agent, 'conclude_part', { kind: 'report', summary: 'x' });
    assert.equal(res.isError, true, `${origin} is refused`);
    assert.match(res.text, new RegExp(expected), `${origin} is pointed at ${expected}`);
  }
  system.store.close();
});

test('conclude_part refuses "code": a merge is observed, never declared', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:part:probe');
  const res = await callTool(system, agent, 'conclude_part', { kind: 'code', summary: 'done' });
  assert.equal(res.isError, true);
  assert.match(res.text, /pull request/);
  const kind = advertisedSchema(system, agent, 'conclude_part').properties.kind as { enum: string[] };
  assert.deepEqual(kind.enum, ['report', 'determination']);
  system.store.close();
});

test('every terminal tool tells the caller to print the done sentinel', async () => {
  const system = build();
  const plan = system.store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Investigate',
    status: 'active',
    reason: 'Measure before building.',
  });
  system.store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'probe',
      seq: 1,
      title: 'Investigate',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: 'report',
    },
  ]);
  system.store.plans.updatePlanPart(system.store.plans.listPlanParts(plan.id)[0]!.id, { status: 'dispatched' });

  const calls = [
    ['issue:12:assess', 'assess_issue', { status: 'delivered', summary: 'all present' }],
    ['issue:13:assess', 'assess_issue', { status: 'more_work', summary: 'the migration is missing' }],
    ['issue:14', 'conclude_work', { status: 'done', note: 'shipped in #40' }],
    ['issue:15', 'conclude_work', { status: 'more_work', note: 'the CLI half is left' }],
    ['issue:12:part:probe', 'conclude_part', { kind: 'report', summary: 'measured; nothing to build' }],
  ] as const;

  for (const [origin, tool, args] of calls) {
    const agent = spawnAgent(system, origin);
    const res = await callTool(system, agent, tool, args);
    assert.equal(res.isError, false, `${tool} accepted the call for ${origin}`);
    assert.ok(res.text.includes(DONE_SENTINEL), `${tool} (${origin}) names the sentinel in its success note`);
  }
  system.store.close();
});

test('the finish reminder states a condition rather than announcing the end', () => {
  assert.ok(DONE_REMINDER.includes(DONE_SENTINEL), 'the reminder is built from the sentinel, never a second copy');
  assert.match(DONE_REMINDER, /when you have finished everything/i);
});

test('open_pr opens the pull request for the calling agent, titled by the convention', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 182, title: 'Ticket sync rewrite', body: '' });
  await system.harness.runCycle('manual');
  const agent = spawnAgent(system, 'issue:182');

  const res = await callTool(system, agent, 'open_pr', {
    summary: 'sync cursor table',
    type: 'feat',
    scope: 'store',
    body: 'Adds the cursor the reconciler reads.',
  });
  const payload = JSON.parse(res.text) as { opened: boolean; pullRequest: number; title: string; base: string };
  assert.equal(payload.opened, true);
  assert.equal(payload.title, '#182 feat(store): sync cursor table', 'no position clause on a lone PR');
  assert.equal(payload.base, 'main');

  const world = await system.connector.getState();
  const opened = world.pullRequests.find((p) => p.number === payload.pullRequest);
  assert.ok(opened, 'the PR is in the world');
  assert.equal(opened.branch, 'issue/182');
  assert.match(opened.title, /^#182 feat\(store\)/);

  assert.equal(world.issues.find((i) => i.number === 182)?.linkedPrNumber, payload.pullRequest);
  assert.ok(
    system.store.workItemLinks.linkedWorkItemPrs().has(payload.pullRequest),
    'and the link is recorded, so it happens once',
  );
  system.store.close();
});

test('open_pr opens a part’s pull request against its own branch, plan and all', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 183, title: 'Ticket sync rewrite', body: '' });
  await system.harness.runCycle('manual');
  const plan = system.store.plans.upsertPlan({
    originRef: 'issue:183',
    title: 'Ticket sync rewrite',
    status: 'active',
    reason: 'Schema before reader.',
  });
  system.store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Add the table',
      scope: 'src/store',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: 'code',
    },
    {
      slug: 'reader',
      seq: 2,
      title: 'Read it',
      scope: 'src/dispatcher',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: 'code',
    },
  ]);
  const bottom = system.store.plans.listPlanParts(plan.id).find((p) => p.slug === 'schema')!;
  system.store.plans.updatePlanPart(bottom.id, { status: 'dispatched' });

  const first = await callTool(system, spawnAgent(system, 'issue:183:part:schema'), 'open_pr', {
    summary: 'sync cursor table',
    type: 'feat',
    scope: 'store',
  });
  const bottomPr = JSON.parse(first.text) as { opened: boolean; pullRequest: number; title: string; base: string };
  assert.equal(bottomPr.opened, true, 'a part agent is not refused for want of a plan');
  assert.equal(bottomPr.title, '#183 [1/2] feat(store): sync cursor table');
  assert.equal(bottomPr.base, 'main', 'the bottom of the stack sits on the integration branch');

  const second = await callTool(system, spawnAgent(system, 'issue:183:part:reader'), 'open_pr', {
    summary: 'read the cursor table',
  });
  const topPr = JSON.parse(second.text) as { pullRequest: number; title: string; base: string };
  assert.equal(topPr.base, 'issue/183/schema');
  assert.equal(topPr.title, '#183 [2/2] read the cursor table');

  const world = await system.connector.getState();
  assert.equal(world.pullRequests.find((p) => p.number === bottomPr.pullRequest)?.branch, 'issue/183/schema');
  assert.equal(world.pullRequests.find((p) => p.number === topPr.pullRequest)?.branch, 'issue/183/reader');
  system.store.close();
});

test('open_pr states no position for a lone part, and the plan roll-up reaches it', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 184, title: 'Prune the spool', body: '' });
  await system.harness.runCycle('manual');
  const plan = system.store.plans.upsertPlan({
    originRef: 'issue:184',
    title: 'Prune the spool',
    status: 'active',
    reason: 'One pull request will do.',
  });
  system.store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'prune',
      seq: 1,
      title: 'Prune it',
      scope: 'src/spool',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: 'code',
    },
  ]);

  const res = await callTool(system, spawnAgent(system, 'issue:184:part:prune'), 'open_pr', {
    summary: 'prune the spool',
  });
  const payload = JSON.parse(res.text) as {
    title: string;
    base: string;
    _status: { plan?: { status: string; parts: { slug: string }[] } };
  };
  assert.equal(payload.title, '#184 prune the spool', 'a plan of one part states no position');
  assert.equal(payload.base, 'main');
  assert.equal(payload._status.plan?.status, 'active');
  assert.deepEqual(
    payload._status.plan?.parts.map((p) => p.slug),
    ['prune'],
  );
  system.store.close();
});

test('open_pr is refused for an origin that is not doing an issue’s work', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:142:ci');
  const res = await callTool(system, agent, 'open_pr', { summary: 'whatever' });
  assert.match(res.text, /open_pr is for/);
  const world = await system.connector.getState();
  assert.equal(world.pullRequests.length, 0, 'nothing was opened');
  system.store.close();
});

test('open_pr degrades to the floor when authoring is unwired — it never silently no-ops', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:182');
  const task = system.store.tasks.getTask(agent.taskId)!;
  const tool = buildTools({ store: system.store, agents: system.agents }, { agent, task }).find(
    (t) => t.name === 'open_pr',
  );
  assert.ok(tool, 'the tool is still advertised, so names.ts stays honest');
  const result = await tool.handler({ summary: 'x' });
  assert.match(JSON.stringify(result), /not wired|open the pull request yourself/i);
  system.store.close();
});

test('the caller is resolved in exactly one place, so the identity chain cannot be got wrong twice', () => {
  const source = repoText('src/agents/agentManager.ts');
  const preamble = source.match(/agent \? this\.store\.tasks\.getTask\(agent\.taskId\) : null/g) ?? [];
  assert.equal(preamble.length, 1, 'the agent -> task resolution appears once, inside withCaller');
  assert.match(source, /private withCaller</, 'and that one copy is the wrapper the tool-facing methods run through');
});

test('every advertised tool is its own module, and tools.ts is assembly and nothing else', () => {
  const source = repoText('src/mcp/tools.ts');
  assert.equal(source.includes('inputSchema'), false, 'no schema is declared in the registry');
  assert.equal(source.includes('handler:'), false, 'no handler is declared in the registry');
  const imported = [...source.matchAll(/from '\.\/tools\/([A-Za-z]+)\.js';/g)].map((m) => m[1]);
  for (const name of MCP_TOOL_NAMES) {
    const module = name.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
    assert.ok(imported.includes(module), `${name} is built by tools/${module}.ts`);
  }
  assert.equal(
    imported.filter((m) => m !== 'context').length,
    MCP_TOOL_NAMES.length,
    'one module per advertised tool, and no module that is not one',
  );
});

test('every origin fence points a refused caller at a tool that accepts it', () => {
  const accepts: Record<string, (ref: string) => boolean> = {
    conclude_work: (ref) => conclusionOrigin(ref).ok,
    conclude_part: (ref) => partConclusionOrigin(ref).ok,
    assess_issue: (ref) => assessmentOrigin(ref).ok,
    appraise_issue: (ref) => appraiserOrigin(ref).ok,
    plan_submit: (ref) => planOriginIssue(ref) !== null,
  };
  const fences: [string, (ref: string) => { ok: boolean; error?: string }][] = [
    ['assess_issue', assessmentOrigin],
    ['appraise_issue', appraiserOrigin],
    ['conclude_work', conclusionOrigin],
    ['conclude_part', partConclusionOrigin],
  ];
  const origins = ['issue:12', 'issue:12:plan', 'issue:12:part:schema', 'issue:12:assess', 'issue:12:appraisal'];

  for (const [tool, fence] of fences) {
    for (const origin of origins) {
      const verdict = fence(origin);
      if (verdict.ok) continue;
      const error = verdict.error ?? '';
      const named = Object.keys(accepts).filter((name) => name !== tool && error.includes(name));
      if (named.length === 0) {
        assert.match(error, /escalate|raise/, `${tool} refusing ${origin} names no tool and no other remedy`);
        continue;
      }
      for (const name of named) {
        assert.ok(accepts[name]!(origin), `${tool} refuses ${origin} by naming ${name}, which refuses it too`);
      }
    }
  }
});
