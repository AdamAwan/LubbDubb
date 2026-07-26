import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs, buildClaudeStreamArgs, MCP_PROTOCOL_ADDENDUM } from '../src/agents/agentProtocol.js';
import { handleRequest, parseFrame, type McpTool, toolJson } from '../src/mcp/protocol.js';
import { ALLOWED_MCP_TOOLS, MCP_SERVER_ID, MCP_TOOL_NAMES, PERMISSION_PROMPT_TOOL } from '../src/mcp/names.js';
import { defaultSocketPath, McpBridgeServer } from '../src/mcp/server.js';
import { parseWorldRef, readWorldItem, WORLD_READ_KINDS } from '../src/mcp/worldRead.js';
import {
  FINDING_KIND_HELP,
  FINDING_KINDS,
  findingJobRequest,
  parseFindingRef,
  validateFinding,
} from '../src/mcp/findings.js';
import { MAX_NOTE_LENGTH, normaliseNote } from '../src/mcp/progress.js';
import { buildTools } from '../src/mcp/tools.js';
import { buildApp } from '../src/server/app.js';
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

test('the permission backstop tool is wired only alongside the channel it lives on (#130)', () => {
  for (const build of [buildClaudeArgs, buildClaudeStreamArgs]) {
    // No --mcp-config → the tool has no server, so no flag however it's asked for.
    const noChannel = build({ permissionPromptTool: PERMISSION_PROMPT_TOOL });
    assert.equal(noChannel.includes('--permission-prompt-tool'), false);
    // Channel on but the operator disabled the backstop → still no flag.
    const disabled = build({ mcpConfigPath: '/tmp/agent.json' });
    assert.equal(disabled.includes('--permission-prompt-tool'), false);
    // Both → Claude Code routes an un-allowlisted call to our tool instead of denying.
    const on = build({ mcpConfigPath: '/tmp/agent.json', permissionPromptTool: PERMISSION_PROMPT_TOOL });
    assert.equal(on[on.indexOf('--permission-prompt-tool') + 1], PERMISSION_PROMPT_TOOL);
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
  // The permission-prompt tool is one of them, or the permission machinery's own
  // call to it is refused — the exact trap names.ts exists to prevent (#130).
  assert.ok(ALLOWED_MCP_TOOLS.includes(PERMISSION_PROMPT_TOOL));
  assert.equal(PERMISSION_PROMPT_TOOL, `mcp__${MCP_SERVER_ID}__request_permission`);
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

// -- report_finding's pure layer ---------------------------------------------

test('the finding kinds are the three things agents concretely could not say', () => {
  // Not a taxonomy: one kind per gap in Exhibit C of #108, each implying a
  // different operator action. A catch-all fourth would be where findings rot.
  assert.deepEqual([...FINDING_KINDS], ['duplicate', 'blocked', 'out_of_scope']);
  for (const kind of FINDING_KINDS) assert.ok(FINDING_KIND_HELP[kind], `${kind} is described to the agent`);
});

test('a finding ref is the harness vocabulary, suffix-tolerant, and optional', () => {
  const cases: [unknown, string | null][] = [
    [undefined, null], // not every finding is about a tracked item
    ['', null],
    ['issue:41', 'issue:41'],
    ['pr:42', 'pr:42'],
    // The origin ref an agent holds names its item, so it can be passed back as-is.
    ['pr:42:ci', 'pr:42'],
    ['issue:12:part:schema', 'issue:12'],
    ['story:st_1', 'story:st_1'],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseFindingRef(input);
    assert.equal(parsed.ok, true, `${JSON.stringify(input)} should parse`);
    assert.equal(parsed.ok && parsed.ref, expected);
  }
});

test('a bare number is refused rather than guessed at, unlike world_read', () => {
  // world_read has a `kind` argument to say which list a number belongs to; this
  // has none, and "#41" is an issue or a PR. A duplicate report must not guess.
  const bare = parseFindingRef('41');
  assert.equal(bare.ok, false);
  assert.match(!bare.ok ? bare.error : '', /ambiguous between an issue and a PR/);

  // And an off-vocabulary ref is refused with somewhere to put it instead: an
  // open-ended ref field is an unqueryable junk drawer.
  const upstream = parseFindingRef('npm:left-pad');
  assert.equal(upstream.ok, false);
  assert.match(!upstream.ok ? upstream.error : '', /omit ref and describe it in the summary/);
  assert.equal(parseFindingRef('issue:main').ok, false);
});

test('a finding is validated at the boundary, with the reason handed back', () => {
  const bad = validateFinding({ kind: 'idea', summary: 'x' });
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.error : '', /kind must be one of/);

  const empty = validateFinding({ kind: 'duplicate', summary: '   ' });
  assert.equal(empty.ok, false);
  assert.match(!empty.ok ? empty.error : '', /summary is required/);

  const good = validateFinding({ kind: 'duplicate', summary: '  Same as #41. ', ref: 'issue:41:plan' });
  assert.ok(good.ok);
  assert.deepEqual(good.input, { kind: 'duplicate', ref: 'issue:41', summary: 'Same as #41.' });
});

test('a promoted finding carries its provenance into the job it becomes', () => {
  const request = findingJobRequest({
    id: 'f1',
    agentId: 'a1',
    taskId: 't1',
    originRef: 'pr:142:ci',
    kind: 'out_of_scope',
    ref: 'issue:41',
    summary: 'The retry helper squares the delay instead of doubling it.',
    status: 'open',
    jobId: null,
    createdAt: TAKEN_AT,
    updatedAt: TAKEN_AT,
  });
  assert.match(request.title, /^\[out_of_scope\] issue:41 /);
  // Who saw it and what they were doing at the time — the thing a PR comment
  // could never be trusted to keep attached to the claim.
  assert.match(request.prompt, /pr:142:ci/);
  assert.match(request.prompt, /squares the delay/);
  // And it is a claim, not an instruction: the promoted agent verifies first.
  assert.match(request.prompt, /Verify it before acting on it/);
});

// -- progress notes, as a pure normalisation --------------------------------

test('a progress note is reduced to the one line the fleet card can render', () => {
  const wrapped = normaliseNote('  Reworking the fold\n  so a superseded push   stops poisoning CI  ');
  assert.deepEqual(wrapped, {
    ok: true,
    note: 'Reworking the fold so a superseded push stops poisoning CI',
    trimmed: false,
  });
  // "One line" is a property this establishes rather than one it demands: a note
  // that happens to arrive with a newline in it is a fine note, badly formatted.
  assert.equal((normaliseNote('a\nb') as { note: string }).note, 'a b');
});

test('an over-long note is kept and trimmed, where a malformed finding is refused', () => {
  const long = normaliseNote('x'.repeat(MAX_NOTE_LENGTH + 50)) as { ok: true; note: string; trimmed: boolean };
  assert.equal(long.ok, true);
  assert.equal(long.note.length, MAX_NOTE_LENGTH);
  assert.equal(long.trimmed, true);
  // The asymmetry is deliberate. A finding is testimony an operator acts on, so a
  // malformed one must not land at all; a progress note is a status line whose
  // whole value is being cheap and frequent, and a trimmed one still answers the
  // question a refusal would have left blank.
  assert.equal(validateFinding({ kind: 'duplicate', summary: '' }).ok, false);
});

test('an empty note is the one thing refused — there is nothing to store', () => {
  for (const empty of ['', '   ', '\n', undefined, 42]) {
    const res = normaliseNote(empty);
    assert.equal(res.ok, false, `${JSON.stringify(empty)} is not a note`);
    if (!res.ok) assert.match(res.error, /note is required/);
  }
});

// -- end to end through a built system ---------------------------------------

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-mcp-'));
  return loadConfig({
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
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

/** The input schema a tool advertises to an agent's client on `tools/list`. */
function advertisedSchema(system: System, agent: Agent, name: string): { properties: Record<string, unknown> } {
  const task = system.store.getTask(agent.taskId)!;
  const tool = buildTools({ store: system.store, agents: system.agents }, { agent, task }).find((t) => t.name === name);
  assert.ok(tool, `${name} is built`);
  return tool.inputSchema as { properties: Record<string, unknown> };
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

// -- report_finding, end to end ----------------------------------------------

test('report_finding lands in the store, attributed from the credential', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:142:ci');

  const res = await callTool(system, agent, 'report_finding', {
    kind: 'out_of_scope',
    summary: 'The retry helper squares the delay instead of doubling it.',
    ref: 'issue:41',
  });
  assert.equal(res.isError, false);

  const [finding, ...rest] = system.store.listFindings();
  assert.equal(rest.length, 0);
  // Attribution is the caller's, and it is the *whole* attribution: the tool takes
  // no agent, task or author argument, so this can only ever describe its caller.
  assert.equal(finding!.agentId, agent.id);
  assert.equal(finding!.taskId, agent.taskId);
  assert.equal(finding!.originRef, 'pr:142:ci');
  assert.equal(finding!.kind, 'out_of_scope');
  assert.equal(finding!.ref, 'issue:41');
  assert.equal(finding!.status, 'open');

  const payload = JSON.parse(res.text) as {
    recorded: boolean;
    note: string;
    finding: { id: string };
    _status: Record<string, unknown>;
  };
  assert.equal(payload.recorded, true);
  assert.equal(payload.finding.id, finding!.id);
  // The response says the finding queues nothing, so an agent doesn't report a bug
  // and then assume its fix is now scheduled.
  assert.match(payload.note, /queues no work/);
  assert.equal(payload._status.origin, 'pr:142:ci');
  system.store.close();
});

test('a finding is a write, so it stays structurally attributed — there is no argument to forge one with', async () => {
  const system = build();
  const one = spawnAgent(system, 'pr:142:ci');
  const two = spawnAgent(system, 'issue:12');

  // world_read relaxed the no-cross-origin rule because a read forges nothing.
  // That reasoning does not carry: this write puts words in an agent's mouth in
  // front of an operator, and a finding is read as testimony about work its author
  // actually did. So the schema offers nothing that could name a different agent.
  const schema = advertisedSchema(system, one, 'report_finding');
  assert.deepEqual(Object.keys(schema.properties).sort(), ['kind', 'ref', 'summary']);

  await callTool(system, one, 'report_finding', { kind: 'blocked', summary: 'Upstream typings are wrong.' });
  await callTool(system, two, 'report_finding', { kind: 'duplicate', summary: 'Same as #41.', ref: 'issue:41' });

  const byAgent = new Map(system.store.listFindings().map((f) => [f.agentId, f]));
  assert.equal(byAgent.get(one.id)?.originRef, 'pr:142:ci');
  assert.equal(byAgent.get(two.id)?.originRef, 'issue:12');
  system.store.close();
});

test('a finding queues no work by itself; promotion is the operator’s click', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const agent = spawnAgent(system, 'pr:142:ci');

  await callTool(system, agent, 'report_finding', {
    kind: 'out_of_scope',
    summary: 'The retry helper squares the delay instead of doubling it.',
  });
  // The deliberate half of the design: an agent that could queue jobs could put
  // agents on the fleet (rule 0 dispatches a job ahead of every world-driven
  // rule), so filing one changes nothing about what runs.
  assert.deepEqual(system.store.listQueuedJobs(), []);

  const finding = system.store.listFindings()[0]!;
  const promoted = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/promote` });
  assert.equal(promoted.statusCode, 200);

  const job = system.store.listJobs()[0]!;
  assert.match(job.title, /\[out_of_scope\]/);
  assert.match(job.prompt, /squares the delay/);
  assert.equal(system.store.getFinding(finding.id)?.status, 'promoted');
  assert.equal(system.store.getFinding(finding.id)?.jobId, job.id);

  // And only once: a second promote can't spend a second slot on one finding.
  const again = await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/promote` });
  assert.equal(again.statusCode, 409);
  assert.equal(system.store.listJobs().length, 1);
  await app.close();
  system.store.close();
});

test('a dismissed finding stays dismissed, and a verbatim repeat does not refile it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const agent = spawnAgent(system, 'issue:12');
  const report = (): Promise<{ isError: boolean; text: string }> =>
    callTool(system, agent, 'report_finding', { kind: 'duplicate', summary: 'Same as #41.', ref: 'issue:41' });

  await report();
  const finding = system.store.listFindings()[0]!;
  assert.equal((await app.inject({ method: 'POST', url: `/api/findings/${finding.id}/dismiss` })).statusCode, 200);

  // An agent that repeats itself every turn must not refill the operator's list —
  // and dismissing it has to mean something, so the repeat lands on the same row
  // without reopening it.
  await report();
  assert.equal(system.store.listFindings().length, 1);
  assert.equal(system.store.getFinding(finding.id)?.status, 'dismissed');

  // A *different* summary is a different finding, not a repeat.
  await callTool(system, agent, 'report_finding', { kind: 'duplicate', summary: 'Also overlaps #7.' });
  assert.equal(system.store.listFindings().length, 2);
  await app.close();
  system.store.close();
});

