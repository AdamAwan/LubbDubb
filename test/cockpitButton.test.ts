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
 * The drift it replaced was silent in the way this repo cares about. `.cn-btn`
 * was a single class inside `.cn`, where `console.css` resets its own markup with
 * `.cn button` at (0,1,1) — so `.cn-btn.cn-primary` at (0,2,0) drew correctly
 * while every plain console button beside it drew as bare text. The sheet was
 * valid, `npm run check` was green, and the console had one button family on the
 * screen in two shapes.
 * → `docs/spec/17-cockpit.md#the-button`
 */

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one.
(globalThis as { React?: typeof React }).React = React;

const { Button, buttonClass, withShape } = await import('../web/src/components/button.js');

test('one base class, chosen by family and never both', () => {
  assert.equal(buttonClass({}), 'btn');
  assert.equal(buttonClass({ family: 'console' }), 'cn-btn');
  // The bug this replaced: `AsyncButton` prepended `btn` to whatever string it
  // was handed, so a console-family async button went out wearing both.
  for (const look of [
    {},
    { family: 'console' as const },
    { tone: 'primary' as const, ghost: true, size: 'small' as const },
  ]) {
    const classes = buttonClass(look).split(' ');
    assert.equal(
      classes.filter((c) => c === 'btn' || c === 'cn-btn').length,
      1,
      `${JSON.stringify(look)} resolved to ${classes.join(' ')}`,
    );
  }
});

test('every weight is spelled in both families', () => {
  assert.equal(buttonClass({ tone: 'primary' }), 'btn primary');
  assert.equal(buttonClass({ tone: 'primary', family: 'console' }), 'cn-btn cn-primary');
  assert.equal(buttonClass({ tone: 'danger' }), 'btn danger');
  assert.equal(buttonClass({ tone: 'danger', family: 'console' }), 'cn-btn cn-danger');
  assert.equal(buttonClass({ ghost: true }), 'btn ghost');
  assert.equal(buttonClass({ ghost: true, family: 'console' }), 'cn-btn cn-ghost');
  assert.equal(buttonClass({ size: 'small' }), 'btn small');
  assert.equal(buttonClass({ size: 'small', family: 'console' }), 'cn-btn cn-small');
});

/**
 * The reason `ghost` is a weight and not a third tone: a control that destroys
 * something can also be the quiet one in its row, and two of `ConfirmButton`'s
 * call sites are exactly that. Spelled as a tone the two readings could not
 * combine, and those sites would have had to give up their red to stay quiet.
 */
test('a destructive button can also be a quiet one', () => {
  assert.equal(buttonClass({ tone: 'danger', ghost: true, size: 'small' }), 'btn danger ghost small');
});

test('shape rides beside the tone, never through it', () => {
  assert.equal(buttonClass({ ghost: true, className: 'work-root-head' }), 'btn ghost work-root-head');
  assert.deepEqual(withShape({ ghost: true }, 'go'), { ghost: true, className: 'go' });
  assert.deepEqual(withShape({ ghost: true, className: 'go' }, 'no'), { ghost: true, className: 'go no' });
  // A station's shape is conditional at every one of `HumanTaskActions`' sites,
  // and a false arm must not land as the word "false" in a class attribute.
  assert.deepEqual(withShape({ className: 'go' }, false, null, undefined), { className: 'go' });
});

test('a button is a button, never a form submit', () => {
  const html = renderToStaticMarkup(createElement(Button, { tone: 'primary', children: 'Write' }));
  assert.match(html, /type="button"/, 'a <button> in a <form> submits it unless it says otherwise');
  assert.match(html, /class="btn primary"/);
});

/**
 * Nothing hand-writes a button family any more.
 *
 * Asserted from the sharp end rather than by counting call sites, the way
 * `test/modal.test.ts` asserts the backdrop: a button written the old way is a
 * button that misses whatever the family learns next — a disabled state, a
 * settled-flash ring, a specificity fix — and that is exactly the failure nothing
 * else in `npm run check` would see.
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
