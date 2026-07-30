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

/**
 * The one that matters, and the reason `defaultConfig` exists at all.
 *
 * `loadConfig` resolves `repoRoot`, `worktreeRoot`, `deskRoot` and
 * `promptTemplatesDir` to absolute paths *after* merging, so comparing against
 * the raw `DEFAULTS` literals would report four of the most-read keys as
 * operator-chosen on every deployment — a viewer whose whole job is to say what
 * you changed, lying about it in the same four places every time.
 */
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
  // Its neighbours are untouched — the mark is per leaf, not per group.
  assert.equal(entry(config, 'heartbeatIntervalMs')?.isDefault, true);
});

/**
 * A nested block is expanded to leaves, so setting one member of it does not
 * make the other three read as chosen. `planning` is the case that matters:
 * `loadConfig` deep-merges it, so `{enabled: true}` alone leaves three defaults
 * behind that an operator must be able to tell apart from their own choice.
 */
test('a nested override marks the leaf, not the block', () => {
  // `enabled: false` is the override now that the funnel defaults on — the test
  // is about which row is marked, so it needs a value that differs from the default.
  const config = loadConfig({ planning: { enabled: false } as Config['planning'] });
  assert.equal(entry(config, 'planning.enabled')?.isDefault, false);
  assert.equal(entry(config, 'planning.requireApproval')?.isDefault, true);
  assert.equal(entry(config, 'planning.maxConcurrentPartsPerIssue')?.isDefault, true);
  assert.equal(entry(config, 'planning')?.value, undefined, 'the block itself must not also be listed');
});

/**
 * An ordered list and a label→weight map are leaves: their shape is the thing
 * worth reading, and expanding them would key rows on an array index that means
 * nothing to anybody.
 */
test('arrays are shipped whole rather than expanded', () => {
  const config = loadConfig({ steeringPriorities: ['ship the release'] });
  assert.deepEqual(entry(config, 'steeringPriorities')?.value, ['ship the release']);
  assert.equal(entry(config, 'steeringPriorities.0'), undefined);
});

/** An unset optional is not a configured value, and a column of blanks buries the rest. */
test('unset optionals are omitted entirely', () => {
  const config = loadConfig();
  assert.equal(config.github, undefined);
  assert.equal(
    entries(config).find((e) => e.path.startsWith('github')),
    undefined,
  );
});

/** A configured optional has no default to be, so it reads as chosen — which it was. */
test('a configured optional with no default reads as chosen', () => {
  const config = loadConfig({ github: { owner: 'someone', repo: 'something' } });
  assert.equal(entry(config, 'github.owner')?.isDefault, false);
});

/**
 * The grouping is a display hint, never a filter. A config key naming no group
 * falls into "Other" rather than vanishing, so a field added later is visible on
 * the day it is written instead of being silently absent until somebody notices.
 */
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
