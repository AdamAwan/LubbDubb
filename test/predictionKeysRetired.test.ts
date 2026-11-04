import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromText } from '../src/config/config.js';
import { CONFIG_FIELDS } from '../src/config/configFields.js';

// → docs/spec/02-configuration.md#retired-keys

test('a file still switching predictions or goal criteria boots, warns naming each key, and keeps the rest', (t) => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string): void => void warnings.push(msg);
  t.after(() => {
    console.warn = realWarn;
  });
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-prediction-keys-'));
  const config = loadConfigFromText(
    JSON.stringify({
      repoRoot: dir,
      projectConfigFile: join(dir, 'absent.json'),
      prediction: { enabled: true },
      predictionAggregateMinGoals: 4,
      goalCriteria: { enabled: false },
      maxConcurrentAgents: 3,
    }),
    join(dir, 'lubbdubb.config.json'),
  );
  assert.equal(config.maxConcurrentAgents, 3);
  for (const key of ['prediction', 'predictionAggregateMinGoals', 'goalCriteria']) {
    assert.ok(!Object.hasOwn(config, key), `${key} is dropped, not merged`);
    assert.ok(
      warnings.some((w) => w.includes(`"${key}"`) && w.includes('no longer exists')),
      `${key} is named on the boot log`,
    );
    assert.ok(!CONFIG_FIELDS.some((f) => f.path === key || f.path.startsWith(`${key}.`)), `${key} is drawn nowhere`);
  }
});
