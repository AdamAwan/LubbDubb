import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the console's modules load so the test exercises the same sources.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');

function view(over: Partial<CockpitView> = {}): CockpitView {
  const state = buildDemoState().state;
  return {
    ...buildViewModel({
      state,
      now: Date.now(),
      connected: true,
      demo: true,
      selected: null,
      liveOutput: new Map(),
      tails: new Map(),
      lastPulseAt: Date.now(),
      viewingPlan: null,
      viewingRetro: null,
      viewingScratchpad: null,
      settingsOpen: false,
      spendOpen: false,
      reliabilityOpen: false,
      selectedGoal: null,
      consolePanel: null,
      backlogOpen: false,
    }),
    ...over,
  };
}

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

const render = (v: CockpitView) => renderToStaticMarkup(createElement(ConsoleRoot, { view: v, actions }));

test('nothing under console/ imports the api module', () => {
  const dir = new URL('../web/src/console/', import.meta.url).pathname;
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/from '.*\/api\.js'/.test(src), `${file} reaches api.js — every mutation belongs on CockpitActions`);
  }
});

test('console.css never targets a shared component’s class', () => {
  const css = readFileSync(new URL('../web/src/console/console.css', import.meta.url).pathname, 'utf8');
  for (const cls of ['.escalation-card', '.recovery-panel', '.findings-panel', '.human-task-actions']) {
    assert.ok(!css.includes(cls), `console.css styles ${cls}; shared components restyle through tokens only`);
  }
});

test('a dropped socket draws no gauge, no rail and no situation area', () => {
  const html = render(view({ connected: false }));
  assert.ok(html.includes('Off the air'));
  assert.ok(!html.includes('cn-rail'), 'the rail must not render while offline');
  assert.ok(!html.includes('cn-sit'), 'the situation area must not render while offline');
});

test('the recovery banner sits outside the situation area', () => {
  const html = render(view({ crashed: [{ taskId: 't1' }] as CockpitView['crashed'] }));
  const banner = html.indexOf('cn-recovery');
  const sit = html.indexOf('cn-sit');
  assert.ok(banner !== -1, 'a held harness must draw its banner');
  assert.ok(banner < sit, 'the banner belongs above the situation area, not inside it');
});
