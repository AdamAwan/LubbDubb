import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_ID, pluginSkills, writePluginBundle, type PluginBundleInput } from '../src/plugin/bundle.js';
import { PluginDesk } from '../src/plugin/desk.js';
import { FakePluginCli } from '../src/plugin/fakePluginCli.js';
import type { ErrorLogEntry, ErrorLogInput } from '../src/types.js';
import { buildSystem } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { PluginInstallPayload, PluginStatusPayload } from '../src/wire.js';
import {
  askPrompt,
  checkPrompt,
  descriptionPrompt,
  discussPrompt,
  ejectPrompt,
  featurePrompt,
  localRunPrompt,
  questionPrompt,
  SKILL_NAMES,
} from '../web/src/cockpit/desktopLink.js';

function input(overrides: Partial<PluginBundleInput> = {}): PluginBundleInput {
  return {
    outDir: mkdtempSync(join(tmpdir(), 'lubbdubb-plugin-')),
    harnessRoot: '/srv/lubbdubb',
    url: 'http://127.0.0.1:4300',
    tokenFile: '/srv/lubbdubb/.lubbdubb/cockpit-token',
    credentialPath: '/home/you/.lubbdubb/desktop.json',
    ...overrides,
  };
}

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

test('the bundle is a one-plugin marketplace carrying the skills, the board, the bridge and the channel', () => {
  const into = input();
  const bundle = writePluginBundle(into);
  const plugin = join(into.outDir, 'lubbdubb');

  assert.deepEqual(read(join(into.outDir, '.claude-plugin', 'marketplace.json')), {
    name: 'lubbdubb',
    owner: { name: 'LubbDubb' },
    plugins: [
      {
        name: 'lubbdubb',
        source: './lubbdubb',
        description: (read(join(plugin, '.claude-plugin', 'plugin.json')) as { description: string }).description,
      },
    ],
  });
  const manifest = read(join(plugin, '.claude-plugin', 'plugin.json')) as {
    name: string;
    version: string;
    userConfig: { url: { default: string }; tokenFile: { default: string } };
  };
  assert.equal(manifest.name, 'lubbdubb');
  assert.equal(manifest.version, bundle.version);
  assert.equal(manifest.userConfig.url.default, 'http://127.0.0.1:4300', 'the board polls this harness');
  assert.equal(manifest.userConfig.tokenFile.default, '/srv/lubbdubb/.lubbdubb/cockpit-token', 'from any folder');

  assert.deepEqual(read(join(plugin, '.mcp.json')), {
    mcpServers: {
      lubbdubb: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/mcp/bridge.mjs', '--desktop'],
        env: { LUBBDUBB_DESKTOP_CREDENTIAL: '/home/you/.lubbdubb/desktop.json' },
      },
    },
  });
  assert.ok(
    existsSync(join(plugin, 'mcp', 'bridge.mjs')),
    'an installed plugin is a copy, so it carries its own bridge',
  );
  assert.ok(existsSync(join(plugin, 'hooks', 'register.tsx')));
  assert.ok(!existsSync(join(plugin, 'tests')), 'the board’s own tests do not ship');

  for (const skill of pluginSkills()) {
    const shipped = readFileSync(join(plugin, 'skills', skill.name, 'SKILL.md'), 'utf8');
    assert.ok(shipped.startsWith(skill.text.trimEnd()), `${skill.name} ships as written`);
    assert.match(shipped, /\/srv\/lubbdubb/, `${skill.name} names LubbDubb’s own checkout`);
    assert.match(shipped, /Managed by LubbDubb/);
  }
});

