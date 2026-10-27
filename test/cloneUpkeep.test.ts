import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { CloneUpkeepDesk, GitCloneKeeper, type CloneKeeper } from '../src/git/cloneUpkeep.js';
import { runGit } from '../src/git/gitCli.js';
import { boundedFetch } from '../src/git/boundedFetch.js';
import type { Agent } from '../src/types.js';
import { buildSetupReading } from '../src/setup/reading.js';
import type { SetupProbes } from '../src/setup/probes.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { gitRepo, tmpDir } from './support/gitRepo.js';

function packedRepo(packs: number): string {
  const repo = gitRepo('lubbdubb-packs-');
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: repo });
  git(['config', 'gc.auto', '0']);
  for (let i = 0; i < packs; i += 1) {
    writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    git(['add', '.']);
    git(['commit', '-q', '-m', `c${i}`]);
    git(['repack', '-q']);
  }
  return repo;
}

function packDir(repo: string): string {
  return join(repo, '.git', 'objects', 'pack');
}

function packCount(repo: string): number {
  return readdirSync(packDir(repo)).filter((n) => n.endsWith('.pack')).length;
}

function build(repo: string, packLimit = 100) {
  const dir = tmpDir();
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: repo,
    heartbeatIntervalMs: 999_999,
    auth: { enabled: false } as never,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    cloneKeeper: new GitCloneKeeper(repo, packLimit),
    errorMirror: () => {},
  });
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

test('an idle fleet repacks a clone above the pack limit, and says so in the setup reading', async () => {
  const repo = packedRepo(4);
  assert.equal(packCount(repo), 4);
  const system = build(repo, 3);
  await system.harness.runCycle('manual');
  await system.cloneUpkeep!.idle();

  assert.equal(packCount(repo), 1);
  const standing = system.cloneUpkeep!.standing();
  assert.equal(standing?.repack?.ok, true);
  assert.equal(standing?.repack?.packsBefore, 4);
  assert.equal(standing?.packs, 1);
  assert.equal(standing?.partial, null);
  system.store.close();
});

test('a clone at or under the limit is left alone', async () => {
  const repo = packedRepo(2);
  const system = build(repo, 3);
  await system.harness.runCycle('manual');
  await system.cloneUpkeep!.idle();
  assert.equal(packCount(repo), 2);
  assert.equal(system.cloneUpkeep!.standing()?.repack, null);
  system.store.close();
});

test('the pulse clears dead fetches’ .keep and stale tmp_pack files, and leaves live ones', async () => {
  const repo = packedRepo(1);
  const dir = packDir(repo);
  const pack = readdirSync(dir)
    .find((n) => n.endsWith('.pack'))!
    .replace(/\.pack$/, '');
  const deadKeep = join(dir, `${pack}.keep`);
  writeFileSync(deadKeep, `fetch-pack ${deadPid()} on ${hostname()}\n`);
  const liveKeep = join(dir, 'pack-live.keep');
  writeFileSync(liveKeep, `fetch-pack ${process.pid} on ${hostname()}\n`);
  const manualKeep = join(dir, 'pack-manual.keep');
  writeFileSync(manualKeep, '');
  const stale = join(dir, 'tmp_pack_stale');
  writeFileSync(stale, 'x');
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(stale, old, old);
  const fresh = join(dir, 'tmp_pack_fresh');
  writeFileSync(fresh, 'x');

  const system = build(repo);
  await system.harness.runCycle('manual');

  assert.equal(existsSync(deadKeep), false, 'a .keep naming a dead process is an orphan');
  assert.equal(existsSync(liveKeep), true, 'a .keep naming a live process is a fetch in flight');
  assert.equal(existsSync(manualKeep), true, 'a .keep git did not write is somebody’s decision');
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true, 'a tmp_pack written recently may belong to a running fetch');
  assert.ok(system.store.errors.listErrors().some((e) => /1 stale \.keep and 1 abandoned tmp_pack/.test(e.message)));
  system.store.close();
});

test('a git reaped at its deadline has what it left in the pack directory removed, and the kill recorded', async () => {
  const repo = packedRepo(1);
  const dir = packDir(repo);
  const system = build(repo);
  const left = join(dir, 'tmp_pack_reaped');
  const hung = runGit(repo, ['hash-object', '--stdin'], { timeoutMs: 300 });
  writeFileSync(left, 'x');
  await assert.rejects(hung, /did not exit within 300ms/);
  await new Promise((settled) => setTimeout(settled, 6_000));

  assert.equal(existsSync(left), false, 'written while the reaped git ran, and not growing since');
  await system.harness.runCycle('manual');
  const kill = system.store.errors.listErrors().find((e) => /git hash-object --stdin was killed/.test(e.message));
  assert.ok(kill, 'the reap reaches the error log');
  assert.match(kill.detail ?? '', /tmp_pack_reaped/);
  system.store.close();
});

