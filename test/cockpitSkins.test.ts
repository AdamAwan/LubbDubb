import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';

// Vite compiles the cockpit's JSX with the automatic runtime; `tsx` compiles it
// with the classic one, which emits bare `React.createElement`. Rather than bend
// either config to suit the other, the global is provided here and the skin
// modules are imported after it — so the test exercises the same sources the
// bundle does, transformed however the runner likes.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { SKINS, resolveSkin } = await import('../web/src/skins/registry.js');

const SKINS_DIR = join(process.cwd(), 'web', 'src', 'skins');
const GOLDEN = join(process.cwd(), 'test', 'fixtures', 'classic-markup.html');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Fixture state with the clock pinned. `buildDemoState` stamps every timestamp
 * relative to `Date.now()`, so without this the rendered relative times ("4m
 * ago") drift between runs and no golden could exist.
 */
function frozenView(now = Date.parse('2026-01-01T12:00:00.000Z')) {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { state } = buildDemoState();
    return buildViewModel({
      state,
      now,
      connected: true,
      demo: true,
      selected: null,
      liveOutput: new Map(),
      tails: new Map(),
      lastPulseAt: now,
    });
  } finally {
    Date.now = realNow;
  }
}

/** Every action a no-op: rendering must never need one, and a call would be a bug. */
const INERT = new Proxy({} as CockpitActions, {
  get: () => () => Promise.resolve(),
});

/**
 * The load-bearing rule of the skin seam. A skin that reached the network directly
 * could grow a capability the other skins lack, and the difference would surface
 * only as a button that exists in one theme — so every mutation is enumerated on
 * `CockpitActions` and the import is asserted absent here. Structural, because an
 * import-graph property nobody checks is one that decays (same reason
 * `prAttention` asserts its single importer).
 */
test('no skin imports the api client', () => {
  const offenders = walk(SKINS_DIR).filter(
    (f) => /\.tsx?$/.test(f) && /from '.*\/api\.js'/.test(readFileSync(f, 'utf8')),
  );
  assert.deepEqual(offenders, [], 'skins must go through CockpitActions, never api.js directly');
});

/**
 * Every registered skin renders the demo world without throwing. A skin added
 * later is asserted on the day it is written rather than the day it breaks.
 */
test('every registered skin renders the demo world', () => {
  assert.ok(SKINS.length > 0, 'at least one skin must be registered');
  const view = frozenView();
  for (const skin of SKINS) {
    const markup = renderToStaticMarkup(createElement(skin.Root, { view, actions: INERT }));
    assert.ok(markup.length > 1000, `${skin.id} rendered almost nothing`);
  }
});

/** A stored id nobody recognises is a normal thing to find, not an error. */
test('an unknown stored skin id falls back instead of failing', () => {
  assert.equal(resolveSkin('a-skin-that-was-deleted').id, 'classic');
  assert.equal(resolveSkin(null).id, 'classic');
});

/**
 * Classic's markup, byte for byte.
 *
 * What this does and does not prove: it fixes the *static tree* — effects and
 * handlers are not exercised, and CSS is not covered at all (that half rests on
 * the token indirection resolving to the values it replaced). Its value is
 * forward-looking: any later change to Classic's DOM has to be deliberate enough
 * to regenerate this file.
 *
 * Regenerate with `UPDATE_GOLDEN=1 npm test`.
 */
test('classic renders its golden markup', () => {
  const view = frozenView();
  const markup = renderToStaticMarkup(createElement(resolveSkin('classic').Root, { view, actions: INERT }));

  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, markup, 'utf8');
    return;
  }
  // Compared with line endings normalised, and `.gitattributes` pins the file to
  // LF as well. Belt and braces on purpose: the assertion is about the DOM, and a
  // checkout on Windows will happily rewrite every newline inside a text node,
  // which would fail this test for a reason that has nothing to do with the
  // cockpit.
  const lf = (s: string) => s.replace(/\r\n/g, '\n');
  assert.equal(
    lf(markup),
    lf(readFileSync(GOLDEN, 'utf8')),
    'Classic markup changed — rerun with UPDATE_GOLDEN=1 if intended',
  );
});