test('a malformed finding is refused with the reason and stores nothing', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');

  const badKind = await callTool(system, agent, 'report_finding', { kind: 'idea', summary: 'Something.' });
  assert.equal(badKind.isError, true);
  assert.match(badKind.text, /kind must be one of/);

  const badRef = await callTool(system, agent, 'report_finding', {
    kind: 'duplicate',
    summary: 'Same as 41.',
    ref: '41',
  });
  assert.equal(badRef.isError, true);
  assert.match(badRef.text, /ambiguous between an issue and a PR/);
  assert.deepEqual(system.store.listFindings(), []);

  // ...and the corrected retry lands, in the same turn.
  const fixed = await callTool(system, agent, 'report_finding', {
    kind: 'duplicate',
    summary: 'Same as #41.',
    ref: 'issue:41',
  });
  assert.equal(fixed.isError, false);
  assert.equal(system.store.listFindings().length, 1);
  system.store.close();
});

test('the cockpit is shipped the findings and a link for the item they name', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const agent = spawnAgent(system, 'issue:12');
  await callTool(system, agent, 'report_finding', { kind: 'duplicate', summary: 'Same as #41.', ref: 'issue:41' });

  const snap = (await (await app.inject({ method: 'GET', url: '/api/state' })).json()) as {
    findings: { ref: string | null; summary: string }[];
    refUrls: Record<string, string>;
  };
  // A finding nobody sees is the PR comment it replaces.
  assert.deepEqual(
    snap.findings.map((f) => f.ref),
    ['issue:41'],
  );
  // Its ref is resolved directly rather than looked up off the world: #41 is a
  // *closed* duplicate here, so it is in no snapshot list. (The `fake` provider
  // resolves nothing, so the key is simply absent rather than wrong.)
  assert.equal('issue:41' in snap.refUrls, false);
  await app.close();
  system.store.close();
});

