import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';
import { gitRepo } from './support/gitRepo.js';
import { Store } from '../src/store/store.js';
import { LocalRunner } from '../src/localRun/runner.js';
import { localRunRef } from '../src/localRun/ref.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { AgentSession, AgentSessionSpec, AgentSessionStatus } from '../src/agents/session.js';
import type { PlanPart } from '../src/types.js';

/**
 * The local run: the machine's one dev environment, and the process holding it up.
 *
 * Three properties carry the design, and each has a plausible twin that would be
 * wrong in a way nothing else would catch:
 *
 * 1. **One at a time, enforced by the store.** A runner that checked before it
 *    wrote would leave two servers on one port with the cockpit drawing one.
 * 2. **The reap goes before the kill.** Descendants resolve through the root pid,
 *    and the descendant here *is* the dev server — so reaping after the process
 *    dies finds nothing and leaves the port held and the checkout unremovable.
 * 3. **The turn ending is the environment being up, not the run being over.** The
 *    session is kept alive deliberately; treating `done` as terminal would kill the
 *    thing the run exists to hold.
 */

/** A session that starts nothing, and records what was done to it in what order. */
class FakeSession extends EventEmitter implements AgentSession {
  status: AgentSessionStatus = 'starting';
  pid: number | null = 4242;
  readonly log: string[] = [];
  readonly sent: string[] = [];
  constructor(readonly spec: AgentSessionSpec) {
    super();
  }
  start(): void {
    this.log.push('start');
    this.status = 'running';
  }
  send(text: string): void {
    this.sent.push(text);
  }
  sendRaw(): void {}
  kill(): void {
    this.log.push('kill');
    this.status = 'killed';
  }
}

interface Harness {
  store: Store;
  runner: LocalRunner;
  worktrees: FakeWorktreeManager;
  sessions: FakeSession[];
  /** Every pid handed to the reaper, in order, interleaved with kills via each session's log. */
  reaped: number[];
}

function build(over: { instruction?: string; url?: string; ref?: string | null } = {}): Harness {
  const store = new Store(':memory:');
  const worktrees = new FakeWorktreeManager();
  const sessions: FakeSession[] = [];
  const reaped: number[] = [];
  const runner = new LocalRunner({
    store,
    worktrees,
    sessions: (spec) => {
      const session = new FakeSession(spec);
      sessions.push(session);
      return session;
    },
    policy: () => ({ instruction: over.instruction ?? 'Run the dev server.', url: over.url ?? '' }),
    claudeCommand: 'claude',
    claudeArgs: [],
    permissionMode: 'acceptEdits',
    defaultBranch: 'main',
    refFor: () => over.ref ?? null,
    reap: (pid) => {
      reaped.push(pid);
      // Recorded on the session too, so the *ordering* against `kill` is assertable
      // rather than merely the fact that both happened.
      for (const s of sessions) if (s.pid === pid) s.log.push('reap');
    },
    errors: {
      record: (input) => ({ ...input, id: 'e1', detail: input.detail ?? null, createdAt: '2026-08-20T00:00:00.000Z' }),
    },
  });
  return { store, runner, worktrees, sessions, reaped };
}

test('a start with nothing configured refuses, and names the field that fixes it', async () => {
  const { runner, store } = build({ instruction: '   ' });
  const result = await runner.start('issue:284');
  assert.equal(result.ok, false);
  // The operator reading this is the one who can fix it, and it is a config field
  // precisely so they can — without a restart.
  assert.match(result.ok ? '' : result.error, /localRun\.instruction/);
  assert.equal(store.currentLocalRun(), null, 'a refusal records nothing at all');
  store.close();
});

