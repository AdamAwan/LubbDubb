import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandTenantKeeper } from '../src/validation/remote/tenants.js';
import type { TenantLaunch } from '../src/types.js';

/*
 * The real runner, against throwaway `node -e` commands rather than any project's script: output teed
 * into a harness-owned file as it is written, the first-line tenant contract, the timeout's kill, and a
 * second keeper — a restarted harness — following a command the first one started.
 *
 * → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs
 */

function node(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}

function scratch(): { root: string; repo: string; done(): void } {
  const base = mkdtempSync(join(tmpdir(), 'lubbdubb-tenant-'));
  return { root: join(base, 'logs'), repo: base, done: () => rmSync(base, { recursive: true, force: true }) };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a tenant command’s output is readable while it runs, stdout and stderr together', async () => {
  const s = scratch();
  try {
    const keeper = new CommandTenantKeeper({ repoRoot: s.repo, logRoot: s.root });
    let launch: TenantLaunch | null = null;
    const running = keeper.reseed(
      {
        environment: 'acceptance',
        command: node(
          "console.log('dropping fixtures'); console.error('a warning'); setTimeout(() => console.log('seeded ' + process.env.LUBBDUBB_TENANT), 1500)",
        ),
        tenant: 'validation-customer-1',
      },
      (l) => {
        launch = l;
      },
    );
    assert.notEqual(launch, null, 'the launch is handed back before the command ends');
    await until(() => keeper.tail('acceptance', launch!).lines.includes('a warning'));
    const midway = keeper.tail('acceptance', launch!);
    assert.ok(midway.lines.includes('dropping fixtures'));
    assert.ok(!midway.lines.includes('seeded validation-customer-1'), 'read before the command finished');
    assert.notEqual(midway.lastOutputAt, null);

    const outcome = await running;
    assert.deepEqual(outcome, { tenant: 'validation-customer-1', detail: null });
    assert.ok(keeper.tail('acceptance', launch!).lines.includes('seeded validation-customer-1'));
  } finally {
    s.done();
  }
});

test('ensureTenant names the tenant on the first line of stdout, and stderr cannot stand in for it', async () => {
  const s = scratch();
  try {
    const keeper = new CommandTenantKeeper({ repoRoot: s.repo, logRoot: s.root });
    const named = await keeper.ensure({
      environment: 'acceptance',
      command: node("console.error('signing in'); console.log('reaper-safe-customer-9'); console.log('done')"),
      tenant: null,
    });
    assert.deepEqual(named, { tenant: 'reaper-safe-customer-9', detail: null });

    const silent = await keeper.ensure({
      environment: 'acceptance',
      command: node("console.error('only on stderr')"),
      tenant: null,
    });
    assert.equal(silent.tenant, null);
    assert.match(silent.detail ?? '', /named no tenant/);

    const failed = await keeper.ensure({
      environment: 'acceptance',
      command: node("console.error('the VPN is down'); process.exit(3)"),
      tenant: null,
    });
    assert.equal(failed.tenant, null);
    assert.match(failed.detail ?? '', /exited 3: the VPN is down/);
  } finally {
    s.done();
  }
});

test('a tenant command past its timeout is killed, and says so', async () => {
  const s = scratch();
  try {
    const keeper = new CommandTenantKeeper({ repoRoot: s.repo, logRoot: s.root, timeoutMs: 500 });
    const started = Date.now();
    const outcome = await keeper.reseed({
      environment: 'acceptance',
      command: node("console.log('waiting on a sign-in'); setInterval(() => {}, 1000)"),
      tenant: 'validation-customer-1',
    });
    assert.match(outcome.detail ?? '', /killed after timeout/);
    assert.ok(Date.now() - started < 8000, 'the kill came from the timeout, not the command ending');
  } finally {
    s.done();
  }
});

test('a restarted harness follows a command the last one started, reading its output and its outcome', async () => {
  const s = scratch();
  try {
    const first = new CommandTenantKeeper({ repoRoot: s.repo, logRoot: s.root });
    let launch: TenantLaunch | null = null;
    const request = {
      environment: 'acceptance',
      command: node("console.error('provisioning'); setTimeout(() => console.log('late-customer-3'), 1500)"),
      tenant: null,
    };
    void first.ensure(request, (l) => {
      launch = l;
    });
    assert.notEqual(launch!.pid, null, 'the runner’s pid is recorded for the next process to find');

    const second = new CommandTenantKeeper({ repoRoot: s.repo, logRoot: s.root, followPollMs: 100 });
    await until(() => second.tail('acceptance', launch!).lines.includes('provisioning'));
    const outcome = await second.follow('ensure', request, launch!);
    assert.deepEqual(outcome, { tenant: 'late-customer-3', detail: null });
  } finally {
    s.done();
  }
});

test('a launch whose runner is gone and left no outcome is followed to nothing', async () => {
  const s = scratch();
  try {
    const keeper = new CommandTenantKeeper({ repoRoot: s.repo, logRoot: s.root, followPollMs: 20 });
    const outcome = await keeper.follow(
      'reseed',
      { environment: 'acceptance', command: 'unused', tenant: 'validation-customer-1' },
      { id: 'never-ran', pid: 2 ** 22 + 7, startedAt: new Date().toISOString() },
    );
    assert.equal(outcome, null);
  } finally {
    s.done();
  }
});