function fakeKeeper(packs: number): CloneKeeper & { repacks: number } {
  return {
    gitDir: '/repo/.git',
    packLimit: 10,
    repacks: 0,
    read: () => ({ packs, bytes: 0, promisorPacks: 0 }),
    partialFilter: async () => null,
    clearOrphans: async () => ({ keeps: [], tmpFiles: [] }),
    async repack() {
      this.repacks += 1;
    },
  };
}

test('a fleet with an agent running does not repack', async () => {
  const keeper = fakeKeeper(50);
  const desk = new CloneUpkeepDesk({ keeper, errors: { record: () => ({}) as never } });
  await desk.run({ agents: [{ status: 'running' } as Agent] });
  await desk.idle();
  assert.equal(keeper.repacks, 0);
  assert.equal(desk.standing()?.packs, 50);
});

test('a partial clone is read as one and recorded once', async () => {
  const keeper = { ...fakeKeeper(1), read: () => ({ packs: 1, bytes: 0, promisorPacks: 1 }) };
  keeper.partialFilter = async () => 'blob:none';
  const recorded: string[] = [];
  let now = 0;
  const desk = new CloneUpkeepDesk({
    keeper,
    errors: { record: (e) => (recorded.push(e.message), {}) as never },
    now: () => now,
  });
  await desk.run({ agents: [] });
  now += 120_000;
  await desk.run({ agents: [] });
  assert.deepEqual(desk.standing()?.partial, { filter: 'blob:none' });
  assert.equal(recorded.filter((m) => /partial clone/.test(m)).length, 1);
});

test('the setup reading warns on a partial clone and offers the conversion, and is silent before the first read', async () => {
  const repo = packedRepo(1);
  const system = build(repo);
  const reading = (clone: Parameters<typeof buildSetupReading>[0]['clone']) =>
    buildSetupReading({
      config: system.config,
      store: system.store,
      probes: fakeProbes,
      configFile: '/nowhere/lubbdubb.config.json',
      pending: [],
      prompts: defaultPromptTemplates(),
      clone,
    });
  const unread = await reading(null);
  assert.equal(unread.checks.find((c) => c.id === 'clone')?.verdict, 'unknown');

  const standing = {
    gitDir: join(repo, '.git'),
    packs: 7200,
    bytes: 234 * 1024 ** 3,
    packLimit: 100,
    partial: { filter: 'blob:none' },
    readAt: '2026-10-27T00:00:00.000Z',
    repack: null,
    repacking: false,
  };
  const partial = (await reading(standing)).checks.find((c) => c.id === 'clone');
  assert.equal(partial?.verdict, 'warn');
  assert.match(partial?.detail ?? '', /partial clone \(blob:none\) — 7200 packs, 234\.0 GB/);
  assert.equal(partial?.fix?.kind, 'shell');
  assert.match(partial?.fix?.kind === 'shell' ? partial.fix.command : '', /fetch --refetch origin/);

  const full = (await reading({ ...standing, packs: 3, bytes: 0, partial: null })).checks.find((c) => c.id === 'clone');
  assert.equal(full?.verdict, 'ok');
  system.store.close();
});

const fakeProbes: SetupProbes = {
  originUrl: () => Promise.resolve(null),
  isRepo: () => Promise.resolve(true),
  gitEmail: () => Promise.resolve(null),
  commitFor: () => Promise.resolve(null),
  remoteHead: () => Promise.resolve(null),
  agentVersion: () => Promise.resolve(null),
  viewerLogin: () => Promise.resolve(null),
  installRoot: () => null,
  azSignedIn: () => Promise.resolve(false),
  env: () => undefined,
};

test('a fetch running past its wait is not waited for again', async () => {
  const alive = setInterval(() => {}, 1_000);
  let release = (): void => {};
  let started = 0;
  const fetch = boundedFetch(
    () => {
      started += 1;
      return new Promise<void>((settled) => (release = settled));
    },
    { waitMs: 50, errors: { record: () => ({}) as never }, what: 'test' },
  )!;
  await fetch();
  const before = Date.now();
  await fetch();
  assert.ok(Date.now() - before < 40, 'the second call returns at once');
  assert.equal(started, 1);
  release();
  await new Promise((settled) => setImmediate(settled));
  await fetch();
  assert.equal(started, 2, 'once the overrun settles, the next call fetches');
  release();
  clearInterval(alive);
});
