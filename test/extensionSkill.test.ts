import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EXTENSION_API_VERSION } from '../src/extensions/contract.js';
import { loadExtensions } from '../src/extensions/load.js';
import { EXTENSION_SLOTS } from '../src/extensions/slots.js';
import { pluginSkills } from '../src/plugin/bundle.js';

// → docs/spec/42-extensions.md#writing-an-extension

const STARTER = join(import.meta.dirname, '..', 'plugin', 'skills', 'extension', 'starter.ts');

test('the extension skill’s slots table is exactly the harness’s slots, at its API version', () => {
  const skill = pluginSkills().find((s) => s.name === 'extension')?.text;
  assert.ok(skill, 'the plugin ships an extension skill');
  const table = skill.slice(skill.indexOf('### The slots'), skill.indexOf('### The file'));
  const rows = [...table.matchAll(/^\| `(\w+)` +\|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(rows, Object.keys(EXTENSION_SLOTS).sort());
  assert.match(skill, new RegExp(`\`apiVersion\` \\*\\*${EXTENSION_API_VERSION}\\*\\*`));
});

test('the starter the skill hands out loads against this harness and fills every slot', async () => {
  const [loaded] = await loadExtensions({ paths: [STARTER], book: EXTENSION_SLOTS });
  assert.deepEqual([...loaded!.slots.keys()].sort(), Object.keys(EXTENSION_SLOTS).sort());
});
