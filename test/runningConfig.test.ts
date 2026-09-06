import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, type Config } from '../src/config.js';
import { describeRunningConfig, type RunningConfigEntry } from '../src/server/runningConfig.js';

function entries(config: Config): RunningConfigEntry[] {
  return describeRunningConfig(config).flatMap((g) => g.entries);
}

function entry(config: Config, path: string): RunningConfigEntry | undefined {
  return entries(config).find((e) => e.path === path);
}

test('a config that configures nothing reports nothing as configured', () => {
  const chosen = entries(loadConfig()).filter((e) => !e.isDefault);
  assert.deepEqual(
    chosen.map((e) => e.path),
    [],
  );
});

test('an overridden value is marked, and only it', () => {
  const config = loadConfig({ maxConcurrentAgents: 9 });
  assert.equal(entry(config, 'maxConcurrentAgents')?.isDefault, false);
  assert.equal(entry(config, 'maxConcurrentAgents')?.value, 9);
  assert.equal(entry(config, 'heartbeatIntervalMs')?.isDefault, true);
});

test('a nested override marks the leaf, not the block', () => {
  const config = loadConfig({ planning: { maxConcurrentPartsPerIssue: 4 } as Config['planning'] });
  assert.equal(entry(config, 'planning.maxConcurrentPartsPerIssue')?.isDefault, false);
  assert.equal(entry(config, 'planning.gitFetchIntervalMs')?.isDefault, true);
  assert.equal(entry(config, 'planning')?.value, undefined, 'the block itself must not also be listed');
});

test('arrays are shipped whole rather than expanded', () => {
  const config = loadConfig({ agentAllowedTools: ['Bash(npm:*)'] });
  assert.deepEqual(entry(config, 'agentAllowedTools')?.value, ['Bash(npm:*)']);
  assert.equal(entry(config, 'agentAllowedTools.0'), undefined);
});

test('unset optionals are omitted entirely', () => {
  const config = loadConfig();
  assert.equal(config.github, undefined);
  assert.equal(
    entries(config).find((e) => e.path.startsWith('github')),
    undefined,
  );
});

test('a key another key can require is drawn even while unset', () => {
  const config = loadConfig();
  assert.equal(config.fleetId, undefined);
  const row = entry(config, 'fleetId');
  assert.ok(row, 'the row is drawn');
  assert.equal(row.value, '');
  assert.equal(row.isDefault, true, 'nobody chose it, so there is nothing to reset');
  assert.deepEqual(row.requiredWhen, { path: 'integrations.pool', unless: 'fake' });
});

test('an unset fleetId is offered userId@pool.project, and nothing less', () => {
  const whole = loadConfig({ userId: 'adam', pool: { project: 'lubbdubb' } });
  assert.equal(entry(whole, 'fleetId')?.suggestion, 'adam@lubbdubb');

  const noProject = loadConfig({ userId: 'adam' });
  assert.equal(entry(noProject, 'fleetId')?.suggestion, undefined);
  const noUser = loadConfig({ pool: { project: 'lubbdubb' } });
  assert.equal(entry(noUser, 'fleetId')?.suggestion, undefined);
});

test('a null default is a value, not an unset key', () => {
  const config = loadConfig();
  assert.equal(entry(config, 'spendBurn.ceilingUsd')?.value, null);
  assert.equal(entry(config, 'spendBurn.ceilingUsd')?.isDefault, true);
});

test('a configured optional with no default reads as chosen', () => {
  const config = loadConfig({ github: { owner: 'someone', repo: 'something' } });
  assert.equal(entry(config, 'github.owner')?.isDefault, false);
});

test('a key belonging to no group still appears, under Other', () => {
  const config = { ...loadConfig(), somethingAddedLater: 42 } as unknown as Config;
  const groups = describeRunningConfig(config);
  const other = groups.find((g) => g.title === 'Other');
  assert.ok(other, 'an unclaimed key must land in Other');
  assert.deepEqual(
    other.entries.map((e) => e.path),
    ['somethingAddedLater'],
  );
});

test('every group has a title and no group is empty', () => {
  for (const group of describeRunningConfig(loadConfig())) {
    assert.ok(group.title.length > 0);
    assert.ok(group.entries.length > 0, `${group.title} is empty and should not have been emitted`);
  }
});

test('a value the project’s shared config sets reads as inherited, and says where from', () => {
  const project = { defaultBranch: 'trunk', planning: { maxConcurrentPartsPerIssue: 5 } } as Partial<Config>;
  const config = loadConfig(project);
  const shown = describeRunningConfig(config, project).flatMap((group) => group.entries);
  const branch = shown.find((e) => e.path === 'defaultBranch');
  assert.equal(branch?.value, 'trunk');
  assert.equal(branch?.isDefault, true, 'the operator did not choose it — clearing their file leaves it standing');
  assert.equal(branch?.fromProject, true);

  assert.equal(shown.find((e) => e.path === 'planning.maxConcurrentPartsPerIssue')?.fromProject, true);
  assert.equal(shown.find((e) => e.path === 'planning.gitFetchIntervalMs')?.fromProject, undefined);
  assert.equal(shown.find((e) => e.path === 'heartbeatIntervalMs')?.fromProject, undefined);
});

test('an operator overriding a project value is marked as having chosen it — and the origin stays named', () => {
  const project = { defaultBranch: 'trunk' } as Partial<Config>;
  const config = loadConfig({ ...project, defaultBranch: 'release' });
  const branch = describeRunningConfig(config, project)
    .flatMap((group) => group.entries)
    .find((e) => e.path === 'defaultBranch');
  assert.equal(branch?.value, 'release');
  assert.equal(branch?.isDefault, false, 'this one is theirs');
  assert.equal(branch?.fromProject, true, 'and what it falls back to is the team’s, not the build’s');
});

test('with no project layer, nothing reads as coming from one', () => {
  const shown = describeRunningConfig(loadConfig({ maxConcurrentAgents: 9 })).flatMap((group) => group.entries);
  assert.equal(shown.filter((e) => e.fromProject !== undefined).length, 0);
  assert.equal(shown.find((e) => e.path === 'maxConcurrentAgents')?.isDefault, false);
});
