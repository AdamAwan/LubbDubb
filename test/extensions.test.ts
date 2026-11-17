import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { loadExtensions } from '../src/extensions/load.js';
import { ExtensionHost } from '../src/extensions/host.js';
import type { SlotBook } from '../src/extensions/contract.js';
import type { ErrorLogInput, ErrorLogEntry } from '../src/types.js';
import { gitRepo, tmpDir } from './support/gitRepo.js';

type TestSlots = {
  greet: { input: { who: string }; output: string };
  count: { input: null; output: number };
};

const BOOK: SlotBook<TestSlots> = {
  greet: {
    timeoutMs: 200,
    check: (value) => (typeof value === 'string' ? null : 'expected a string'),
  },
  count: {
    timeoutMs: 200,
    check: (value) => (typeof value === 'number' ? null : 'expected a number'),
  },
};

function extensionFile(source: string, name = 'ext.mjs'): string {
  const path = join(tmpDir('lubbdubb-ext-'), name);
  writeFileSync(path, source);
  return path;
}

function recorder() {
  const recorded: ErrorLogInput[] = [];
  return {
    recorded,
    errors: {
      record(input: ErrorLogInput): ErrorLogEntry {
        recorded.push(input);
        return { id: String(recorded.length), createdAt: '', detail: null, ...input };
      },
    },
  };
}

async function refusalOf(source: string): Promise<string> {
  const path = extensionFile(source);
  try {
    await loadExtensions({ paths: [path], book: BOOK });
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /^Refusing to start: the extension at /);
    assert.ok(message.includes(path), 'the refusal names the file');
    return message;
  }
  assert.fail('the extension loaded');
}

async function host(source: string) {
  const extensions = await loadExtensions({ paths: [extensionFile(source)], book: BOOK });
  const { recorded, errors } = recorder();
  return { recorded, host: new ExtensionHost({ book: BOOK, extensions, repoRoot: '/repo', errors }) };
}

test('no extensions configured loads nothing, and the system builds exactly as before', async () => {
  assert.deepEqual(await loadExtensions({ paths: [], book: BOOK }), []);
  const config = loadConfig({ dbPath: ':memory:', repoRoot: gitRepo(), auth: { enabled: false } as never });
  assert.deepEqual(config.extensions, []);
  const system = buildSystem(config, { errorMirror: () => {} });
  assert.deepEqual(system.extensions.names(), []);
});

test('by default an extension is checked against the harness book, which has no slots yet', async () => {
  const path = extensionFile(`export default { apiVersion: 1, name: 'a', slots: { greet: () => '' } };`);
  await assert.rejects(
    loadExtensions({ paths: [path] }),
    /"greet" slot, which this harness does not have; this harness has no slots yet/,
  );
});

test('extension paths resolve against repoRoot', () => {
  const root = tmpDir('lubbdubb-ext-');
  const config = loadConfig({ dbPath: ':memory:', repoRoot: root, extensions: ['tools/ext.mjs', '/abs/ext.mjs'] });
  assert.deepEqual(config.extensions, [join(root, 'tools/ext.mjs'), '/abs/ext.mjs']);
});

test('a well-formed extension loads and its slot answers', async () => {
  const { host: h, recorded } = await host(
    `export default { apiVersion: 1, name: 'acme', slots: { greet: ({ who }, ctx) => 'hi ' + who + ' from ' + ctx.repoRoot } };`,
  );
  assert.deepEqual(h.names(), ['acme']);
  assert.equal(h.provider('greet'), 'acme');
  assert.equal(h.provider('count'), null);
  assert.deepEqual(await h.call('greet', { who: 'sam' }), { ok: true, value: 'hi sam from /repo' });
  assert.deepEqual(recorded, []);
});

test('an unfilled slot answers not-ok without recording an error', async () => {
  const { host: h, recorded } = await host(`export default { apiVersion: 1, name: 'acme', slots: {} };`);
  const result = await h.call('count', null);
  assert.equal(result.ok, false);
  assert.deepEqual(recorded, []);
});

test('an extension that is not there, or not shaped like one, refuses to start', async () => {
  await assert.rejects(
    loadExtensions({ paths: [join(tmpDir('lubbdubb-ext-'), 'missing.mjs')], book: BOOK }),
    /Refusing to start: .*could not be loaded/,
  );
  assert.match(await refusalOf(`export const x = 1;`), /default export is not an object/);
  assert.match(await refusalOf(`export default { apiVersion: 2, name: 'a' };`), /apiVersion 2 .* speaks 1/);
  assert.match(await refusalOf(`export default { apiVersion: 1 };`), /has no name/);
  assert.match(
    await refusalOf(`export default { apiVersion: 1, name: 'a', slot: {} };`),
    /exports "slot", .* the keys are "apiVersion", "name", "slots"/,
  );
  assert.match(
    await refusalOf(`export default { apiVersion: 1, name: 'a', slots: { greeet: () => '' } };`),
    /"greeet" slot, which this harness does not have; the slots are "greet", "count"/,
  );
  assert.match(
    await refusalOf(`export default { apiVersion: 1, name: 'a', slots: { greet: 'hello' } };`),
    /"greet" slot is not a function/,
  );
});

test('two extensions may not share a name or a slot', async () => {
  const a = extensionFile(`export default { apiVersion: 1, name: 'a', slots: { greet: () => '' } };`);
  const sameName = extensionFile(`export default { apiVersion: 1, name: 'a', slots: {} };`);
  const sameSlot = extensionFile(`export default { apiVersion: 1, name: 'b', slots: { greet: () => '' } };`);
  await assert.rejects(loadExtensions({ paths: [a, sameName], book: BOOK }), /name "a" is already taken/);
  await assert.rejects(loadExtensions({ paths: [a, sameSlot], book: BOOK }), /extension "a" already fills/);
});

test('a slot that throws, rejects, times out or answers the wrong shape is not-ok and recorded — never thrown', async () => {
  const { host: h, recorded } = await host(`export default { apiVersion: 1, name: 'acme', slots: {
    greet: ({ who }) => { if (who === 'sync') throw new Error('boom'); if (who === 'async') return Promise.reject(new Error('later')); if (who === 'null') throw null; return new Promise(() => {}); },
    count: () => 'seven',
  } };`);

  const sync = await h.call('greet', { who: 'sync' });
  assert.deepEqual(sync, { ok: false, detail: 'extension "acme" failed the "greet" slot: boom' });
  const later = await h.call('greet', { who: 'async' });
  assert.equal(later.ok, false);
  const hung = await h.call('greet', { who: 'hang' });
  assert.match(hung.ok ? '' : hung.detail, /did not answer within 200 ms/);
  const shape = await h.call('count', null);
  assert.match(shape.ok ? '' : shape.detail, /wrong shape: expected a number/);

  const thrown = await h.call('greet', { who: 'null' });
  assert.match(thrown.ok ? '' : thrown.detail, /failed the "greet" slot: null$/);

  assert.equal(recorded.length, 5);
  assert.ok(recorded.every((entry) => entry.source === 'runtime' && entry.message.startsWith('extension "acme"')));
});

test('a timed-out slot sees its signal aborted', async () => {
  const { host: h } = await host(`export default { apiVersion: 1, name: 'acme', slots: {
      count: (_, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => { globalThis.__extAborted = true; resolve(1); })),
    } };`);
  const result = await h.call('count', null);
  assert.equal(result.ok, false);
  assert.equal((globalThis as { __extAborted?: boolean }).__extAborted, true);
});
