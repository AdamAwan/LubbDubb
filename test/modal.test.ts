import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { repoPath } from './support/paths.js';

(globalThis as { React?: typeof React }).React = React;

type Listener = (event: { key: string }) => void;
const listeners = new Set<Listener>();
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
  removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
};

const { Modal, armDismiss } = await import('../web/src/components/Modal.js');

function press(key: string): void {
  for (const fn of [...listeners]) fn({ key });
}

test('Escape closes the layer on top, and hands back to the one behind it', () => {
  const closed: string[] = [];
  const disarmHost = armDismiss(() => closed.push('host'));
  const disarmNested = armDismiss(() => closed.push('nested'));

  press('Escape');
  assert.deepEqual(closed, ['nested']);

  disarmNested();
  press('Escape');
  assert.deepEqual(closed, ['nested', 'host']);

  disarmHost();
  press('Escape');
  assert.deepEqual(closed, ['nested', 'host'], 'a disarmed layer still answers the key');
  assert.equal(listeners.size, 0, 'a disarmed layer left its listener on the window');
});

test('only Escape dismisses', () => {
  const closed: string[] = [];
  const disarm = armDismiss(() => closed.push('x'));
  press('Enter');
  press('Escape');
  disarm();
  assert.deepEqual(closed, ['x']);
});

test('the head, the foot and the guard are drawn once, for every caller', () => {
  const html = renderToStaticMarkup(
    createElement(
      Modal,
      {
        face: 'modal',
        title: 'Raise a bug',
        lead: createElement('span', { className: 'chip small' }, '#41'),
        chips: createElement('span', { className: 'chip small' }, 'checking'),
        foot: createElement('button', null, 'raise bug'),
        onClose: () => {},
      },
      createElement('p', null, 'body'),
    ),
  );
  assert.match(html, /class="plan-modal-backdrop"/);
  assert.match(html, /class="plan-modal"/);
  assert.match(html, /class="hdr pm-head"/);
  assert.match(html, /class="pm-title">Raise a bug</);
  assert.match(html, /class="btn btn ghost small pm-close"/);
  assert.match(html, /class="pm-foot"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Raise a bug"/);
  const title = html.indexOf('class="pm-title"');
  assert.ok(html.indexOf('#41') < title);
  assert.ok(html.indexOf('checking') > title);
  assert.ok(html.indexOf('pm-foot') > html.indexOf('body'));
});

test('each face draws its own pair of classes', () => {
  const faces = [
    ['modal', 'plan-modal-backdrop', 'plan-modal'],
    ['sheet', 'plan-modal-backdrop', 'plan-sheet'],
    ['drawer', 'drawer-backdrop', 'drawer'],
    ['panel', 'cn-backdrop', 'cn-panel'],
    ['hatch', 'cn-backdrop', 'cn-hatch'],
    ['prompt', 'prompt-backdrop', 'prompt-modal'],
  ] as const;
  for (const [face, backdrop, surface] of faces) {
    const html = renderToStaticMarkup(createElement(Modal, { face, onClose: () => {} }));
    assert.match(html, new RegExp(`class="${backdrop}"`), `${face} lost its backdrop`);
    assert.match(html, new RegExp(`class="${surface}"`), `${face} lost its surface`);
  }
  assert.match(renderToStaticMarkup(createElement(Modal, { face: 'panel', onClose: () => {} })), /<section/);
});

test('no surface writes a backdrop of its own', () => {
  const root = repoPath('web/src');
  const owner = join(root, 'components', 'Modal.tsx');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith('.tsx') ? [path] : [];
    });
  for (const path of walk(root)) {
    if (path === owner) continue;
    const src = readFileSync(path, 'utf8');
    for (const cls of ['plan-modal-backdrop', 'cn-backdrop', 'drawer-backdrop', 'prompt-backdrop']) {
      assert.ok(!src.includes(cls), `${path} writes ${cls}; overlays come from components/Modal.tsx`);
    }
  }
});
