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
import { escalationTypeForAsk } from '../src/escalation/context.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Agent } from '../src/types.js';

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
