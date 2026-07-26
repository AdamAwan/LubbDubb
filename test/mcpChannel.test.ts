import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs, buildClaudeStreamArgs, MCP_PROTOCOL_ADDENDUM } from '../src/agents/agentProtocol.js';
import { handleRequest, parseFrame, type McpTool, toolJson } from '../src/mcp/protocol.js';
import { ALLOWED_MCP_TOOLS, MCP_SERVER_ID, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { defaultSocketPath, McpBridgeServer } from '../src/mcp/server.js';
import { parseWorldRef, readWorldItem, WORLD_READ_KINDS } from '../src/mcp/worldRead.js';
import { escalationTypeForAsk } from '../src/escalation/context.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Agent, Issue, PullRequest, Story, WorldSnapshot } from '../src/types.js';

/** The MCP tool-result shape, as a caller reads it off the wire. */
interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

// -- the wire protocol, with no transport at all -----------------------------

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
  assert.equal(parseFrame('{"jsonrpc":"2.0","id":1}'), null); // no method
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
  // An unknown *notification* is also answered with nothing — replying to one is
  // itself a protocol violation.
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

// -- launch wiring -----------------------------------------------------------

test('--mcp-config is wired only when a config path was minted, in both runtimes', () => {
  for (const build of [buildClaudeArgs, buildClaudeStreamArgs]) {
    const off = build({});
    assert.equal(off.includes('--mcp-config'), false);
    assert.equal(off[off.indexOf('--append-system-prompt') + 1]?.includes(MCP_PROTOCOL_ADDENDUM), false);

    const on = build({ mcpConfigPath: '/tmp/agent.json' });
    assert.equal(on[on.indexOf('--mcp-config') + 1], '/tmp/agent.json');
    // The tools have to be *described*, or they may as well not be wired.
    assert.ok(on[on.indexOf('--append-system-prompt') + 1]?.includes(MCP_PROTOCOL_ADDENDUM));
    // Never --strict-mcp-config: it would suppress the target repo's own
    // .mcp.json, and our worktree is a checkout of the user's repository.
    assert.equal(on.includes('--strict-mcp-config'), false);
    // Without this every call is refused: an --mcp-config server connects
    // unapproved, but `acceptEdits` does not cover its tool calls and there is no
    // human at the prompt to grant them.
    assert.equal(on[on.indexOf('--allowedTools') + 1], ALLOWED_MCP_TOOLS.join(','));
    // Operator args land after ours, so an explicit --allowedTools still wins.
    const withExtra = build({ mcpConfigPath: '/tmp/agent.json', extraArgs: ['--allowedTools', 'Bash'] });
    assert.ok(withExtra.lastIndexOf('--allowedTools') > withExtra.indexOf('--allowedTools'));
  }
});

test('the granted permission names are exactly the tools the server exposes', () => {
  // Three things must agree — the launch-config key, the tool names, and the
  // `mcp__<key>__<tool>` grants. Drift between them yields a *connected* server
  // whose every call is refused, which is invisible until an agent needs it.
  assert.deepEqual(
    ALLOWED_MCP_TOOLS,
    MCP_TOOL_NAMES.map((name) => `mcp__${MCP_SERVER_ID}__${name}`),
  );
});

test('the addendum keeps the sentinels as the floor rather than withdrawing them', () => {
  // The done sentinel has no tool, and the prompt must not imply otherwise.
  assert.match(MCP_PROTOCOL_ADDENDUM, /@@LUBBDUBB_DONE@@/);
  assert.match(MCP_PROTOCOL_ADDENDUM, /fall back to the sentinels/i);
});

// -- kind mapping ------------------------------------------------------------

test('an escalate kind files as an inbox type, unknown kinds landing where the sentinel does', () => {
  assert.equal(escalationTypeForAsk('approve'), 'approve_change');
  assert.equal(escalationTypeForAsk('choose'), 'resolve_ambiguity');
  assert.equal(escalationTypeForAsk('clarify'), 'resolve_ambiguity');
  assert.equal(escalationTypeForAsk('review'), 'review_reply');
  assert.equal(escalationTypeForAsk(undefined), 'answer_question');
  assert.equal(escalationTypeForAsk('nonsense'), 'answer_question');
});

// -- world_read's pure layer -------------------------------------------------

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

function fakeStory(id: string, extra: Partial<Story> = {}): Story {
  return {
    id,
    title: `Story ${id}`,
    description: null,
    acceptanceCriteria: null,
    wafPillars: [],
    state: 'ready',
    priority: 1,
    ...extra,
  };
}

function fakeWorld(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return { takenAt: TAKEN_AT, pullRequests: [], issues: [], stories: [], ...overrides };
}

/** A parsed target, asserting the parse succeeded — for tests about the *read*. */
function target(kind: string, ref: string) {
  const parsed = parseWorldRef(kind, ref);
  assert.ok(parsed.ok, `${kind}/${ref} should parse`);
  return parsed.target;
}

test('the kind vocabulary is the one the dispatcher already models', () => {
  // Not a new taxonomy: exactly the three lists a WorldSnapshot carries and the
  // three ref prefixes the rest of the system writes.
  assert.deepEqual([...WORLD_READ_KINDS], ['pr', 'issue', 'story']);
});

test('a ref is accepted in every shape the harness itself writes', () => {
  const cases: [string, string, string][] = [
    ['pr', 'pr:42', 'pr:42'],
    ['pr', '42', 'pr:42'],
    ['pr', '#42', 'pr:42'],
    // Origin refs carry a concern after the number; they name the same world item.
    ['pr', 'pr:42:ci', 'pr:42'],
    ['pr', 'pr:42:comment:c_9', 'pr:42'],
    ['issue', 'issue:12', 'issue:12'],
    ['issue', 'issue:12:plan', 'issue:12'],
    ['issue', 'issue:12:part:schema', 'issue:12'],
    ['story', 'story:st_1', 'story:st_1'],
    ['story', 'st_1', 'story:st_1'],
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
  assert.match(!badKind.ok ? badKind.error : '', /kind must be one of pr, issue, story/);

  const noNumber = parseWorldRef('pr', 'pr:main');
  assert.equal(noNumber.ok, false);
  assert.match(!noNumber.ok ? noNumber.error : '', /does not contain a pr number/);

  assert.equal(parseWorldRef('pr', '   ').ok, false);
});

test('a PR reads back with the same health verdict and stack attribution the cockpit shows', () => {
  // #12 is stacked on #7, and #7 is the one that is actually red.
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
  // Whose failure it is — the same attribution that stopped an agent being
  // dispatched here, so the agent is told rather than left to wonder.
  assert.equal(item.ciFailingOnBasePr, 7);
  assert.equal(item.basePr?.number, 7);
  assert.ok(item.health.reasons.includes('CI failing on base PR #7'));
  assert.deepEqual(
    item.unresolvedComments.map((c) => c.body),
    ['rename this'],
  );
});

/** Narrow a read PR payload for assertions. */
function prPayload(item: Record<string, unknown>) {
  return item as unknown as {
    ciFailingOnBasePr: number | null;
    basePr: { number: number } | null;
    health: { blocked: boolean; reasons: string[] };
    unresolvedComments: { body: string }[];
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
  const world = fakeWorld({ pullRequests: [fakePr(7), fakePr(12)], issues: [fakeIssue(3)], stories: [fakeStory('a')] });
  const missPr = readWorldItem(world, target('pr', '99'));
  assert.equal(missPr.ok, false);
  assert.match(!missPr.ok ? missPr.error : '', /no PR pr:99\. PRs the harness is tracking: #7, #12\./);

  const empty = readWorldItem(fakeWorld(), target('story', 'x'));
  assert.match(!empty.ok ? empty.error : '', /tracking no Stories/);
});

// -- end to end through a built system ---------------------------------------

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-mcp-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

function build(overrides: Record<string, unknown> = {}): System {
  return buildSystem(testConfig(overrides), { backend: new FakePtyBackend(), errorMirror: () => {} });
}

/** Spawn an agent on `originRef`. A temp cwd is enough — nothing here touches git. */
function spawnAgent(system: System, originRef: string, title = 'Big thing'): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: title,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

/** Call a tool as an agent would, through the same entry point its bridge reaches. */
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
    verdict: 'parts',
    reason: 'Schema before reader.',
    parts: [
      { slug: 'schema', title: 'Add the table', scope: 'src/store' },
      { slug: 'reader', title: 'Read it', scope: 'src/dispatcher', dependsOn: ['schema'] },
    ],
  });
  assert.equal(res.isError, false);

  const plan = system.store.getPlanByOrigin('issue:12');
  assert.ok(plan, 'the plan landed against the issue origin, not the planner origin');
  assert.equal(plan!.status, 'active');
  assert.equal(plan!.title, 'Big thing');
  assert.deepEqual(
    system.store.listPlanParts(plan!.id).map((p) => p.slug),
    ['schema', 'reader'],
  );

  // The `_status` envelope is what removes the need for a polling tool.
  const payload = JSON.parse(res.text) as { accepted: boolean; _status: Record<string, unknown> };
  assert.equal(payload.accepted, true);
  assert.equal(payload._status.origin, 'issue:12:plan');
  // Freshly written parts are `pending`; the reconciler is what readies them, and
  // the envelope reports what is, not what will be.
  assert.deepEqual(payload._status.plan, {
    status: 'active',
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

  // A cycle: rejected by the same schema the file path uses.
  const res = await callTool(system, agent, 'plan_submit', {
    verdict: 'parts',
    reason: 'Circular.',
    parts: [
      { slug: 'a', title: 'A', scope: 'x', dependsOn: ['b'] },
      { slug: 'b', title: 'B', scope: 'y', dependsOn: ['a'] },
    ],
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /dependency cycle/);
  // The whole point over the file path: the agent hears the reason *and* the plan
  // graph is untouched, so a retry starts from a clean slate rather than a merge.
  assert.equal(system.store.getPlanByOrigin('issue:12'), null);
  assert.deepEqual(system.store.listPlans(), []);

  // ...and the retry, corrected, lands.
  const fixed = await callTool(system, agent, 'plan_submit', {
    verdict: 'single',
    reason: 'Small after all.',
  });
  assert.equal(fixed.isError, false);
  assert.equal(system.store.getPlanByOrigin('issue:12')?.status, 'single');
  system.store.close();
});

test('identity is structural: an agent cannot submit a plan for work it was not dispatched to', async () => {
  const system = build();
  // An ordinary pickup agent, not a planner. It takes no origin argument — there
  // is none to take — so the only origin it could ever write is its own, and its
  // own is not a planning origin.
  const worker = spawnAgent(system, 'issue:12');

  const res = await callTool(system, worker, 'plan_submit', { verdict: 'single', reason: 'Mine now.' });
  assert.equal(res.isError, true);
  assert.match(res.text, /only available to a planning agent/);
  assert.equal(system.store.getPlanByOrigin('issue:12'), null);

  // A planner on a *different* issue writes only its own issue, for the same reason.
  const planner = spawnAgent(system, 'issue:41:plan');
  await callTool(system, planner, 'plan_submit', { verdict: 'single', reason: 'Just one.' });
  assert.ok(system.store.getPlanByOrigin('issue:41'));
  assert.equal(system.store.getPlanByOrigin('issue:12'), null, 'no cross-origin write');
  system.store.close();
});

test('a revoked credential can no longer call tools', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:plan');
  const session = system.mcp.session(agent.id)!;

  system.agents.kill(agent.id); // the cockpit kill path revokes the credential

  assert.equal(system.mcp.session(agent.id), null, 'no fresh session for a dead agent');
  const stale = (await session.call('plan_submit', { verdict: 'single', reason: 'x' })) as ToolResultText;
  assert.equal(stale.isError, true, 'and the bridge that already held one is refused');
  assert.match(stale.content[0]!.text, /unknown or revoked/);
  assert.equal(system.store.getPlanByOrigin('issue:12'), null);
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

  const [esc, ...rest] = system.store.listOpenEscalations();
  assert.equal(rest.length, 0);
  assert.equal(esc!.prompt, 'Which auth provider should I assume?');
  assert.equal(esc!.type, 'resolve_ambiguity', 'the kind picks the inbox type');
  assert.deepEqual(esc!.context.options, ['Auth0', 'Cognito', 'roll our own']);
  assert.equal(esc!.context.detail, 'The repo has stubs for two of these.');
  assert.equal(esc!.context.originRef, 'issue:12');
  assert.equal(system.store.getAgent(agent.id)?.status, 'waiting');
  system.store.close();
});

test('escalate and the WAITING sentinel converge on one park, in either order', async () => {
  // The two detectors of one transition. Whichever arrives first owns it.
  for (const toolFirst of [true, false]) {
    const backend = new FakePtyBackend();
    const system = buildSystem(testConfig(), { backend, errorMirror: () => {} });
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

    assert.equal(system.store.listOpenEscalations().length, 1, `one escalation (toolFirst=${toolFirst})`);
    assert.equal(system.store.getAgent(agent.id)?.status, 'waiting');
    system.store.close();
  }
});

test('answering releases the park, so the next question is a fresh one', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  await callTool(system, agent, 'escalate', { question: 'First?' });
  const first = system.store.listOpenEscalations()[0]!;
  system.escalations.answer(first.id, 'yes');
  assert.equal(system.store.getAgent(agent.id)?.status, 'running');

  await callTool(system, agent, 'escalate', { question: 'Second?' });
  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.prompt, 'Second?', 'the latch does not swallow a later, genuinely new ask');
  system.store.close();
});

