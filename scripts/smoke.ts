/**
 * End-to-end smoke test of the walking skeleton against the Definition of Done,
 * using the REAL node-pty backend and the mock-agent program. Proves the highest
 * -risk path works for real: inject a CI failure -> the harness decides -> a
 * Claude-style agent spawns in a git worktree over a PTY -> it hits a waiting
 * state that escalates -> we answer -> it continues -> it finishes.
 *
 * Run with: npm run smoke
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, reconcileOnBoot } from '../src/system.js';

const scriptPath = join(process.cwd(), 'scripts/mock-agent.sh');

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-smoke-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
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

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'lubbdubb-smoke-'));
  const repo = tempGitRepo();
  const config = loadConfig({
    dbPath: join(scratch, 'db.sqlite'),
    dispatcher: 'rule',
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
  transcript.trim().split('\n').slice(-6).forEach((l) => console.log('    ' + l.trim()));

  console.log('5. Simulate a crash + restart: reconcile should be a no-op now (agent already done).');
  const reconciled = reconcileOnBoot(system.store);
  log(`✓ reconciled ${reconciled} orphaned agent(s) (expected 0)`);

  console.log('\nSMOKE TEST PASSED ✅');
  system.store.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED ❌');
  console.error(err);
  process.exit(1);
});
