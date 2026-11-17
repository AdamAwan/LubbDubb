import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EXTENSION_API_VERSION } from '../src/extensions/contract.js';
import { loadExtensions } from '../src/extensions/load.js';
import { EXTENSION_SLOTS } from '../src/extensions/slots.js';
import { pluginSkills } from '../src/plugin/bundle.js';

// → docs/spec/42-extensions.md#writing-an-extension

const skill = pluginSkills().find((s) => s.name === 'extension')?.text ?? '';
const STARTER = join(import.meta.dirname, '..', 'plugin', 'skills', 'extension', 'starter.ts');

test('the extension skill documents every slot the harness asks, at its API version', () => {
  assert.notEqual(skill, '', 'the plugin ships an extension skill');
  for (const slot of Object.keys(EXTENSION_SLOTS))
    assert.match(skill, new RegExp(`\\| \`${slot}\` +\\|`), `the slots table has a row for ${slot}`);
  assert.match(skill, new RegExp(`\`apiVersion\` \\*\\*${EXTENSION_API_VERSION}\\*\\*`));
});

test('the starter the skill hands out loads against this harness and fills every slot', async () => {
  const [loaded] = await loadExtensions({ paths: [STARTER], book: EXTENSION_SLOTS });
  assert.deepEqual([...loaded!.slots.keys()].sort(), Object.keys(EXTENSION_SLOTS).sort());
});
