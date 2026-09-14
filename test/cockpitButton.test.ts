import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { repoPath } from './support/paths.js';

(globalThis as { React?: typeof React }).React = React;

const { Button, buttonClass, expected, refusing } = await import('../web/src/components/button.js');

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
  assert.equal(buttonClass({ tone: 'secondary', ghost: true }), buttonClass({ ghost: true }));
});

test('a destructive button can also be a quiet one', () => {
  assert.equal(buttonClass({ tone: 'danger', ghost: true, size: 'small' }), 'btn btn danger ghost small');
});

test('shape rides beside the tone, never through it', () => {
  assert.equal(buttonClass({ ghost: true, className: 'work-root-head' }), 'btn btn ghost work-root-head');
});

/**
 * The verb a row expects and the one that refuses are *tones*, and the reason is
 * that they were classes with no rule behind them: `Done` drew identically to
 * `Decline` on every surface embedding the row. A tone resolves to a rule that is
 * already written, so the assertion is that each reaches the sheet.
 */
test('the verb a row expects is a tone, so it reaches a rule', () => {
  assert.deepEqual(expected({}), { tone: 'primary' });
  assert.deepEqual(refusing({}), { tone: 'danger' });
  assert.equal(buttonClass(expected({})), 'btn btn primary');
  assert.equal(buttonClass(refusing({})), 'btn btn danger');
  assert.notEqual(buttonClass(expected({})), buttonClass({}), 'the expected verb must not draw as the plain one');
});

test('the station composes on the caller, keeping the caller’s weight', () => {
  assert.deepEqual(expected({ ghost: true, size: 'small' }), { ghost: true, size: 'small', tone: 'primary' });
  assert.equal(buttonClass(expected({ ghost: true, size: 'small' })), 'btn btn primary ghost small');
  // The caller's own tone is what the station overrides, and only that.
  assert.deepEqual(expected({ tone: 'secondary' }), { tone: 'primary' });
});

test('a button is a button, never a form submit', () => {
  const html = renderToStaticMarkup(createElement(Button, { tone: 'primary', children: 'Write' }));
  assert.match(html, /type="button"/, 'a <button> in a <form> submits it unless it says otherwise');
  assert.match(html, /class="btn btn primary"/);
});

test('no surface writes a button family of its own', () => {
  const root = repoPath('web/src');
  const owner = join(root, 'components', 'button.tsx');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith('.tsx') ? [path] : [];
    });
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