test('note_progress lands on the agent row and hands back the status envelope', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:142:ci');

  const before = system.store.getAgent(agent.id)!.status;
  const res = await callTool(system, agent, 'note_progress', {
    note: 'Reading how the dispatcher ranks candidates before touching rule 4a',
  });
  assert.equal(res.isError, false);

  const stored = system.store.getAgent(agent.id)!;
  assert.equal(stored.note, 'Reading how the dispatcher ranks candidates before touching rule 4a');
  assert.ok(stored.notedAt, 'the note is dated so a reader can tell how current it is');
  // It says something and changes nothing: not a status transition, not a park.
  assert.equal(stored.status, before);
  assert.equal(stored.waitingReason, null);
  assert.deepEqual(system.store.listOpenEscalations(), []);

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

  // One row, one note. The audit trail of what an agent said, in order, already
  // exists in its transcript — every call is a tool use there — so a second,
  // lossier copy in SQLite would answer nothing. What the transcript can't answer
  // cheaply from a fleet view is "where is this one up to *now*", and that is
  // exactly what is kept.
  const stored = system.store.getAgent(agent.id)!;
  assert.equal(stored.note, 'Running the full suite after the rename');

  // ...and it survives the agent, because a finished agent's last note is the best
  // one-line summary of the run there is.
  system.store.updateAgent(agent.id, { status: 'done', endedAt: new Date().toISOString(), pid: null });
  assert.equal(system.store.getAgent(agent.id)!.note, 'Running the full suite after the rename');
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
  assert.equal(system.store.getAgent(agent.id)!.note?.length, MAX_NOTE_LENGTH);

  // An empty one is the only refusal, and it stores nothing over the good note.
  const empty = await callTool(system, agent, 'note_progress', { note: '   ' });
  assert.equal(empty.isError, true);
  assert.equal(system.store.getAgent(agent.id)!.note?.length, MAX_NOTE_LENGTH);
  system.store.close();
});

