import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromText } from '../src/config/config.js';
import { CONFIG_FIELDS } from '../src/config/configFields.js';

// → docs/spec/02-configuration.md#retired-keys

test('a file still bounding the removed ingress boots, warns naming the key, and keeps the rest', (t) => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string): void => void warnings.push(msg);
  t.after(() => {
    console.warn = realWarn;
  });
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-ingress-keys-'));
  const config = loadConfigFromText(
    JSON.stringify({
      repoRoot: dir,
      projectConfigFile: join(dir, 'absent.json'),
      ingress: { debounceMs: 1000, minCycleGapMs: 5000, requestsPerMinute: 600, maxBodyBytes: 1048576 },
      maxConcurrentAgents: 3,
    }),
    join(dir, 'lubbdubb.config.json'),
  );
  assert.equal(config.maxConcurrentAgents, 3);
  assert.ok(!Object.hasOwn(config, 'ingress'), 'ingress is dropped, not merged');
  assert.ok(
    warnings.some((w) => w.includes('"ingress"') && w.includes('no longer exists')),
    'ingress is named on the boot log',
  );
  assert.ok(!CONFIG_FIELDS.some((f) => f.path.startsWith('ingress.')), 'no ingress field is drawn');
});