test('a whitelisted escalate is auto-answered and says so rather than implying a human saw it', async () => {
  const system = buildSystem(testConfig({ whitelistedApprovals: [{ match: 'run the tests', response: 'yes' }] }), {
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const agent = spawnAgent(system, 'issue:12');

  const res = await callTool(system, agent, 'escalate', { question: 'May I run the tests?' });
  const payload = JSON.parse(res.text) as { parked: boolean; escalationId: string | null };
  assert.equal(payload.parked, false);
  assert.equal(payload.escalationId, null);
  assert.deepEqual(system.store.listOpenEscalations(), []);
  assert.equal(system.store.getAgent(agent.id)?.status, 'running');
  system.store.close();
});

test('escalate refuses an empty question instead of parking on nothing', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const res = await callTool(system, agent, 'escalate', { question: '   ' });
  assert.equal(res.isError, true);
  assert.deepEqual(system.store.listOpenEscalations(), []);
  assert.equal(system.store.getAgent(agent.id)?.status, 'running');
  system.store.close();
});

test('world_read answers out of the harness view, with the status envelope on it', async () => {
  const system = build();
  // The baseline is what `Harness.recordWorldChanges` persists each pulse — so
  // seeding it is exactly what a cycle would have left behind.
  system.store.setWorldBaseline(
    fakeWorld({
      pullRequests: [
        fakePr(42, {
          branch: 'issue/12',
          baseBranch: 'main',
          ciStatus: 'failing',
          unresolvedComments: [{ id: 'c1', author: 'rev', body: 'this leaks a handle', handled: false }],
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
  // No ref argument: the common case is "how is the thing I was dispatched for",
  // and the origin the envelope hands back is the ref it defaults to.
  assert.equal(payload.item.number, 42);
  assert.equal(payload.item.ciStatus, 'failing');
  assert.deepEqual(payload.item.health, { blocked: true, reasons: ['CI failing', '1 unresolved comment'] });
  assert.equal(prPayload(payload.item).unresolvedComments[0]?.body, 'this leaks a handle');
  // A pulse-old reading, not a live fetch — and it says which.
  assert.equal(payload.observedAt, TAKEN_AT);
  assert.equal(payload._status.origin, 'pr:42:ci');
  system.store.close();
});

test('reading an issue carries the plan graph, which lives only in the store', async () => {
  const system = build();
  system.store.setWorldBaseline(fakeWorld({ issues: [fakeIssue(12, { body: 'Split me.' })] }));
  const planner = spawnAgent(system, 'issue:12:plan');
  await callTool(system, planner, 'plan_submit', {
    verdict: 'parts',
    reason: 'Schema before reader.',
    parts: [
      { slug: 'schema', title: 'Add the table', scope: 'src/store' },
      { slug: 'reader', title: 'Read it', scope: 'src/dispatcher', dependsOn: ['schema'] },
    ],
  });

  // A part agent reading its parent issue: the sibling graph is most of what it
  // needs, and it is in the store rather than in the world snapshot.
  const part = spawnAgent(system, 'issue:12:part:reader');
  const res = await callTool(system, part, 'world_read', { kind: 'issue', ref: 'issue:12:part:reader' });
  assert.equal(res.isError, false);
  const item = (JSON.parse(res.text) as { item: Record<string, unknown> }).item;
  assert.equal(item.body, 'Split me.');
  const plan = item.plan as { status: string; parts: { slug: string; dependsOn: string[] }[] };
  assert.equal(plan.status, 'active');
  assert.deepEqual(
    plan.parts.map((p) => p.slug),
    ['schema', 'reader'],
  );
  assert.deepEqual(plan.parts[1]!.dependsOn, ['schema']);
  system.store.close();
});

test('world_read is deliberately a general read, not one fenced to the caller origin', async () => {
  // The choice, asserted rather than merely intended. The dispatcher's own
  // reasoning is cross-item — #12's red CI belongs to #7 — so an agent told that
  // must be able to look at #7, or it is back to shelling out to `gh`, which is
  // the gap this tool closes. Writes stay fenced: see the plan_submit test above.
  const system = build();
  system.store.setWorldBaseline(
    fakeWorld({
      pullRequests: [
        fakePr(7, { branch: 'issue/12/schema', baseBranch: 'main', ciStatus: 'failing' }),
        fakePr(12, { branch: 'issue/12/reader', baseBranch: 'issue/12/schema', ciStatus: 'failing' }),
      ],
      issues: [fakeIssue(3)],
      stories: [fakeStory('st_1', { labels: ['later'] })],
    }),
  );
  const agent = spawnAgent(system, 'pr:12:ci');

  const base = await callTool(system, agent, 'world_read', { kind: 'pr', ref: 'pr:7' });
  assert.equal(base.isError, false);
  assert.equal((JSON.parse(base.text) as { item: { number: number } }).item.number, 7);

  // Not just other PRs — any item the harness tracks, in any kind. It can only
  // ever name what the harness already holds: there is no query and no passthrough.
  const issue = await callTool(system, agent, 'world_read', { kind: 'issue', ref: '3' });
  assert.equal((JSON.parse(issue.text) as { item: { title: string } }).item.title, 'Issue 3');
  const story = await callTool(system, agent, 'world_read', { kind: 'story', ref: 'story:st_1' });
  assert.deepEqual((JSON.parse(story.text) as { item: { labels: string[] } }).item.labels, ['later']);
  system.store.close();
});

test('world_read explains itself rather than failing blankly', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  // Before any cycle there is no snapshot at all: an actionable message, not a throw.
  const early = await callTool(system, agent, 'world_read', { kind: 'issue' });
  assert.equal(early.isError, true);
  assert.match(early.text, /has not completed a cycle yet/);

  system.store.setWorldBaseline(fakeWorld({ issues: [fakeIssue(12)] }));
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
  system.store.setWorldBaseline(fakeWorld({ issues: [fakeIssue(12)] }));
  // An operator job has no world origin, so there is nothing for `ref` to default to.
  const task = system.store.createTask({
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
  // ...and naming one works, which is the whole reason it isn't origin-fenced.
  const named = await callTool(system, agent, 'world_read', { kind: 'issue', ref: '12' });
  assert.equal(named.isError, false);
  system.store.close();
});

// -- the fail-open floor -----------------------------------------------------

test('with the channel off, no launch carries it and the sentinels still park and finish', () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ mcp: { enabled: false } }), { backend, errorMirror: () => {} });
  const agent = spawnAgent(system, 'issue:12');

  assert.equal(system.mcp.session(agent.id), null, 'no credential is minted at all');
  assert.equal(
    backend.spawned[backend.spawned.length - 1]!.args.includes('--mcp-config'),
    false,
    'and nothing is wired into the launch',
  );

  // The floor: an agent with no tool channel parks and finishes exactly as before.
  backend.last().emit('@@LUBBDUBB_WAITING:Which auth provider?@@');
  assert.equal(system.store.listOpenEscalations().length, 1);
  system.escalations.answer(system.store.listOpenEscalations()[0]!.id, 'Auth0');
  backend.last().emit('@@LUBBDUBB_DONE@@');
  assert.equal(system.store.getAgent(agent.id)?.status, 'done');
  system.store.close();
});

test('a system that never listened still mints credentials but wires no config path', () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend, errorMirror: () => {} });
  const agent = spawnAgent(system, 'issue:12');
  // Identity exists (this is the path tests drive), but with no socket there is
  // nothing for an agent to connect to, so the launch is left alone.
  assert.ok(system.mcp.session(agent.id));
  assert.equal(backend.spawned[backend.spawned.length - 1]!.args.includes('--mcp-config'), false);
  system.store.close();
});

// -- the socket, once, for real ----------------------------------------------

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
      params: { name: 'plan_submit', arguments: { verdict: 'single', reason: 'One PR is right.' } },
    }),
  ]);

  // The notification produced no frame, so three replies for four requests.
  assert.deepEqual(
    replies.map((r) => r.id),
    [1, 2, 3],
  );
  // The advertised set is the same list `--allowedTools` grants — the other half
  // of the drift guard above, asserted against what the server actually exposes.
  assert.deepEqual(
    ((replies[1]!.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name).sort(),
    [...MCP_TOOL_NAMES].sort(),
  );
  assert.equal((replies[2]!.result as ToolResultText).isError, undefined);
  assert.equal(system.store.getPlanByOrigin('issue:12')?.status, 'single');

  // Revoking removes the launch config with the credential.
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

  // The token is the only thing between a local process and the whole fleet's store.
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

/** Write `lines` to the socket and collect whatever frames come back before it settles. */
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