test('silence is not "no progress": an agent that never notes leaves the card as it was', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend, errorMirror: () => {} });
  const { app } = await buildApp(system);
  const agent = spawnAgent(system, 'issue:12');

  // A whole run's worth of output and not one call to the tool. The note stays
  // null and nothing stands in for it — no placeholder, no note inferred from the
  // output, no "quiet" marker. Same asymmetry as @@LUBBDUBB_DONE@@ against the
  // result event: a tool an agent forgets to call is silence, and silence must
  // not be read as a statement.
  backend.last().emit('Running tests…\n');
  backend.last().emit('@@LUBBDUBB_DONE@@');
  assert.equal(system.store.getAgent(agent.id)!.status, 'done');

  const snap = (await (await app.inject({ method: 'GET', url: '/api/state' })).json()) as {
    agents: Record<string, unknown>[];
  };
  const shipped = snap.agents.find((a) => a.id === agent.id)!;
  assert.equal(shipped.note, null);
  assert.equal(shipped.notedAt, null);
  // The output that *did* happen is still the fallback the card shows. It reaches
  // the cockpit as a Hub broadcast rather than on the row, so nothing about it
  // changed here — which is the point: the note sits beside the tail, never
  // instead of it, and an agent that skips the tool costs the operator nothing.
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
  // The raw timestamp is shipped and *nothing is derived from it*. This guard is
  // the decision, not decoration: the longest gaps between notes are the long
  // test runs and big refactors — the stretches where an agent is healthiest — so
  // a staleness verdict would punish honest use and quietly turn an optional note
  // into a heartbeat an agent must keep sending. If a derived field ever wants to
  // exist here, this failing is the prompt to re-argue it.
  const derived = Object.keys(shipped).filter((k) => /stale|stuck|idle|silent|heartbeat|alive/i.test(k));
  assert.deepEqual(derived, []);
  // And the fleet keeps working off real liveness signals, not the note's age:
  // the agent is live because its session is, and noting nothing would not have
  // changed that either way.
  assert.equal(shipped.status, system.store.getAgent(agent.id)!.status);
  assert.deepEqual(system.store.listErrors(10), []);
  await app.close();
  system.store.close();
});