test('a start prepares the checkout, writes the run, and tells the session what to do', async () => {
  const { runner, store, worktrees, sessions } = build({ ref: 'issue/284/viewer', url: 'http://localhost:4200' });
  const result = await runner.start('issue:284');
  assert.ok(result.ok, result.ok ? '' : result.error);

  // The directory came from the manager rather than being chosen here: that class is
  // the only thing that hands one out.
  assert.deepEqual(worktrees.previewed, ['issue/284/viewer']);
  const run = store.liveLocalRun();
  assert.equal(run?.originRef, 'issue:284');
  assert.equal(run?.ref, 'issue/284/viewer');
  assert.equal(run?.pid, 4242);
  assert.equal(run?.status, 'starting');
  // The URL is frozen as configured at the start, so a later config edit does not
  // rewrite what this run reported.
  assert.equal(run?.url, 'http://localhost:4200');

  // The operator's instruction, with the harness's rules **appended** rather than
  // interpolated — an instruction that had to remember them would be one edit from
  // dropping one, and each is a way for the run to break looking like something else.
  const sent = sessions[0]?.sent[0] ?? '';
  assert.match(sent, /^Run the dev server\./);
  assert.match(sent, /background/);
  assert.match(sent, /Do not commit/);
  store.close();
});

test('a goal whose parts have all merged runs from the integration branch', async () => {
  const { runner, store, worktrees } = build({ ref: null });
  await runner.start('issue:284');
  assert.deepEqual(worktrees.previewed, ['main']);
  store.close();
});

test('the turn ending means the environment is up, not that the run is over', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  assert.equal(store.liveLocalRun()?.status, 'starting');

  sessions[0]?.emit('done');
  assert.equal(store.liveLocalRun()?.status, 'running');
  // Nothing was killed. The session is held open on purpose: the dev server is its
  // child, and a runner that treated `done` as terminal would take it down at the
  // moment it came up.
  assert.deepEqual(sessions[0]?.log, ['start']);
  store.close();
});

test('a session that fails settles the run with what it last said', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  sessions[0]?.emit('output', 'EADDRINUSE: port 4200 is already taken\n');
  sessions[0]?.emit('failed');

  assert.equal(store.liveLocalRun(), null);
  const last = store.currentLocalRun();
  assert.equal(last?.status, 'failed');
  // The reason is the case an operator actually hits, so it is kept on the row —
  // a panel that said `failed` with nowhere to look sends them back to a terminal.
  assert.match(last?.note ?? '', /EADDRINUSE/);
  store.close();
});

test('stopping reaps the subtree before it signals the child', async () => {
  const { runner, store, sessions, reaped } = build();
  await runner.start('issue:284');
  runner.stop();

  assert.deepEqual(reaped, [4242]);
  // The order is the assertion, not the pair. Descendants are resolved through the
  // root pid, so a reap after the process dies finds nothing — and on Windows the
  // surviving shell then makes the checkout unremovable for good.
  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.equal(store.liveLocalRun(), null);
  assert.equal(store.currentLocalRun()?.status, 'stopped');
  store.close();
});

test('starting another goal stops the first — one environment, one run', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  const first = store.liveLocalRun();
  await runner.start('issue:285');

  const second = store.liveLocalRun();
  assert.equal(second?.originRef, 'issue:285');
  assert.notEqual(second?.id, first?.id);
  // The old session is gone, subtree first.
  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.equal(sessions.length, 2);
  store.close();
});

test('a restart settles the rows it cannot vouch for', () => {
  const store = new Store(':memory:');
  store.beginLocalRun({ originRef: 'issue:284', ref: 'main', dir: '/tmp/x', url: null });
  assert.equal(store.liveLocalRun()?.originRef, 'issue:284');

  // A row saying `running` after a restart describes a process this harness never
  // spawned — the pid belongs to something dead, or to whatever has since been given
  // that number. Settled rather than trusted.
  assert.equal(store.endStaleLocalRuns('the harness restarted'), 1);
  assert.equal(store.liveLocalRun(), null);
  assert.match(store.currentLocalRun()?.note ?? '', /restarted/);
  store.close();
});

// -- which ref a goal runs from ----------------------------------------------

