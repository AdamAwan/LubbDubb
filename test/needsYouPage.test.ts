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
const { askFamilies, FAMILY_LABEL } = await import('../web/src/view/askFamilies.js');
const { prHeadline } = await import('../web/src/view/prHeadline.js');
const { assignedToYou } = await import('../web/src/view/prsOnYou.js');

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

test('the bar keeps the fleet controls on this tab, and the fleet is a column of its own', () => {
  const v = view('needs');
  const html = render(v);
  assert.ok(html.includes('fleet-control'), 'the controls stay on the bar');
  const cols = page(html);
  assert.ok(cols.includes('cn-ny-fleet"'));
  assert.ok(cols.includes(`<b>${v.live.length}</b> of ${v.state.control.cap} out`));
  assert.ok(cols.includes(`${v.upNext.length} queued`));
  assert.ok(v.live.length > 0, 'the fixture world has agents out');
  assert.equal(cols.split(/class="cn-ny-agent[ "]/).length - 1, v.live.length, 'every live agent is a card');
  const idle = view('needs', (state) => {
    state.agents = [];
  });
  assert.ok(page(render(idle)).includes('No agents out.'));
  assert.ok(!render(view('overview')).includes('cn-ny-fleet"'));
});

test('the heading counts the asks and the pull requests, and the asks are grouped by family', () => {
  const v = view('needs');
  const html = page(render(v));
  assert.ok(v.needsYou.length > 0, 'the fixture world has asks');
  assert.match(html, /<h2>Needs you<\/h2><span class="cn-ny-counts">\d+ asks? · \d+ pull requests?<\/span>/);
  for (const group of askFamilies(v.needsYou)) {
    assert.ok(html.includes(`${FAMILY_LABEL[group.family]} <i class="cn-n">${group.rows.length}</i>`));
  }
  const now = v.needsYou.filter((row) => row.urgency === 'now').length;
  assert.equal(
    html.split('cn-ny-nowdot" title="Answer now').length - 1,
    now,
    'every ask the fleet is stopped on says so on its card',
  );
  assert.ok(html.includes('Handled for you'), 'the rail’s foot line is the column’s foot');
});

test('askFamilies keeps the queue’s order inside a family and drops empty families', () => {
  const v = view('needs');
  const groups = askFamilies(v.needsYou);
  assert.equal(
    groups.reduce((n, g) => n + g.rows.length, 0),
    v.needsYou.length,
    'an ask was lost or drawn twice',
  );
  for (const group of groups) {
    assert.ok(group.rows.length > 0);
    const order = group.rows.map((row) => v.needsYou.indexOf(row));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      `${group.family} re-sorted the queue`,
    );
  }
});

test('a pull request card leads with its first reason, and the column links every open one', () => {
  const v = view('needs');
  const html = page(render(v));
  assert.ok(html.includes('cn-prcard-lead cn-ink-red">Your review<'), 'the fixture PR assigned to the operator');
  assert.ok(html.includes('cn-prcard-lead cn-ink-blue">Comments<'));
  assert.ok(html.includes(`All ${v.state.world.pullRequests.length} open →`));
});

test('the pull requests assigned to you and your own are two boxes', () => {
  const v = view('needs');
  const html = page(render(v));
  const assigned = html.indexOf('Assigned to you');
  const own = html.indexOf('Your pull requests');
  assert.ok(assigned > 0 && own > assigned, 'the two boxes are not drawn, assigned first');
  for (const pr of v.state.world.pullRequests) {
    const at = html.indexOf(`>${prHeadline(pr.title)}</button>`);
    if (at < 0) continue;
    assert.equal(at < own, assignedToYou(pr), `#${pr.number} is in the wrong box`);
  }
});

test('the pull requests are grouped under their goal and a stack drawn as one block, as on the overview', () => {
  const v = view('needs', (s) => {
    for (const pr of s.world.pullRequests) {
      if (pr.branch.startsWith('issue/390/')) pr.attention = { ...pr.attention, status: 'you' };
    }
  });
  const prs = page(render(v)).split('Your pull requests')[1] ?? '';
  const goal = goalIssue(v.state, 'issue:390');
  assert.ok(goal, 'the fixtures must carry goal #390');
  const head = prs.indexOf(`<span class="cn-group-t">${goal.title}</span>`);
  assert.ok(head >= 0, 'no heading names goal #390');
  const payment = v.state.world.pullRequests.find((pr) => pr.branch === 'issue/390/payment');
  const refunds = v.state.world.pullRequests.find((pr) => pr.branch === 'issue/390/refunds');
  assert.ok(payment && refunds, 'the fixtures must carry a two-PR stack on #390');
  const bottom = prs.indexOf(prHeadline(payment.title));
  const top = prs.indexOf(prHeadline(refunds.title));
  assert.ok(head < bottom && bottom < top, 'the stack is not drawn base first under its goal');
  assert.ok(prs.slice(head, bottom).includes('cn-prstack'), 'the stack is not drawn as one block');
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
