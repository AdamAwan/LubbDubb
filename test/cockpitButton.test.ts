import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The cockpit's one button — `web/src/components/button.tsx`.
 *
 * The drift it replaced was silent in the way this repo cares about. The cockpit
 * drew two button families for the same four readings, and they had parted company
 * on shape, radius and accent: a 7px steel-blue primary in a modal and a 4px
 * vivid-blue one on the goal page, both called "primary". The second family grew
 * because `console.css` resets its own markup with `.cn button` at (0,1,1), so a
 * single-class `.btn` in there lost its ground and drew as bare text. `.btn.btn`
 * answers that at the source, which is why there is one family now.
 * → `docs/spec/17-cockpit.md#the-button`
 */

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one.
(globalThis as { React?: typeof React }).React = React;

const { Button, buttonClass, withShape } = await import('../web/src/components/button.js');

/**
 * The base is doubled in the markup as well as in the sheet. `.btn.btn` is what
 * outranks `console.css`'s `.cn button` reset at (0,1,1), and it only does so if
 * the element actually carries the class twice — which is the whole reason the
 * cockpit can have one button family instead of two.
 */
test('the base is written twice, so one rule dresses a button anywhere', () => {
  assert.equal(buttonClass({}), 'btn btn');
  assert.equal(buttonClass({ tone: 'secondary' }), 'btn btn');
  assert.equal(buttonClass({ tone: 'primary' }), 'btn btn primary');
});

test('one vocabulary, and it is the only one', () => {
  assert.equal(buttonClass({ tone: 'primary' }), 'btn btn primary');
  assert.equal(buttonClass({ tone: 'danger' }), 'btn btn danger');
  assert.equal(buttonClass({ ghost: true }), 'btn btn ghost');
  assert.equal(buttonClass({ size: 'small' }), 'btn btn small');
  // `secondary` is the plain button spelled out loud: a caller who means "the
  // quiet one beside the primary" says so rather than says nothing, and it
  // resolves to the same class list as saying nothing.
  assert.equal(buttonClass({ tone: 'secondary', ghost: true }), buttonClass({ ghost: true }));
});

/**
 * The reason `ghost` is a weight and not a third tone: a control that destroys
 * something can also be the quiet one in its row, and two of `ConfirmButton`'s
 * call sites are exactly that. Spelled as a tone the two readings could not
 * combine, and those sites would have had to give up their red to stay quiet.
 */
test('a destructive button can also be a quiet one', () => {
  assert.equal(buttonClass({ tone: 'danger', ghost: true, size: 'small' }), 'btn btn danger ghost small');
});

test('shape rides beside the tone, never through it', () => {
  assert.equal(buttonClass({ ghost: true, className: 'work-root-head' }), 'btn btn ghost work-root-head');
  assert.deepEqual(withShape({ ghost: true }, 'go'), { ghost: true, className: 'go' });
  assert.deepEqual(withShape({ ghost: true, className: 'go' }, 'no'), { ghost: true, className: 'go no' });
  // A station's shape is conditional at every one of `HumanTaskActions`' sites,
  // and a false arm must not land as the word "false" in a class attribute.
  assert.deepEqual(withShape({ className: 'go' }, false, null, undefined), { className: 'go' });
});

test('a button is a button, never a form submit', () => {
  const html = renderToStaticMarkup(createElement(Button, { tone: 'primary', children: 'Write' }));
  assert.match(html, /type="button"/, 'a <button> in a <form> submits it unless it says otherwise');
  assert.match(html, /class="btn btn primary"/);
});

/**
 * Nothing hand-writes a button family any more.
 *
 * Asserted from the sharp end rather than by counting call sites, the way
 * `test/modal.test.ts` asserts the backdrop: a button written the old way is a
 * button that misses whatever the button learns next — a disabled state, a
 * settled-flash ring, a specificity fix — and, worse, a hand-written `btn` is
 * single-class, so inside the console it draws as bare text. That is exactly the
 * failure nothing else in `npm run check` would see. `cn-btn` is banned too: the
 * console's family is gone, and a call site that reaches for it again is asking
 * for a second look the app no longer has.
 */
test('no surface writes a button family of its own', () => {
  const root = fileURLToPath(new URL('../web/src', import.meta.url));
  const owner = join(root, 'components', 'button.tsx');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith('.tsx') ? [path] : [];
    });
  // Every class the markup states, from both spellings: the literal attribute and
  // the template one. `${…}` holes are cut out rather than parsed — a hole cannot
  // be a bare family name, because the components resolve those.
  const classes = (src: string): string[] =>
    [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) =>
      (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/[\s'"?:]+/),
    );
  for (const path of walk(root)) {
    if (path === owner) continue;
    for (const cls of classes(readFileSync(path, 'utf8'))) {
      assert.ok(
        !['btn', 'cn-btn', 'armed'].includes(cls),
        `${path} writes the class "${cls}"; buttons come from components/button.tsx`,
      );
    }
  }
});
