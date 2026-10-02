import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const { Collapsible, FoldToggle } = await import('../web/src/components/collapsible.js');

// → docs/spec/17-cockpit.md#the-fold

const noop = (): void => {};

function toggle(open: boolean, extra: Partial<Parameters<typeof FoldToggle>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(FoldToggle, { subject: 'validation', open, onToggle: noop, label: 'Checks', ...extra }),
  );
}

test('a fold says which way it stands, in the chevron and in words', () => {
  const shut = toggle(false);
  assert.match(shut, /aria-expanded="false"/);
  assert.match(shut, /<i class="fold-caret" aria-hidden="true">/);
  assert.match(shut, /<span class="fold-hint">show<\/span>/);

  const open = toggle(true);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /<i class="fold-caret open" aria-hidden="true">/);
  assert.match(open, /<span class="fold-hint">hide<\/span>/);
});

test('a fold whose chevron is the whole control drops the word, and keeps its state for a reader', () => {
  const bare = toggle(false, { label: null, hint: false, title: 'Show the work under this feature' });
  assert.doesNotMatch(bare, /fold-hint/);
  assert.match(bare, /aria-expanded="false"/);
  assert.match(bare, /title="Show the work under this feature"/);
});

test('a shut fold keeps its body in the markup, hidden, as a details element did', () => {
  const html = renderToStaticMarkup(
    createElement(Collapsible, { subject: 'validation', title: 'About these checks', children: 'the body' }),
  );
  assert.match(html, /<section class="fold fold-inline is-shut">/);
  assert.match(html, /<div class="fold-body" id="[^"]+" hidden="">the body<\/div>/);
  const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
  assert.ok(controls !== undefined && html.includes(`id="${controls}"`), 'the press names the body it opens');
});

test('an open panel draws its body and the aside beside its title', () => {
  const html = renderToStaticMarkup(
    createElement(Collapsible, {
      subject: 'validation',
      look: 'panel',
      className: 'vq-band',
      defaultOpen: true,
      title: 'Ready for a run',
      aside: createElement('span', { className: 'vq-band-count' }, '2'),
      children: 'rows',
    }),
  );
  assert.match(html, /<section class="fold fold-panel is-open vq-band">/);
  assert.match(html, /<div class="fold-aside"><span class="vq-band-count">2<\/span><\/div>/);
  assert.doesNotMatch(html, /hidden=""/);
});

test('a fold the caller holds draws the caller’s state, whatever its default', () => {
  const held = renderToStaticMarkup(
    createElement(Collapsible, {
      subject: 'local-run',
      title: 'Output',
      open: false,
      defaultOpen: true,
      children: 'out',
    }),
  );
  assert.match(held, /is-shut/);
  assert.match(held, /aria-expanded="false"/);
});