test('the version moves with what the plugin carries and nothing else', () => {
  const first = writePluginBundle(input()).version;
  assert.equal(writePluginBundle(input()).version, first, 'the same build writes the same version');
  assert.notEqual(writePluginBundle(input({ url: 'http://127.0.0.1:4400' })).version, first);
  const bare = input({ harnessRoot: null });
  writePluginBundle(bare);
  const ask = readFileSync(join(bare.outDir, 'lubbdubb', 'skills', 'ask', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(ask, /Where LubbDubb's own source is/, 'no checkout, no section');
});

test('the cockpit’s skill list is the plugin’s, and every link it opens calls one', () => {
  assert.deepEqual(
    [...SKILL_NAMES],
    pluginSkills().map((s) => s.name),
  );
  const prompts = [
    askPrompt(284),
    checkPrompt(284, 'C'),
    descriptionPrompt(390, 'validate'),
    discussPrompt(284),
    ejectPrompt(412),
    featurePrompt(500),
    localRunPrompt(284),
    questionPrompt(),
  ];
  for (const prompt of prompts) assert.match(prompt, /^\/lubbdubb:[a-z]+ /, `${prompt} is a namespaced skill call`);
});

test('an unchanged build leaves the written plugin alone, and a changed one replaces it', () => {
  const into = input();
  writePluginBundle(into);
  const stray = join(into.outDir, 'lubbdubb', 'stray.txt');
  writeFileSync(stray, 'left by hand');
  writePluginBundle(into);
  assert.ok(existsSync(stray), 'the same version is not rewritten');
  writePluginBundle({ ...into, url: 'http://127.0.0.1:4400' });
  assert.ok(!existsSync(stray), 'a new version is written from scratch');
});

const OLD_BRIDGE = 'lubbdubb:\n  Command: /usr/bin/node\n  Args: /srv/lubbdubb/src/mcp/bridge.mjs --desktop\n';

function desk(cli: FakePluginCli, legacySkillPath = join(mkdtempSync(join(tmpdir(), 'lubbdubb-legacy-')), 'SKILL.md')) {
  const recorded: ErrorLogInput[] = [];
  const errors = { record: (entry: ErrorLogInput) => (recorded.push(entry), entry as unknown as ErrorLogEntry) };
  const where = input();
  const plugin = new PluginDesk({
    cli,
    legacySkillPath,
    errors,
    outDir: where.outDir,
    credentialPath: where.credentialPath,
    harnessRoot: where.harnessRoot,
  });
  const bundle = plugin.publish({ url: where.url, tokenFile: where.tokenFile });
  return { plugin, bundle: bundle!, recorded, legacySkillPath };
}

test('status reads what Claude Code has installed against what this harness wrote', async () => {
  const states: string[] = [];
  for (const installed of [[], [{ id: PLUGIN_ID, version: '1.0.0-old', scope: 'user' }]]) {
    const cli = new FakePluginCli();
    cli.installed = installed;
    states.push((await desk(cli).plugin.status()).state);
  }
  assert.deepEqual(states, ['missing', 'stale']);

  const cli = new FakePluginCli();
  const { plugin, bundle } = desk(cli);
  cli.installed = [{ id: PLUGIN_ID, version: bundle.version, scope: 'user' }];
  assert.equal((await plugin.status()).state, 'current');
  await plugin.status();
  assert.equal(cli.calls.length, 1, 'a second look inside the minute asks Claude Code nothing');

  const down = new FakePluginCli();
  down.refuse.set('plugin list', { code: 1, stdout: '', stderr: 'claude: not logged in' });
  const unknown = await desk(down).plugin.status();
  assert.equal(unknown.state, 'unknown', 'a CLI that cannot answer is not read as missing');
  assert.match(unknown.state === 'unknown' ? unknown.reason : '', /not logged in/);
});

test('install adds the marketplace, installs, and clears only the old skill and bridge LubbDubb wrote', async () => {
  const cli = new FakePluginCli();
  cli.registered = OLD_BRIDGE;
  const legacyDir = join(mkdtempSync(join(tmpdir(), 'lubbdubb-legacy-')), 'lubbdubb');
  mkdirSync(legacyDir);
  const legacySkillPath = join(legacyDir, 'SKILL.md');
  writeFileSync(legacySkillPath, '---\nname: lubbdubb\n---\n<!-- Managed by LubbDubb: ... -->\n');
  const { plugin, bundle } = desk(cli, legacySkillPath);
  assert.equal((await plugin.status()).legacySkill, true);

  const result = await plugin.install();
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  const writes = cli.calls.filter((c) => !(c[0] === 'plugin' && c[1] === 'list') && c[1] !== 'get');
  assert.deepEqual(writes, [
    ['plugin', 'marketplace', 'add', bundle.marketplaceDir, '--scope', 'user'],
    [
      'plugin',
      'install',
      PLUGIN_ID,
      '--scope',
      'user',
      '--json',
      '--config',
      'url=http://127.0.0.1:4300',
      '--config',
      'tokenFile=/srv/lubbdubb/.lubbdubb/cockpit-token',
    ],
    ['mcp', 'remove', '--scope', 'user', 'lubbdubb'],
  ]);
  assert.ok(!existsSync(legacyDir), 'the old skill and its now-empty folder are gone');
  assert.equal(result.status.state, 'missing', 'the answer is read afresh, and the fake installed nothing');
});

test('install updates a plugin that is already there, and leaves what it did not write alone', async () => {
  const cli = new FakePluginCli();
  cli.installed = [{ id: PLUGIN_ID, version: '1.0.0-old', scope: 'user' }];
  cli.registered = 'lubbdubb:\n  Command: /usr/local/bin/someone-elses-server\n';
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-own-'));
  const own = join(dir, 'SKILL.md');
  writeFileSync(own, '---\nname: lubbdubb\n---\nmy own skill\n');
  const { plugin } = desk(cli, own);

  const result = await plugin.install();
  assert.equal(result.ok, true);
  assert.ok(cli.calls.some((c) => c[1] === 'update' && c[2] === PLUGIN_ID));
  assert.ok(!cli.calls.some((c) => c[1] === 'install'));
  assert.ok(!cli.calls.some((c) => c[1] === 'remove'), 'a lubbdubb server that is not the old bridge is kept');
  assert.equal(readFileSync(own, 'utf8'), '---\nname: lubbdubb\n---\nmy own skill\n');
});

test('a refused install stops there, says why, and records it', async () => {
  const cli = new FakePluginCli();
  cli.registered = OLD_BRIDGE;
  cli.refuse.set('plugin install', { code: 1, stdout: '', stderr: 'Plugin "lubbdubb" not found' });
  const { plugin, recorded } = desk(cli);
  const result = await plugin.install();
  assert.equal(result.ok, false);
  assert.ok(recorded.some((e) => /did not finish cleanly/.test(e.message) && /not found/.test(e.detail ?? '')));
  assert.match(result.steps.at(-1)?.detail ?? '', /not found/);
  assert.ok(!cli.calls.some((c) => c[0] === 'mcp'), 'nothing is removed while the plugin is not in place');
});

test('an install that cannot read what is installed does not guess', async () => {
  const cli = new FakePluginCli();
  cli.refuse.set('plugin list', { code: 1, stdout: '', stderr: 'claude: not logged in' });
  const result = await desk(cli).plugin.install();
  assert.equal(result.ok, false);
  assert.ok(!cli.calls.some((c) => c[1] === 'install' || c[1] === 'update'));
});

test('/api/plugin and /api/plugin/install answer through the injected CLI', async () => {
  const cli = new FakePluginCli();
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-plugin-route-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      validation: {
        desktopSkillPath: join(dir, 'skill', 'SKILL.md'),
        desktopCredentialPath: join(dir, 'home', 'desktop.json'),
      } as never,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
      pluginCli: cli,
    },
  );
  const { app } = await buildApp(system);
  try {
    const before = (await (await app.inject({ method: 'GET', url: '/api/plugin' })).json()) as PluginStatusPayload;
    assert.equal(before.state, 'unknown', 'nothing was written, so there is nothing to compare');
    system.plugin.publish({ url: 'http://127.0.0.1:4300', tokenFile: join(dir, 'token') });
    assert.ok(existsSync(join(dir, 'home', 'plugin', 'lubbdubb')), 'written beside the credential, not in your home');
    const missing = (await (await app.inject({ method: 'GET', url: '/api/plugin' })).json()) as PluginStatusPayload;
    assert.equal(missing.state, 'missing');
    const installed = (await (
      await app.inject({ method: 'POST', url: '/api/plugin/install' })
    ).json()) as PluginInstallPayload;
    assert.equal(installed.ok, true);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('only a user-scope install counts, and a second press shares the first', async () => {
  const cli = new FakePluginCli();
  cli.installed = [{ id: PLUGIN_ID, version: '1.0.0-old', scope: 'local' }];
  const { plugin } = desk(cli);
  assert.equal((await plugin.status()).state, 'missing', 'the links open sessions in any folder');

  const [first, second] = await Promise.all([plugin.install(), plugin.install()]);
  assert.equal(first, second);
  assert.equal(cli.calls.filter((c) => c[1] === 'marketplace').length, 1);
  assert.ok(
    cli.calls.some((c) => c[1] === 'install'),
    'installed at user scope rather than updated',
  );
});
