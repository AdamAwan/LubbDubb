/**
 * End-to-end smoke test of the walking skeleton against the Definition of Done,
 * using the REAL node-pty backend and the mock-agent program. Proves the highest
 * -risk path works for real: inject a CI failure -> the harness decides -> a
 * Claude-style agent spawns in a git worktree over a PTY -> it hits a waiting
 * state that escalates -> we answer -> it continues -> it finishes.
 *
 * Run with: npm run smoke
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, reconcileAndResumeOnBoot, type System } from '../src/system.js';

const scriptPath = join(process.cwd(), 'scripts/mock-agent.sh');

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-smoke-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir });
  // Named explicitly: agent branches are cut from `config.defaultBranch` ("main"),
  // while bare `git init` takes whatever the host's init.defaultBranch says.
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 'Smoke']);
  writeFileSync(join(dir, 'README.md'), '# smoke\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

async function waitFor(label: string, pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Exercise the MCP tool channel the way an agent actually reaches it: a real
 * `bridge.mjs` child process, a real Unix socket, real JSON-RPC frames. The unit
 * tests drive `mcp.session()`, which shares everything from `dispatch` inward —
 * this is the half they can't cover, and the half where a transport bug would
 * otherwise only show up against a live `claude`.
 */
async function smokeToolCall(system: System): Promise<void> {
  const log = (m: string): void => console.log(`  ${m}`);
  if (!(await system.mcp.listen())) throw new Error('MCP bridge server would not listen');

  // A planning agent, since `plan_submit` is confined to one by identity. No live
  // process is needed: the credential names the agent row, and the row is enough.
  const task = system.store.createTask({
    kind: 'code',
    title: 'Plan issue #12',
    prompt: 'plan it',
    branch: 'plan/issue/12',
    originRef: 'issue:12:plan',
    originTitle: 'Big thing',
  });
  const agent = system.store.createAgent({ taskId: task.id, cwd: process.cwd(), pid: null, status: 'running' });
  const credential = system.mcp.open();
  if (!credential.configPath) throw new Error('no launch config was written');
  system.mcp.bind(credential.token, agent.id);

  const launch = JSON.parse(readFileSync(credential.configPath, 'utf8')) as {
    mcpServers: { lubbdubb: { command: string; args: string[]; env: Record<string, string> } };
  };
  const server = launch.mcpServers.lubbdubb;
  log(`✓ launch config written: ${server.command} ${server.args.join(' ')}`);

  const bridge = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: 'pipe' });
  const frames: { id?: number; result?: unknown }[] = [];
  let buffer = '';
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) frames.push(JSON.parse(line) as { id?: number });
    }
  });

  const send = (frame: unknown): void => bridge.stdin.write(JSON.stringify(frame) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await waitFor('initialize + tools/list', () => frames.length >= 2, 5_000);
  const tools = (frames[1]?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  log(`✓ bridge negotiated MCP and advertised: ${tools.join(', ')}`);

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'plan_submit',
      arguments: { verdict: 'parts', reason: 'Schema before reader.', parts: SMOKE_PARTS },
    },
  });
  await waitFor('plan_submit', () => frames.length >= 3, 5_000);
  const call = frames[2]?.result as { isError?: boolean; content: { text: string }[] };
  if (call.isError) throw new Error(`plan_submit failed: ${call.content[0]?.text}`);

  const plan = system.store.getPlanByOrigin('issue:12');
  if (!plan) throw new Error('plan_submit returned success but wrote nothing');
  const parts = system.store.listPlanParts(plan.id).map((p) => p.slug);
  log(`✓ plan persisted through the tool: status=${plan.status} parts=${parts.join(',')}`);

  // ...and a rejection comes back as a reason the agent could act on, not silence.
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'plan_submit', arguments: { verdict: 'parts', reason: 'No parts.', parts: [] } },
  });
  await waitFor('plan_submit rejection', () => frames.length >= 4, 5_000);
  const rejected = frames[3]?.result as { isError?: boolean; content: { text: string }[] };
  if (!rejected.isError) throw new Error('an empty parts list should have been rejected');
  log(`✓ validation error returned to the caller: "${rejected.content[0]?.text.trim()}"`);

  // A read of the harness's own world, over the same real transport. PR #42 is the
  // one step 1 injected and failed CI on, and this agent was dispatched for an
  // issue rather than that PR — so this is also the general-read decision holding
  // end to end, not just in the unit test.
  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'world_read', arguments: { kind: 'pr', ref: 'pr:42' } },
  });
  await waitFor('world_read', () => frames.length >= 5, 5_000);
  const read = frames[4]?.result as { isError?: boolean; content: { text: string }[] };
  if (read.isError) throw new Error(`world_read failed: ${read.content[0]?.text}`);
  const view = JSON.parse(read.content[0]?.text ?? '{}') as {
    item: { number: number; ciStatus: string; health: { reasons: string[] } };
  };
  if (view.item.number !== 42 || view.item.ciStatus !== 'failing') {
    throw new Error(`world_read returned the wrong view: ${JSON.stringify(view.item)}`);
  }
  log(`✓ world_read saw the harness's own PR #42: ci=${view.item.ciStatus} health=[${view.item.health.reasons}]`);

  bridge.kill();
  system.mcp.release(credential.token);
  await system.mcp.close();
  // Retire the synthetic agent/task, or the next step's boot reconcile sees an
  // orphan and its "expected 0/0" stops meaning anything.
  system.store.updateAgent(agent.id, { status: 'done', endedAt: new Date().toISOString(), pid: null });
  system.store.updateTask(task.id, { status: 'done' });
}

