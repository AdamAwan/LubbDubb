import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { EXTENSION_API_VERSION } from '../src/extensions/contract.js';
import { loadExtensions } from '../src/extensions/load.js';
import { EXTENSION_SLOTS, type ExtensionSlots } from '../src/extensions/slots.js';
import { pluginSkills } from '../src/plugin/bundle.js';
import type starter from '../plugin/skills/extension/starter.js';

// → docs/spec/42-extensions.md#writing-an-extension

const STARTER = join(import.meta.dirname, '..', 'plugin', 'skills', 'extension', 'starter.ts');

type Answer<T> = T extends undefined ? void : T;

type Contract = {
  apiVersion: number;
  name: string;
  slots: {
    [K in keyof ExtensionSlots]: (
      input: ExtensionSlots[K]['input'],
      context: { repoRoot: string; signal: AbortSignal },
    ) => Answer<ExtensionSlots[K]['output']> | Promise<Answer<ExtensionSlots[K]['output']>>;
  };
};

test('the extension skill’s slots table is exactly the harness’s slots, at its API version', () => {
  const skill = pluginSkills().find((s) => s.name === 'extension')?.text;
  assert.ok(skill, 'the plugin ships an extension skill');
  const from = skill.indexOf('### The slots');
  const to = skill.indexOf('### The file');
  assert.ok(from >= 0 && to > from, 'the skill keeps its slots table between these two headings');
  const rows = [...skill.slice(from, to).matchAll(/^\| `(\w+)` +\|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(rows, Object.keys(EXTENSION_SLOTS).sort());
  assert.match(skill, new RegExp(`\`apiVersion\` \\*\\*${EXTENSION_API_VERSION}\\*\\*`));
});

test('the starter the skill hands out matches the slot types, loads, and fills every slot', async () => {
  const typed: typeof starter extends Contract ? true : never = true;
  assert.equal(typed, true, 'checked by the typechecker: the starter fills each slot with its own types');
  const [loaded] = await loadExtensions({
    paths: [STARTER],
    book: EXTENSION_SLOTS,
    importModule: (url) => {
      const { code } = transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm' });
      return import(`data:text/javascript,${encodeURIComponent(code)}`) as Promise<unknown>;
    },
  });
  assert.deepEqual([...loaded!.slots.keys()].sort(), Object.keys(EXTENSION_SLOTS).sort());
});
