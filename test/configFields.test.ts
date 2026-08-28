import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { configField, CONFIG_FIELDS, fieldValueRefusal, topSegment } from '../src/configFields.js';
import { isLiveField, liveFieldPaths } from '../src/configApply.js';
import { describeRunningConfig, groupedTopLevelKeys } from '../src/server/runningConfig.js';
import { declaredTopLevelKeys, configTopLevelKeys } from '../src/configFields.js';

/**
 * The two things that keep the field table from drifting away from the type it
 * describes — which is the failure `lubbdubb.config.example.json` already had,
 * and the reason the table exists instead of a second hand-maintained example.
 */

test('every config key is declared, so a new one cannot arrive un-editable', () => {
  const declared = declaredTopLevelKeys();
  const missing = [...configTopLevelKeys()].filter((key) => !declared.has(key));

  assert.deepEqual(
    missing,
    [],
    `these config keys have no entry in CONFIG_FIELDS, so the form cannot draw them: ${missing.join(', ')}`,
  );
});

/**
 * The third, and the one the other two do not cover. `CONFIG_FIELDS` is checked
 * against the type, but `lubbdubb.config.example.json` is checked against nothing
 * — and it is the file an operator is told to copy and run, so a key that outlived
 * its feature there is worse than a stale comment: it is a setting somebody pastes
 * into a live deployment, where it merges into nothing and does exactly what an
 * unset key does. `agentIdleWaitMs` and `sessionTranscriptRoot` shipped in it for
 * releases after the `pty` runtime they configured was removed, and
 * `lessonBlockChars` shipped in it while already retired — so the file told a
 * fresh deployment to warn on its own first boot.
 */
test('every key in the shipped example config is one this build still reads', () => {
  const example = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'lubbdubb.config.example.json'), 'utf8'),
  ) as Record<string, unknown>;
  const declared = declaredTopLevelKeys();
  // The '//'-prefixed keys are the file's inline docs, ignored at load.
  const unknown = Object.keys(example).filter((key) => !key.startsWith('//') && !declared.has(key));

  assert.deepEqual(
    unknown,
    [],
    `these keys are in lubbdubb.config.example.json but nothing reads them, so copying the file sets them to no effect: ${unknown.join(', ')}`,
  );
});

test('every declared field is drawn in a group of its own, never as an unknown key', () => {
  // A field whose top-level key is missing from `GROUPS` would fall through to
  // "Other" — where it is drawn as a key this build does not declare, and refused
  // for edit. Silent, and exactly backwards.
  const config = loadConfig({ userId: 'someone', github: { owner: 'o', repo: 'r' } });
  const groups = describeRunningConfig(config);
  const other = new Set((groups.find((group) => group.title === 'Other')?.entries ?? []).map((entry) => entry.path));
  const drawn = new Set(groups.flatMap((group) => group.entries).map((entry) => entry.path));

  for (const field of CONFIG_FIELDS) {
    assert.ok(!other.has(field.path), `${field.path} is declared but fell through to the Other group`);
  }
  // Every field with a value on this config is drawn; the rest are unset optionals.
  assert.ok(drawn.has('heartbeatIntervalMs') && drawn.has('auth.enabled') && drawn.has('github.owner'));
});

test('a live field is one an arm names, and every arm names a real field', () => {
  for (const path of liveFieldPaths()) {
    assert.ok(configField(path), `configApply has an arm for "${path}", which CONFIG_FIELDS does not declare`);
    assert.ok(isLiveField(path));
  }
  // And the other direction: a field with no arm is restart-only. Nothing may
  // claim liveness without one — that claim is the bug this classification exists
  // to prevent.
  const armed = new Set(liveFieldPaths());
  for (const field of CONFIG_FIELDS) {
    assert.equal(isLiveField(field.path), armed.has(field.path), `${field.path} disagrees with its arm`);
  }
});

test('the running config reports each field’s type, reach and liveness', () => {
  const entries = describeRunningConfig(loadConfig({})).flatMap((group) => group.entries);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  assert.deepEqual(
    { type: byPath.get('agentMode')?.type, options: byPath.get('agentMode')?.options },
    { type: 'enum', options: ['stream', 'raw'] },
  );
  assert.equal(byPath.get('maxConcurrentAgents')?.live, true, 'the cap has an arm');
  assert.equal(byPath.get('agentMode')?.live, false, 'the runtime object is picked once, at boot');
  assert.equal(byPath.get('host')?.access, 'advanced', 'a key that can lock you out sits behind the disclosure');
  assert.equal(byPath.get('whitelistedApprovals')?.access, 'fileOnly');
  assert.equal(byPath.get('heartbeatIntervalMs')?.ms, true);
});

test('an environment override is reported on the field it beats', () => {
  const before = process.env['PORT'];
  process.env['PORT'] = '4310';
  try {
    const entries = describeRunningConfig(loadConfig({})).flatMap((group) => group.entries);
    assert.equal(entries.find((entry) => entry.path === 'port')?.env, 'PORT');
    assert.equal(entries.find((entry) => entry.path === 'host')?.env, null);
  } finally {
    if (before === undefined) delete process.env['PORT'];
    else process.env['PORT'] = before;
  }
});

test('a value of the wrong type is refused by name, and a right one passes', () => {
  const port = configField('port');
  const mode = configField('agentMode');
  const tools = configField('agentAllowedTools');
  assert.ok(port && mode && tools);

  assert.match(fieldValueRefusal(port, '4300') ?? '', /port must be a number/);
  assert.equal(fieldValueRefusal(port, 4300), null);
  assert.match(fieldValueRefusal(mode, 'terminal') ?? '', /must be one of stream, raw/);
  assert.equal(fieldValueRefusal(mode, 'raw'), null);
  assert.match(fieldValueRefusal(tools, 'Bash(npm:*)') ?? '', /must be a list of strings/);
  assert.equal(fieldValueRefusal(tools, ['Bash(npm:*)']), null);
});

test('no field offers a credential', () => {
  // `Config` holds no secrets by construction, and a write path is a new reason
  // that has to hold rather than a reason to weaken it.
  for (const field of CONFIG_FIELDS) {
    assert.doesNotMatch(field.path, /token$|password|secret|\bpat\b|apiKey/i, `${field.path} reads like a credential`);
  }
  assert.equal(topSegment('auth.tokenFile'), 'auth');
});

test('every declared key is claimed by a group, so a new one cannot be invisible', () => {
  // `GROUPS` is a hand-written key list per group, and the "Other" fallback
  // deliberately skips anything `CONFIG_FIELDS` *declares* — so a declared key
  // nobody grouped is drawn nowhere at all. It validates, it applies, and the page
  // it was declared for never shows it: nothing red, and a field reachable only by
  // hand-editing the file. (An *unset* optional key legitimately draws no row —
  // `entryFor` returns null on `undefined` — which is why this asserts the grouping
  // rather than the rendered rows.)
  const grouped = groupedTopLevelKeys();
  const ungrouped = [...declaredTopLevelKeys()].filter((key) => !grouped.has(key));

  assert.deepEqual(ungrouped, [], `declared but in no group: ${ungrouped.join(', ')}`);
});