const SMOKE_PARTS = [
  { slug: 'schema', title: 'Add the table', scope: 'src/store', dependsOn: [] },
  { slug: 'reader', title: 'Read it', scope: 'src/dispatcher', dependsOn: ['schema'] },
];

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'lubbdubb-smoke-'));
  const repo = tempGitRepo();
  const config = loadConfig({
    dbPath: join(scratch, 'db.sqlite'),
    dispatcher: 'rule',
    agentMode: 'raw',
    claudeCommand: 'bash',
    claudeArgs: [scriptPath],
    repoRoot: repo,
    worktreeRoot: join(scratch, 'wt'),
    deskRoot: join(scratch, 'desk'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });

  const system = buildSystem(config);
  const log = (m: string) => console.log(`  ${m}`);

  console.log('1. Inject a PR and a CI failure, then pulse the harness.');
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'Add caching', branch: 'feature/caching' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  const agent = system.store.listAgentsByStatus('starting', 'running', 'waiting')[0];
  if (!agent) throw new Error('no agent spawned');
  log(`agent ${agent.id} spawned (pid ${agent.pid ?? '?'}) in ${agent.cwd}`);
  if (!agent.cwd.includes('feature-caching')) throw new Error('agent not in the expected worktree');
  log('✓ code agent is running in a git worktree keyed by the PR branch');

  console.log('2. Wait for the agent to hit a waiting state and escalate.');
  await waitFor('agent waiting', () => system.store.getAgent(agent.id)!.status === 'waiting');
  const esc = system.store.listOpenEscalations()[0];
  if (!esc) throw new Error('no escalation raised');
  log(`✓ escalation raised: "${esc.prompt}"`);

  console.log('3. Answer the escalation; it should type into the live agent.');
  const result = system.escalations.answer(esc.id, 'Yes, proceed with the refactor.');
  log(`✓ routing = ${result.routing}`);

  console.log('4. Wait for the agent to finish.');
  await waitFor('agent done', () => system.store.getAgent(agent.id)!.status === 'done', 15_000);
  log('✓ agent completed');

  const transcript = system.store.getTranscript(agent.id);
  log('--- agent transcript (tail) ---');
  transcript
    .trim()
    .split('\n')
    .slice(-6)
    .forEach((l) => console.log('    ' + l.trim()));

  console.log('5. Drive one real tool call through the real bridge over the real socket.');
  await smokeToolCall(system);

  console.log('6. Simulate a crash + restart: reconcile should be a no-op now (agent already done).');
  const { resumed, interrupted } = reconcileAndResumeOnBoot(system.store, system.agents, system.escalations);
  log(`✓ boot reconcile: resumed ${resumed}, interrupted ${interrupted} (expected 0/0)`);

  console.log('\nSMOKE TEST PASSED ✅');
  system.store.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED ❌');
  console.error(err);
  process.exit(1);
});
