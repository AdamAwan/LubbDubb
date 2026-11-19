import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel, type CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions, ConsoleTab } from '../web/src/cockpit/actions.js';
import type { ListenItem } from '../web/src/types.js';
import { withAsks } from './support/asks.js';
import { repoPath, repoText } from './support/paths.js';
import { decode } from './support/html.js';
import { readPlace } from '../web/src/cockpit/place.js';

(globalThis as { React?: typeof React }).React = React;

const { buildFixtureState } = await import('./support/cockpitFixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalRefs.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

type State = CockpitView['state'];

function view(tab: ConsoleTab, mutate: (state: State) => void = () => {}): CockpitView {
  const state = buildFixtureState();
  mutate(state);
  return buildViewModel({
    state: withAsks(state),
    now: Date.now(),
    connected: true,
    setup: null,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    insightsView: 'economics',
    insightsWindow: '7d',
    selectedGoal: null,
    consolePanel: null,
    tab,
  });
}

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function render(v: CockpitView): string {
  return decode(
    renderToStaticMarkup(
      createElement(RefLinks, {
        refUrls: v.state.refUrls,
        openGoal: () => undefined,
        hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
        openPr: () => undefined,
        hasPr: (n: number) => hasPrPage(v.state, n),
        children: createElement(ConsoleRoot, { view: v, actions }),
      }),
    ),
  );
}

const page = (html: string): string => html.slice(html.indexOf('class="cn-ny"'));

test('the tab is reached at ?tab=needs and named on the bar with a new tag', () => {
  assert.equal(readPlace('?tab=needs').tab, 'needs');
  const html = render(view('overview'));
  assert.match(html, /Needs you<i class="cn-ny-new">new<\/i>/);
  assert.ok(html.indexOf('>Overview<') < html.indexOf('Needs you<i'), 'right after the overview');
});

test('the rail is absent on this tab and present on the overview', () => {
  const needs = render(view('needs'));
  assert.ok(!needs.includes('class="cn-rail"'), 'the page is the queue; the rail beside it would be the list twice');
  assert.ok(needs.includes('cn-body-railless'));
  assert.ok(needs.includes('class="cn-ny"'));
  const overview = render(view('overview'));
  assert.ok(overview.includes('class="cn-rail"'));
  assert.ok(!overview.includes('class="cn-ny"'));
});

test('the vivarium stays drawn on this tab, as on the cards overview', () => {
  const v = view('needs');
  if (v.state.pets === null) return;
  assert.ok(render(v).includes('cn-viv'));
});

test('the bar keeps the fleet controls on this tab, and the page carries a thin fleet strip', () => {
  const v = view('needs');
  const html = render(v);
  assert.ok(html.includes('fleet-control'), 'the controls stay on the bar');
  const strip = page(html);
  assert.ok(strip.includes('class="cn-ny-fleet"'));
  assert.ok(strip.includes(`${v.live.length} of ${v.state.control.cap} · ${v.upNext.length} queued`));
  assert.ok(v.live.length > 0, 'the fixture world has agents out');
  assert.ok(strip.includes('cn-ny-agent'), 'each live agent is named');
  const idle = view('needs', (state) => {
    state.agents = [];
  });
  assert.ok(page(render(idle)).includes('no agents out'));
  assert.ok(!render(view('overview')).includes('class="cn-ny-fleet"'));
});

test('the heading counts the asks and the pull requests, and the asks keep the rail tiers', () => {
  const v = view('needs');
  const html = page(render(v));
  assert.ok(v.needsYou.length > 0, 'the fixture world has asks');
  assert.match(html, /<h2>Needs you<\/h2><span class="cn-ny-counts">\d+ asks? · \d+ pull requests?<\/span>/);
  assert.ok(html.includes('Answer now') || html.includes('Yours to do'));
  assert.ok(html.includes('Handled for you'), 'the rail’s foot line is the column’s foot');
});

test('a pull request row carries its reasons as tags, counted against every open one', () => {
  const v = view('needs');
  const html = page(render(v));
  assert.ok(html.includes('Your review'), 'the fixture PR assigned to the operator');
  assert.ok(html.includes('Comments'));
  assert.match(html, /\d+ of \d+ open/);
  assert.ok(html.includes(`All ${v.state.world.pullRequests.length} open pull requests →`));
});

test('listening: a filled pill, and every Claude button sends', () => {
  const html = page(render(view('needs', (s) => (s.listener = { state: 'listening', on: null, queued: 0, sent: [] }))));
  assert.ok(html.includes('cn-ny-on">Claude is listening'));
  assert.ok(html.includes('Talk it through'));
  assert.ok(!html.includes('Open in Claude'));
  assert.ok(!html.includes('Start listen loop'));
});

test('busy: the pill names what the chat is on and what is queued', () => {
  const html = page(
    render(
      view('needs', (s) => {
        s.listener = { state: 'busy', on: { kind: 'pr', number: 412 }, queued: 1, sent: [] };
      }),
    ),
  );
  assert.match(html, /Claude is on <span class="ref-pair">.*?PR 412.*?<\/span> · 1 queued/);
  assert.ok(html.includes('Talk it through'));
});

test('off: a dashed pill, a deep link to start the loop, Copy, and deep links on every row', () => {
  const v = view('needs');
  const html = page(render(v));
  assert.ok(html.includes('cn-ny-off">No Claude chat listening'));
  assert.ok(html.includes('Start listen loop ↗'));
  assert.ok(html.includes('>Copy<'));
  assert.ok(html.includes(`q=${encodeURIComponent('/lubbdubb:listen').replace(/%20/g, '+')}`));
  assert.ok(html.includes('Open in Claude ↗'));
  assert.ok(!html.includes('Talk it through'));
  const ask = v.needsYou[0]!;
  assert.ok(html.includes(new URLSearchParams({ q: `/lubbdubb:next ${ask.id} only` }).toString()));
  assert.ok(html.includes(new URLSearchParams({ q: '/lubbdubb:pr 412' }).toString()));
});

test('off with no desktop folder: no deep links drawn, Copy still offered', () => {
  const html = page(render(view('needs', (s) => (s.config.desktopFolder = ''))));
  assert.ok(!html.includes('Open in Claude'));
  assert.ok(!html.includes('Start listen loop'));
  assert.ok(html.includes('>Copy<'));
});

test('a sent item draws the strip under its card', () => {
  const sentAt = new Date(Date.now() - 120_000).toISOString();
  const pr: ListenItem = { kind: 'pr', number: 412 };
  const html = page(
    render(
      view('needs', (s) => (s.listener = { state: 'listening', on: null, queued: 0, sent: [{ item: pr, sentAt }] })),
    ),
  );
  assert.ok(html.includes('In your Claude chat · sent 2m ago'));
});

test('only the Needs you page calls listenSend', () => {
  const plumbing = new Set(['web/src/api.ts', 'web/src/cockpit/actions.ts', 'web/src/cockpit/useCockpitActions.ts']);
  const walk = (dir: string): string[] =>
    readdirSync(repoPath(dir)).flatMap((name) => {
      const rel = `${dir}/${name}`;
      return statSync(repoPath(rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(name) ? [rel] : [];
    });
  const callers = walk('web/src').filter((file) => !plumbing.has(file) && /\blistenSend\b/.test(repoText(file)));
  assert.deepEqual(callers, ['web/src/console/NeedsYouPage.tsx']);
});