test('a note is a write, so it too is attributed structurally — one field, and it is the note', async () => {
  const system = build();
  const one = spawnAgent(system, 'pr:142:ci');
  const two = spawnAgent(system, 'issue:12');

  // Same rule as report_finding, for the same reason: this speaks in an agent's
  // name to an operator. There is no agent, task or origin argument to forge with.
  const schema = advertisedSchema(system, one, 'note_progress');
  assert.deepEqual(Object.keys(schema.properties), ['note']);

  await callTool(system, one, 'note_progress', { note: 'Fixing the CI failure' });
  await callTool(system, two, 'note_progress', { note: 'Reading the issue' });
  assert.equal(system.store.getAgent(one.id)!.note, 'Fixing the CI failure');
  assert.equal(system.store.getAgent(two.id)!.note, 'Reading the issue');
  system.store.close();
});

// -- the permission backstop (issue #130 phase B) ----------------------------

/** Let the queued microtasks (the blocking tool handler filing its escalation) run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** Start a request_permission call without awaiting it, so we can act while it blocks. */
function startPermission(
  system: System,
  agent: Agent,
  input: Record<string, unknown>,
): Promise<{ content: { text: string }[] }> {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  return session!.call('request_permission', { tool_name: 'Bash', input }) as Promise<{ content: { text: string }[] }>;
}

/** The bare verdict JSON a permission call resolves to (never an `_status` envelope). */
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

  // It surfaced as a "Needs you" item carrying the exact command.
  const esc = system.store.listOpenEscalations().find((e) => e.agentId === agent.id);
  assert.ok(esc, 'the blocked call files an escalation');
  assert.ok(esc!.context.permission, 'marked as a permission request');
  assert.match(esc!.prompt, /terraform apply/);
  assert.equal(system.agents.isLive(agent.id), true); // still live, blocked in the tool call

  // Operator allows it: the blocked call resolves with a bare allow verdict.
  assert.equal(system.permissions.decide(esc!.id, true), true);
  const verdict = verdictOf(await pending);
  assert.equal(verdict.behavior, 'allow');
  assert.deepEqual(verdict.updatedInput, { command: 'terraform apply' });
  // And the inbox item is settled — without typing an answer into the session.
  assert.equal(system.store.getEscalation(esc!.id)?.status, 'answered');
  system.store.close();
});

