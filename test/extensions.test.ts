import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { loadExtensions } from '../src/extensions/load.js';
import { ExtensionHost } from '../src/extensions/host.js';
import { EXTENSION_SLOTS } from '../src/extensions/slots.js';
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

test('main checks extensions against the harness book, and a slot outside it refuses to start', async () => {
  const path = extensionFile(`export default { apiVersion: 1, name: 'a', slots: { notASlot: () => '' } };`);
  await assert.rejects(
    loadExtensions({ paths: [path], book: EXTENSION_SLOTS }),
    /"notASlot" slot, which this harness does not have/,
  );
});

test('a harness with no slots says so when an extension fills one', async () => {
  const path = extensionFile(`export default { apiVersion: 1, name: 'a', slots: { greet: () => '' } };`);
  await assert.rejects(loadExtensions({ paths: [path], book: {} }), /this harness has no slots yet/);
});

test('a wrong-shaped answer aborts the slot signal', async () => {
  const { host: h } = await host(`export default { apiVersion: 1, name: 'acme', slots: {
    count: (_, { signal }) => { globalThis.__extShapeSignal = signal; return 'seven'; },
  } };`);
  const holder = globalThis as { __extShapeSignal?: AbortSignal };
  try {
    const result = await h.call('count', null);
    assert.equal(result.ok, false);
    assert.equal(holder.__extShapeSignal?.aborted, true);
  } finally {
    delete holder.__extShapeSignal;
  }
});

test('a configured extension that was never loaded refuses to build the system', () => {
  const config = loadConfig({ dbPath: ':memory:', repoRoot: gitRepo(), extensions: ['ext.mjs'] });
  assert.throws(() => buildSystem(config, { errorMirror: () => {} }), /not loaded: .*ext\.mjs/);
  assert.throws(() => buildSystem(config, { errorMirror: () => {}, extensions: [] }), /not loaded: .*ext\.mjs/);
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

test('an unreadable throw while loading still refuses naming the file', async () => {
  assert.match(
    await refusalOf(`throw Object.create(null);`),
    /could not be loaded: it threw a value that is not an error/,
  );
});

test('the extensions config names, loaded and passed in, build a system that holds them', async () => {
  const repoRoot = gitRepo();
  writeFileSync(join(repoRoot, 'ext.mjs'), `export default { apiVersion: 1, name: 'acme', slots: {} };`);
  const config = loadConfig({ dbPath: ':memory:', repoRoot, extensions: ['ext.mjs'] });
  const extensions = await loadExtensions({ paths: config.extensions, book: EXTENSION_SLOTS });
  const system = buildSystem(config, { errorMirror: () => {}, extensions });
  assert.deepEqual(system.extensions.names(), ['acme']);
  assert.throws(
    () => buildSystem(config, { errorMirror: () => {}, extensions: [...extensions, ...extensions] }),
    /ext\.mjs is loaded twice/,
  );
});

test('separately loaded extensions that share a slot refuse to build', async () => {
  const repoRoot = gitRepo();
  writeFileSync(join(repoRoot, 'a.mjs'), `export default { apiVersion: 1, name: 'a', slots: { greet: () => '' } };`);
  writeFileSync(join(repoRoot, 'b.mjs'), `export default { apiVersion: 1, name: 'b', slots: { greet: () => '' } };`);
  const config = loadConfig({ dbPath: ':memory:', repoRoot, extensions: ['a.mjs', 'b.mjs'] });
  const extensions = [
    ...(await loadExtensions({ paths: [config.extensions[0]!], book: BOOK })),
    ...(await loadExtensions({ paths: [config.extensions[1]!], book: BOOK })),
  ];
  assert.throws(
    () => buildSystem(config, { errorMirror: () => {}, extensions }),
    /extensions "a" \(.*a\.mjs\) and "b" \(.*b\.mjs\) both fill the "greet" slot/,
  );
});

test('extensions passed to buildSystem that config does not name refuse to build', () => {
  const config = loadConfig({ dbPath: ':memory:', repoRoot: gitRepo() });
  const stray = { name: 'stray', path: '/elsewhere/ext.mjs', slots: new Map() };
  assert.throws(
    () => buildSystem(config, { errorMirror: () => {}, extensions: [stray] }),
    /not in config: \/elsewhere\/ext\.mjs/,
  );
});

test('a path config lists twice is refused when the config loads', () => {
  assert.throws(
    () => loadConfig({ dbPath: ':memory:', repoRoot: tmpDir('lubbdubb-ext-'), extensions: ['ext.mjs', './ext.mjs'] }),
    /lists .*ext\.mjs more than once/,
  );
});

test('a host built directly still refuses two owners of one slot', async () => {
  const a = extensionFile(`export default { apiVersion: 1, name: 'a', slots: { greet: () => '' } };`);
  const b = extensionFile(`export default { apiVersion: 1, name: 'b', slots: { greet: () => '' } };`);
  const extensions = [
    ...(await loadExtensions({ paths: [a], book: BOOK })),
    ...(await loadExtensions({ paths: [b], book: BOOK })),
  ];
  const { errors } = recorder();
  assert.throws(
    () => new ExtensionHost({ book: BOOK, extensions, repoRoot: '/repo', errors }),
    /"a" .* and "b" .* both fill the "greet" slot/,
  );
});

test('two extensions may not share a name or a slot', async () => {
  const a = extensionFile(`export default { apiVersion: 1, name: 'a', slots: { greet: () => '' } };`);
  const sameName = extensionFile(`export default { apiVersion: 1, name: 'a', slots: {} };`);
  const sameSlot = extensionFile(`export default { apiVersion: 1, name: 'b', slots: { greet: () => '' } };`);
  await assert.rejects(loadExtensions({ paths: [a, sameName], book: BOOK }), /are both named "a"/);
  await assert.rejects(
    loadExtensions({ paths: [a, sameSlot], book: BOOK }),
    /extensions "a" \(.*ext\.mjs\) and "b" \(.*ext\.mjs\) both fill the "greet" slot/,
  );
});

test('a slot that throws, rejects, times out or answers the wrong shape is not-ok and recorded — never thrown', async () => {
  const { host: h, recorded } = await host(`export default { apiVersion: 1, name: 'acme', slots: {
    greet: ({ who }) => { if (who === 'sync') throw new Error('boom'); if (who === 'async') return Promise.reject(new Error('later')); if (who === 'null') throw null; if (who === 'bare') throw Object.create(null); if (who === 'plain') throw { message: 'plain object', stack: 'at plain' }; return new Promise(() => {}); },
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

  const plain = await h.call('greet', { who: 'plain' });
  assert.match(plain.ok ? '' : plain.detail, /: plain object$/);
  assert.equal(recorded.at(-1)?.detail, 'at plain');

  const bare = await h.call('greet', { who: 'bare' });
  assert.match(bare.ok ? '' : bare.detail, /a value that is not an error$/);

  assert.equal(recorded.length, 7);
  assert.ok(recorded.every((entry) => entry.source === 'runtime' && entry.message.startsWith('extension "acme"')));
});

test('a timed-out slot sees its signal aborted', async () => {
  const { host: h } = await host(`export default { apiVersion: 1, name: 'acme', slots: {
      count: (_, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => { globalThis.__extAborted = true; resolve(1); })),
    } };`);
  const holder = globalThis as { __extAborted?: boolean };
  try {
    const result = await h.call('count', null);
    assert.equal(result.ok, false);
    assert.equal(holder.__extAborted, true);
  } finally {
    delete holder.__extAborted;
  }
});
