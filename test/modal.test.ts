import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The cockpit's one overlay — `web/src/components/Modal.tsx`.
 *
 * The bug it replaced was silent in the way this repo cares about: thirteen
 * surfaces hand-wrote the same backdrop, and eleven of them forgot Escape. Every
 * one rendered correctly, every check was green, and a modal covering the goal an
 * operator was reading could only be dismissed by finding one small button.
 * → `docs/spec/17-cockpit.md#the-modal`
 */

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the overlay's module loads so the test exercises the same source.
(globalThis as { React?: typeof React }).React = React;

type Listener = (event: { key: string }) => void;
const listeners = new Set<Listener>();
// `armDismiss` is the only thing in the module that reaches a browser global, and
// it reaches it when it is *called* — so a stub standing in for the window is
// enough, and no DOM implementation is dragged into the test run.
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

  // The whole point of doing this once: a template viewer inside the settings
  // page, or a questionnaire inside a "Needs you" panel, must not take its host
  // down with it.
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
  // The head is a `HeadRow` now — the shared row, wearing the modal's own modifier.
  assert.match(html, /class="hdr pm-head"/);
  assert.match(html, /class="pm-title">Raise a bug</);
  // `btn` twice is the base, not a slip: `.btn.btn` is what outranks
  // `console.css`'s `.cn button` reset, and it only does so if the markup carries
  // the class twice. → docs/spec/17-cockpit.md#the-button
  assert.match(html, /class="btn btn ghost small pm-close"/);
  assert.match(html, /class="pm-foot"/);
  // The name is the visible title where there is one, so no caller has to repeat it.
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Raise a bug"/);
  // The head leads with what the modal is about and trails with what state it is in.
  const title = html.indexOf('class="pm-title"');
  assert.ok(html.indexOf('#41') < title);
  assert.ok(html.indexOf('checking') > title);
  // The foot is the last child of the surface, so it never scrolls away.
  assert.ok(html.indexOf('pm-foot') > html.indexOf('body'));
});

/**
 * The face is a prop, and the two token families stay two.
 *
 * `--cn-*` and the shared family are a real distinction rather than a namespace
 * (17 — Tokens), so the overlay names which face it wears and neither sheet has to
 * learn the other's class names.
 */
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
  // The console's panel is a <section>, and stays one.
  assert.match(renderToStaticMarkup(createElement(Modal, { face: 'panel', onClose: () => {} })), /<section/);
});

/**
 * Nothing hand-writes a backdrop any more.
 *
 * Asserted from the sharp end rather than by counting call sites: a fourteenth
 * modal written the old way is a modal Escape does not close, and that is exactly
 * the failure nothing else in `npm run check` would see.
 */
test('no surface writes a backdrop of its own', () => {
  const root = fileURLToPath(new URL('../web/src', import.meta.url));
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