function part(over: Partial<PlanPart> & { slug: string; seq: number }): PlanPart {
  return {
    id: `plan:${over.slug}`,
    planId: 'plan',
    title: over.slug,
    scope: '',
    touches: [],
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'pending',
    blockedReason: null,
    taskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('the ref is the first unmerged part with a branch, in plan order', () => {
  // Plan order rather than newest: a stack's later part is built on its earlier one,
  // so the first unmerged one is the furthest back anybody would want to look.
  assert.equal(
    localRunRef([part({ slug: 'b', seq: 2, branch: 'issue/1/b' }), part({ slug: 'a', seq: 1, branch: 'issue/1/a' })]),
    'issue/1/a',
  );
});

test('merged, retired and concluded parts are skipped, and all of them means null', () => {
  // Merged code is in the integration branch already, and a retired or concluded
  // part can still carry a branch from before it got there — which is exactly the
  // stale checkout this avoids.
  assert.equal(
    localRunRef([
      part({ slug: 'a', seq: 1, branch: 'issue/1/a', status: 'merged' }),
      part({ slug: 'b', seq: 2, branch: 'issue/1/b', status: 'retired' }),
      part({ slug: 'c', seq: 3, branch: 'issue/1/c', status: 'concluded' }),
      part({ slug: 'd', seq: 4, branch: 'issue/1/d', status: 'in_review' }),
    ]),
    'issue/1/d',
  );
  assert.equal(localRunRef([part({ slug: 'a', seq: 1, branch: 'issue/1/a', status: 'merged' })]), null);
  // A part nothing has dispatched has no branch to run, which is not the same as
  // having one — null sends the caller to the integration branch.
  assert.equal(localRunRef([part({ slug: 'a', seq: 1 })]), null);
});

// -- the checkout the run uses -----------------------------------------------

test('the preview checkout changes ref without losing what makes it warm', async () => {
  const repo = gitRepo('lubbdubb-preview-');
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: repo });
  writeFileSync(join(repo, '.gitignore'), 'deps/\n');
  writeFileSync(join(repo, 'app.txt'), 'first\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'first']);
  git(['branch', 'feature']);
  writeFileSync(join(repo, 'app.txt'), 'second\n');
  git(['commit', '-q', '-am', 'second']);

  const wt = new WorktreeManager(repo, join(repo, '.wt'), { size: 2, held: () => false }, join(repo, '.preview'));
  const dir = await wt.ensurePreview('main');
  // The dependency tree in miniature: ignored, and the only thing the warm-versus-
  // wiped distinction can be observed through.
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), 'a cold install is the thing this avoids\n');
  // Junk a previous run left behind, tracked-file edits included.
  writeFileSync(join(dir, 'app.txt'), 'scribbled over\n');
  writeFileSync(join(dir, 'scratch.txt'), 'left over\n');

  const again = await wt.ensurePreview('feature');
  assert.equal(again, dir, 'one directory, whatever ref it is pointed at');
  // The whole point: `clean -fd` without `-x`, so dependencies survive a swap
  // between goals and the next start is warm rather than a cold install.
  assert.ok(existsSync(join(dir, 'deps', 'installed.txt')), 'ignored files survive the change of ref');
  // ...and everything else does not: tracked edits reset, untracked junk gone.
  // Trimmed: this machine checks out CRLF (`core.autocrlf`), and the subject here
  // is warm-versus-wiped, not line endings.
  assert.equal(readFileSync(join(dir, 'app.txt'), 'utf8').trim(), 'first');
  assert.ok(!existsSync(join(dir, 'scratch.txt')), 'the last run drops its leftovers');
});

test('an unresolvable ref leaves the checkout exactly as it was', async () => {
  const repo = gitRepo('lubbdubb-preview-bad-');
  const wt = new WorktreeManager(repo, join(repo, '.wt'), { size: 2, held: () => false }, join(repo, '.preview'));
  const dir = await wt.ensurePreview('main');
  writeFileSync(join(dir, 'kept.txt'), 'still here\n');

  // Resolved before the directory is touched, `switchOnto`'s rule: silently running
  // a different goal's code than the one asked for is the failure this refuses.
  await assert.rejects(() => wt.ensurePreview('no/such/branch'), /resolves to no commit/);
  assert.ok(existsSync(join(dir, 'kept.txt')), 'nothing was reset or cleaned on the way to the refusal');
});
