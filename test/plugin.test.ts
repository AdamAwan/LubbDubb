import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_ID,
  PLUGIN_ID,
  pluginSkills,
  writePluginBundle,
  type PluginBundleInput,
} from '../src/plugin/bundle.js';
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

test('the bundle’s lubbdubb plugin carries the skills, the board, the bridge and the channel', () => {
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
      {
        name: 'pr-assistant',
        source: './pr-assistant',
        description: (
          read(join(into.outDir, 'pr-assistant', '.claude-plugin', 'plugin.json')) as { description: string }
        ).description,
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
  assert.ok(
    existsSync(join(plugin, 'skills', 'pr', 'map', 'build.mjs')),
    'a skill ships the files beside its SKILL.md',
  );

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

function assistantSource(description = 'Follows a walkthrough.'): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pr-assistant-'));
  const write = (path: string, text: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write('.claude-plugin/plugin.json', JSON.stringify({ name: 'pr-assistant', version: '0.0.0', description }));
  write('hooks/hooks.json', '{}');
  write('hooks/register.tsx', 'export default {};');
  write('types/index.d.ts', 'export {};');
  write('tests/walk.test.ts', 'it ships nowhere');
  return dir;
}

test('the bundle carries the PR assistant as a second plugin, at the one version', () => {
  const source = assistantSource();
  const into = input({ assistantSourceDir: source });
  const bundle = writePluginBundle(into);
  const assistant = join(into.outDir, 'pr-assistant');

  const catalogue = read(join(into.outDir, '.claude-plugin', 'marketplace.json')) as {
    plugins: { name: string; source: string; description: string }[];
  };
  assert.deepEqual(
    catalogue.plugins.map((p) => [p.name, p.source]),
    [
      ['lubbdubb', './lubbdubb'],
      ['pr-assistant', './pr-assistant'],
    ],
  );
  assert.equal(catalogue.plugins[1]?.description, 'Follows a walkthrough.');
  const manifest = read(join(assistant, '.claude-plugin', 'plugin.json')) as { name: string; version: string };
  assert.equal(manifest.name, 'pr-assistant');
  assert.equal(manifest.version, bundle.version, 'one digest over both plugins versions both');
  assert.match(bundle.version, /^1\.0\.0-[0-9a-f]{12}$/);
  assert.ok(existsSync(join(assistant, 'hooks', 'register.tsx')));
  assert.ok(existsSync(join(assistant, 'types', 'index.d.ts')));
  assert.ok(!existsSync(join(assistant, 'tests')), 'the panel’s own tests do not ship');
  assert.ok(!existsSync(join(assistant, '.mcp.json')), 'a mod only: no server of its own');
  assert.ok(!existsSync(join(assistant, 'skills')));

  const stray = join(assistant, 'stray.txt');
  writeFileSync(stray, 'left by hand');
  assert.equal(writePluginBundle(into).version, bundle.version);
  assert.ok(existsSync(stray), 'the same version is not rewritten');
  writeFileSync(join(source, 'hooks', 'register.tsx'), 'export default { changed: true };');
  assert.notEqual(writePluginBundle(into).version, bundle.version, 'the assistant moving moves the version');
  assert.ok(!existsSync(stray), 'a new version is written from scratch');
});

test('a boot that finds only one plugin at the version rewrites both', () => {
  const into = input({ assistantSourceDir: assistantSource() });
  const { version } = writePluginBundle(into);
  const manifestPath = join(into.outDir, 'pr-assistant', '.claude-plugin', 'plugin.json');
  writeFileSync(manifestPath, JSON.stringify({ name: 'pr-assistant', version: '1.0.0-old' }));
  writePluginBundle(into);
  assert.equal((read(manifestPath) as { version: string }).version, version);
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

const both = (version: string) => [
  { id: PLUGIN_ID, version, scope: 'user' },
  { id: ASSISTANT_ID, version, scope: 'user' },
];

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
  for (const installed of [[], both('1.0.0-old')]) {
    const cli = new FakePluginCli();
    cli.installed = installed;
    states.push((await desk(cli).plugin.status()).state);
  }
  assert.deepEqual(states, ['missing', 'stale']);

  const cli = new FakePluginCli();
  const { plugin, bundle } = desk(cli);
  cli.installed = both(bundle.version);
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
    ['plugin', 'install', ASSISTANT_ID, '--scope', 'user', '--json'],
    ['mcp', 'remove', '--scope', 'user', 'lubbdubb'],
  ]);
  assert.ok(!existsSync(legacyDir), 'the old skill and its now-empty folder are gone');
  assert.equal(result.status.state, 'missing', 'the answer is read afresh, and the fake installed nothing');
});

test('install updates a plugin that is already there, and leaves what it did not write alone', async () => {
  const cli = new FakePluginCli();
  cli.installed = both('1.0.0-old');
  cli.registered = 'lubbdubb:\n  Command: /usr/local/bin/someone-elses-server\n';
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-own-'));
  const own = join(dir, 'SKILL.md');
  writeFileSync(own, '---\nname: lubbdubb\n---\nmy own skill\n');
  const { plugin } = desk(cli, own);

  const result = await plugin.install();
  assert.equal(result.ok, true);
  assert.ok(cli.calls.some((c) => c[1] === 'update' && c[2] === PLUGIN_ID));
  assert.ok(cli.calls.some((c) => c[1] === 'update' && c[2] === ASSISTANT_ID));
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

test('a boot refresh updates only a plugin somebody already installed', async () => {
  const stale = new FakePluginCli();
  stale.installed = both('1.0.0-old');
  const updated = await desk(stale).plugin.refresh();
  assert.equal(updated?.ok, true);
  assert.ok(stale.calls.some((c) => c[1] === 'update' && c[2] === PLUGIN_ID));

  for (const installed of [[], [{ id: PLUGIN_ID, version: '1.0.0-old', scope: 'local' }]]) {
    const cli = new FakePluginCli();
    cli.installed = installed;
    assert.equal(await desk(cli).plugin.refresh(), null, 'not installed at user scope, so nobody asked for it');
    assert.ok(!cli.calls.some((c) => c[1] === 'install' || c[1] === 'update' || c[1] === 'marketplace'));
  }

  const current = new FakePluginCli();
  const { plugin, bundle } = desk(current);
  current.installed = both(bundle.version);
  assert.equal(await plugin.refresh(), null);

  const half = new FakePluginCli();
  half.installed = [{ id: PLUGIN_ID, version: '1.0.0-old', scope: 'user' }];
  assert.equal(await desk(half).plugin.refresh(), null, 'a plugin nobody installed is not installed at boot');

  const down = new FakePluginCli();
  down.refuse.set('plugin list', { code: 1, stdout: '', stderr: 'claude: not logged in' });
  assert.equal(await desk(down).plugin.refresh(), null, 'a CLI that cannot answer is not updated over');
});

test('a corrupt manifest on disk is rewritten, not refused', () => {
  const into = input();
  writePluginBundle(into);
  writeFileSync(join(into.outDir, 'lubbdubb', '.claude-plugin', 'plugin.json'), '{ half');
  const bundle = writePluginBundle(into);
  assert.equal(
    (read(join(into.outDir, 'lubbdubb', '.claude-plugin', 'plugin.json')) as { version: string }).version,
    bundle.version,
  );
});

test('status is missing while either plugin is, and stale names the version that is behind', async () => {
  const only = new FakePluginCli();
  const first = desk(only);
  only.installed = [{ id: PLUGIN_ID, version: first.bundle.version, scope: 'user' }];
  const missing = await first.plugin.status();
  assert.equal(missing.state, 'missing', 'the board alone is not the bundle');

  const behind = new FakePluginCli();
  const second = desk(behind);
  behind.installed = [
    { id: PLUGIN_ID, version: second.bundle.version, scope: 'user' },
    { id: ASSISTANT_ID, version: '1.0.0-old', scope: 'user' },
  ];
  const stale = await second.plugin.status();
  assert.equal(stale.state, 'stale');
  assert.equal(stale.state === 'stale' ? stale.installed : null, '1.0.0-old');
});

test('install places the plugin that is missing and updates the one that is there', async () => {
  const cli = new FakePluginCli();
  cli.installed = [{ id: PLUGIN_ID, version: '1.0.0-old', scope: 'user' }];
  const { plugin } = desk(cli);
  const result = await plugin.install();
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  const placing = cli.calls.filter((c) => c[1] === 'install' || c[1] === 'update');
  assert.deepEqual(placing, [
    ['plugin', 'update', PLUGIN_ID, '--scope', 'user'],
    ['plugin', 'install', ASSISTANT_ID, '--scope', 'user', '--json'],
  ]);
  assert.deepEqual(
    result.steps.slice(1, 3).map((s) => s.label),
    ['update the plugin', 'install the PR assistant'],
  );
});

test('a refused PR assistant install stops before the tidy steps', async () => {
  const cli = new FakePluginCli();
  cli.registered = OLD_BRIDGE;
  cli.installed = [{ id: PLUGIN_ID, version: '1.0.0-old', scope: 'user' }];
  cli.refuse.set('plugin install', { code: 1, stdout: '', stderr: 'Plugin "pr-assistant" not found' });
  const result = await desk(cli).plugin.install();
  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1)?.label, 'install the PR assistant');
  assert.ok(!cli.calls.some((c) => c[0] === 'mcp'));
});