test('Deny returns a structured denial the agent reads, and does not orphan the task', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const pending = startPermission(system, agent, { command: 'rm -rf /' });
  await tick();
  const esc = system.store.listOpenEscalations().find((e) => e.agentId === agent.id)!;

  assert.equal(system.permissions.decide(esc.id, false, 'too destructive'), true);
  const verdict = verdictOf(await pending);
  assert.equal(verdict.behavior, 'deny');
  assert.match(String(verdict.message), /too destructive/);
  // The task is untouched — a denial is the agent's to handle, not a kill.
  assert.equal(system.store.getTask(agent.taskId)?.status, 'running');
  // Deciding twice is a no-op (the second click 409s at the route).
  assert.equal(system.permissions.decide(esc.id, true), false);
  system.store.close();
});

test('killing an agent mid-request resolves its blocked call as a denial (no hung Claude)', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const pending = startPermission(system, agent, { command: 'sleep 999' });
  await tick();
  assert.ok(system.store.listOpenEscalations().some((e) => e.agentId === agent.id));

  system.agents.kill(agent.id); // releases the credential -> denyAll
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
  const esc = system.store.listOpenEscalations().find((e) => e.agentId === agent.id)!;

  // Free text can't be branched on: /answer refuses and points at /permission.
  const answered = await app.inject({
    method: 'POST',
    url: `/api/escalations/${esc.id}/answer`,
    payload: { response: 'sure' },
  });
  assert.equal(answered.statusCode, 409);
  assert.match(answered.json().error, /\/permission/);

  // The permission route settles it and unblocks the agent.
  const decided = await app.inject({
    method: 'POST',
    url: `/api/escalations/${esc.id}/permission`,
    payload: { allow: true },
  });
  assert.equal(decided.statusCode, 200);
  assert.equal(verdictOf(await pending).behavior, 'allow');
  // A second decision has nothing pending to settle.
  const again = await app.inject({
    method: 'POST',
    url: `/api/escalations/${esc.id}/permission`,
    payload: { allow: false },
  });
  assert.equal(again.statusCode, 409);
  await app.close();
  system.store.close();
});

test('with the backstop disabled, the tool denies rather than blocking', async () => {
  const system = build({ mcp: { enabled: true, permissionEscalation: false } });
  const agent = spawnAgent(system, 'issue:12');
  // Resolves immediately (no operator needed) with a deny — no escalation filed.
  const verdict = verdictOf(await startPermission(system, agent, { command: 'anything' }));
  assert.equal(verdict.behavior, 'deny');
  assert.equal(system.store.listOpenEscalations().length, 0);
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
  // With no channel there is no way to note progress, and nothing pretends there
  // was one: the row's note stays null and the card falls back to the tail, which
  // is exactly the pre-tool cockpit.
  assert.equal(system.store.getAgent(agent.id)?.note, null);
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

test('a listening channel is actually threaded onto the launch (--mcp-config + backstop)', async () => {
  // The regression guard for the system.ts wiring: AgentManager mints the config
  // path, but the ArgsBuilder must forward it, or `--mcp-config` (and the backstop
  // that lives on that server) never reach the agent — invisible to every test
  // that drives `mcp.session()` in-process. Exercised in pty mode with a fake PTY.
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ agentMode: 'pty' }), { backend, errorMirror: () => {} });
  assert.equal(await system.mcp.listen(), true);
  try {
    spawnAgent(system, 'issue:12');
    const args = backend.spawned[backend.spawned.length - 1]!.args;
    assert.equal(args.includes('--mcp-config'), true, 'the minted config path is forwarded onto the launch');
    assert.equal(args[args.indexOf('--allowedTools') + 1], ALLOWED_MCP_TOOLS.join(','));
    assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], PERMISSION_PROMPT_TOOL);
  } finally {
    await system.mcp.close();
    system.store.close();
  }
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
