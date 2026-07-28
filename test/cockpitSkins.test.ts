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

const NOW = Date.parse('2026-01-01T12:00:00.000Z');

type LocaleFormatter = (locale?: Intl.LocalesArgument, opts?: Intl.DateTimeFormatOptions) => string;

/**
 * Run `fn` against a pinned clock, locale and timezone.
 *
 * Two separate machine dependencies, both of which the golden would otherwise
 * bake in:
 *
 *  - `buildDemoState` stamps every timestamp relative to `Date.now()`, so the
 *    rendered relative times ("4m ago") drift between runs.
 *  - `UsageChip` formats the rate-limit reset with `toLocaleTimeString([])` —
 *    the *runtime's* locale and zone. The same instant renders `14:20` on a
 *    24-hour machine and `02:20 PM` on an en-US one, so a golden generated on
 *    one developer's laptop fails on CI for a reason that has nothing to do with
 *    the DOM. (It did: this test was red on the Linux runner from the day it
 *    landed, while passing locally.)
 *
 * The formatters are pinned rather than the component changed, because which
 * clock format an operator sees is correctly their machine's business — it is
 * only the *golden* that needs it to be nobody's.
 */
function pinned<T>(fn: () => T): T {
  const realNow = Date.now;
  const proto = Date.prototype as unknown as Record<string, LocaleFormatter>;
  const real: Record<string, LocaleFormatter> = {};
  Date.now = () => NOW;
  for (const name of ['toLocaleTimeString', 'toLocaleDateString', 'toLocaleString']) {
    real[name] = proto[name]!;
    proto[name] = function (this: Date, _locale, opts) {
      return real[name]!.call(this, 'en-GB', { timeZone: 'UTC', ...opts });
    };
  }
  try {
    return fn();
  } finally {
    Date.now = realNow;
    for (const name of Object.keys(real)) proto[name] = real[name]!;
  }
}

function frozenView() {
  const { state } = buildDemoState();
  return buildViewModel({
    state,
    now: NOW,
    connected: true,
    demo: true,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: NOW,
    viewingPlan: null,
  });
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
  pinned(() => {
    const view = frozenView();
    for (const skin of SKINS) {
      const markup = renderToStaticMarkup(createElement(skin.Root, { view, actions: INERT }));
      assert.ok(markup.length > 1000, `${skin.id} rendered almost nothing`);
    }
  });
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
  const markup = pinned(() =>
    renderToStaticMarkup(createElement(resolveSkin('classic').Root, { view: frozenView(), actions: INERT })),
  );

  // The pin above is what makes the bytes portable; assert it took, so a future
  // refactor that drops it fails here rather than eight hours later on CI.
  assert.doesNotMatch(markup, /\d\d:\d\d\s?(AM|PM)/i, 'a 12-hour clock leaked in — the locale pin is not in effect');

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
