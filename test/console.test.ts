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
const { Panel } = await import('../web/src/console/Panel.js');

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

/** `renderToStaticMarkup` escapes text nodes, so an assertion on fixture prose must decode first. */
function decode(html: string): string {
  // &amp; must decode last — decoding it first would turn a literal `&amp;lt;`
  // into `<`, which is a different string than the page actually renders.
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

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

test('decode reverses text-node escaping, and only in that order', () => {
  // &amp; last: decoding it first would turn a literal `&amp;lt;` into `<`,
  // which is not what the page rendered.
  assert.equal(decode('&amp;lt;'), '&lt;');
  assert.equal(decode('&#x27;'), "'");
});

test('a panel draws its backdrop and its close button, both of them ways out', () => {
  // The third way out is Escape, registered in an effect. `renderToStaticMarkup`
  // runs no effects, so the listener is out of reach here — the two exits that
  // are in the markup are the ones this pins.
  const html = renderToStaticMarkup(
    createElement(Panel, {
      title: 'Findings',
      onClose: () => undefined,
      children: createElement('p', null, 'body'),
    }),
  );

  assert.ok(html.includes('cn-backdrop'), 'the backdrop is an exit and must be drawn');
  assert.ok(html.includes('Close'), 'the button is an exit and must be drawn');
  assert.ok(html.includes('Findings'));
  assert.ok(html.includes('body'), 'a panel draws what it was handed');
});

test('the rail carries every blocking kind in one list', () => {
  const html = render(view());
  const v = view();
  assert.ok(v.needsYou.length > 0, 'the demo fixtures must carry at least one ask');
  const decoded = decode(html);
  for (const row of v.needsYou) assert.ok(decoded.includes(row.title), `the rail dropped ${row.kind}`);
});

test('a row states what it is holding, and a row holding nothing draws no count', () => {
  const rows = [
    {
      id: 'a',
      kind: 'escalation',
      group: 'blocking',
      title: 'Holds two',
      goalRef: 'issue:1',
      agentId: 'a1',
      holding: 2,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'b',
      kind: 'bench',
      group: 'yours',
      title: 'Holds nothing',
      goalRef: 'issue:1',
      agentId: null,
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  assert.ok(html.includes('holding 2 parts'));
  assert.ok(!html.includes('holding 0'), 'a zero is not a reading — draw no count');
});

test('an empty queue collapses the rail rather than removing it', () => {
  const html = render(view({ needsYou: [] }));
  assert.ok(html.includes('cn-rail'), 'a surface that vanishes when quiet reads as one that broke');
  assert.ok(html.includes('cn-rail-empty'));
});

test('a group with no rows draws no heading; a group with rows draws its own', () => {
  const blockingOnly = [
    {
      id: 'a',
      kind: 'escalation',
      group: 'blocking',
      title: 'Only blocking',
      goalRef: 'issue:1',
      agentId: 'a1',
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];
  const bothGroups = [
    ...blockingOnly,
    {
      id: 'b',
      kind: 'bench',
      group: 'yours',
      title: 'Yours too',
      goalRef: 'issue:1',
      agentId: null,
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const onlyHtml = render(view({ needsYou: blockingOnly }));
  assert.ok(onlyHtml.includes('Blocking'), 'the non-empty group must draw its heading');
  assert.ok(!onlyHtml.includes('Yours to do'), 'an empty group must draw no heading');

  const bothHtml = render(view({ needsYou: bothGroups }));
  assert.ok(bothHtml.includes('Blocking'));
  assert.ok(bothHtml.includes('Yours to do'), 'both groups present must draw both headings');
});

test('the rail renders array order within a group, never a re-sort', () => {
  // Deliberately out of canonical order: a `yours` row before `blocking`, and
  // the lower-holding blocking row before the higher-holding one — the rail
  // must not undo either choice.
  const rows = [
    {
      id: 'yours-1',
      kind: 'bench',
      group: 'yours',
      title: 'Yours first in the array',
      goalRef: 'issue:1',
      agentId: null,
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'blocking-low',
      kind: 'escalation',
      group: 'blocking',
      title: 'Blocking low holder',
      goalRef: 'issue:2',
      agentId: 'a1',
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'blocking-high',
      kind: 'escalation',
      group: 'blocking',
      title: 'Blocking high holder',
      goalRef: 'issue:3',
      agentId: 'a2',
      holding: 5,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  const yoursPos = html.indexOf('Yours first in the array');
  const lowPos = html.indexOf('Blocking low holder');
  const highPos = html.indexOf('Blocking high holder');

  assert.ok(yoursPos !== -1 && lowPos !== -1 && highPos !== -1, 'every row must still render');
  // Within the blocking group, array order (low before high) is preserved —
  // a re-sort by holding would put the high-holder first.
  assert.ok(lowPos < highPos, 'the blocking group must keep array order, not re-sort by holding');
});

test('a row with a goalRef is a button; the recovery hold (no goalRef) is not', () => {
  const rows = [
    {
      id: 'clickable',
      kind: 'escalation',
      group: 'blocking',
      title: 'Opens a goal',
      goalRef: 'issue:9',
      agentId: 'a1',
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: 'Answered on the banner above',
      goalRef: null,
      agentId: null,
      holding: 0,
      raisedAt: '',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));

  // The row wrapper is the element opening `class="cn-q "` or `class="cn-q
  // cn-urgent"` — the trailing space after `cn-q` rules out `cn-qin`/`cn-qkind`,
  // which are unrelated inner elements that happen to share the `cn-q` prefix.
  const rowWrapper = (title: string): string => {
    const titlePos = html.indexOf(title);
    assert.ok(titlePos !== -1, `row "${title}" must render`);
    const before = html.slice(0, titlePos);
    // Attribute order differs between the two tags (`<button type="button"
    // class="…">` vs `<div class="…">`), so match the whole opening tag and
    // check its attributes rather than assuming `class` comes first.
    const matches = [...before.matchAll(/<(button|div)\b([^>]*)>/g)].filter(([, , attrs]) =>
      /class="cn-q (?:cn-urgent)?"/.test(attrs ?? ''),
    );
    const last = matches.at(-1);
    assert.ok(last, `no cn-q wrapper found before "${title}"`);
    const tag = last[1];
    assert.ok(tag, `unmatched capture group for "${title}"`);
    return tag;
  };

  assert.equal(rowWrapper('Opens a goal'), 'button', 'a row with a goalRef is a button');
  assert.equal(
    rowWrapper('Answered on the banner above'),
    'div',
    'the recovery row has no goalRef and must not be wrapped in a button',
  );
});
