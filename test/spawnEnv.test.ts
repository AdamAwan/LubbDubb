import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inheritableEnv } from '../src/agents/spawnEnv.js';

// → docs/spec/10-agent-runtimes.md#what-an-agent-does-not-inherit

test('an agent does not inherit the cockpit bearer or the desktop credential', () => {
  const inherited = inheritableEnv({
    ...process.env,
    LUBBDUBB_TOKEN: 'ZZQX-BEARER-SENTINEL',
    LUBBDUBB_DESKTOP_CREDENTIAL: 'ZZQX-DESKTOP-SENTINEL',
    PATH: process.env.PATH,
  });

  assert.equal(inherited.LUBBDUBB_TOKEN, undefined, 'the cockpit bearer reached an agent');
  assert.equal(inherited.LUBBDUBB_DESKTOP_CREDENTIAL, undefined, 'the desktop credential reached an agent');
  assert.equal(inherited.PATH, process.env.PATH, 'the rest of the environment still goes through');

  // Non-vacuous: the sentinel is findable in what we handed in, so the assertion
  // above is about the stripping and not about the key never having been set.
  assert.equal({ ...process.env, LUBBDUBB_TOKEN: 'ZZQX-BEARER-SENTINEL' }.LUBBDUBB_TOKEN, 'ZZQX-BEARER-SENTINEL');

  const spawnSites = ['src/agents/streamJsonSession.ts', 'src/pty/backend.ts'];
  for (const file of spawnSites) {
    const source = readFileSync(file, 'utf8');
    assert.ok(
      !/\.\.\.process\.env\b/.test(source),
      `${file} spreads process.env into an agent's environment, which hands it the cockpit bearer. ` +
        'Use inheritableEnv(). Fix the file, not this assertion.',
    );
  }
});
