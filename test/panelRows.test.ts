import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { Overview, queueRow } = await import('../web/src/console/Overview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

function view(over: Partial<CockpitView['state']> = {}): CockpitView {
  const state = { ...buildDemoState().state, ...over };
  return buildViewModel({
    state,
    now: Date.now(),
    connected: true,
    demo: true,
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
    tab: 'overview',
  });
}

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

const ROW = /class="cn-row[ "]/g;

const render = (v: CockpitView): string =>
  renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: createElement(Overview, { view: v, actions }),
    }),
  );

test('every pull-request row carries a way to the pull request it names', () => {
  const html = render(view());
  const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Build'));
  const rows = rack.split(ROW).slice(1);
  assert.ok(rows.length > 0, 'no pull-request rows rendered');
  for (const row of rows) {
    const at = row.indexOf('cn-refs');
    assert.ok(at > 0, 'a pull-request row has no refs slot at all');
    const slot = row.slice(at);
    assert.match(slot, /#\d+/, "a pull-request row's refs slot is empty");
  }
});

test('the why marker holds prose, never a reference and never a control', () => {
  const html = render(view());
  const tips = html
    .split('class="cn-why-tip"')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('</span>')));
  assert.ok(tips.length > 0, 'no reason was drawn at all');
  for (const tip of tips) {
    assert.ok(!tip.includes('<a '), 'a reason must not carry a link');
    assert.ok(!tip.includes('<button'), 'a reason must not carry a control');
  }
});

test('every row of a card sits on that card’s own grid', () => {
  const html = render(view());
  const cards = html.split('class="cn-card').slice(1);
  let checked = 0;
  for (const card of cards) {
    const templates = card
      .split('class="cn-row cn-frow')
      .slice(1)
      .map((chunk) => /style="(?:grid-template-columns|--cn-cols-stacked):([^";]+)/.exec(chunk.slice(0, 400)));
    if (templates.length === 0) continue;
    for (const found of templates) {
      assert.ok(found, 'a facts row carries no grid template — the rail is a flex line again');
      assert.match(found[1] ?? '', /var\(--cn-w-/, 'the rail’s widths come from the sheet, not from a literal here');
    }
    const first = templates[0]?.[1];
    for (const found of templates) {
      assert.equal(found?.[1], first, 'two rows of one card are on different grids');
    }
    checked += 1;
  }
  assert.ok(checked >= 3, `only ${checked} cards drew rows — this test is about the ones that do`);
});

test('a fleet row wears the state it is in, and the strongest one it is in', () => {
  const base = buildDemoState().state;
  const live = base.agents.filter((a) => a.endedAt === null);
  const waiting = live.find((a) => a.status === 'waiting');
  assert.ok(live[0] && waiting, 'the fixtures must carry a live agent and a waiting one');

  const chips = (over: Partial<CockpitView['state']>): string[] => {
    const html = render(view(over));
    const fleet = html.slice(html.indexOf('Fleet'), html.indexOf('Goals in flight'));
    return [...fleet.matchAll(/cn-why-chip tag(?: t-(\w+))?[^"]*"[^>]*>([^<]+)</g)].map(
      (m) => `${m[2]}:${m[1] ?? 'quiet'}`,
    );
  };

  assert.ok(chips({}).includes('question:red'), 'an agent with an open escalation asks you something');

  const noAsks = { escalations: [] };
  assert.ok(chips({ ...noAsks, parkedOnLimit: [live[0].id] }).includes('limit:amber'), 'a limit park says so');
  assert.ok(
    chips({
      ...noAsks,
      stallParks: [{ agentId: live[0].id, expiresAt: new Date(Date.now() + 9e5).toISOString() }],
    }).includes('stalled:amber'),
    'a stall park says so',
  );
  assert.ok(chips(noAsks).includes('blocked:amber'), 'a plain wait says so');

  const ranked = chips({ ...noAsks, parkedOnLimit: live.filter((a) => a.status === 'waiting').map((a) => a.id) });
  assert.ok(ranked.includes('limit:amber'), `the park outranks the wait — got ${ranked.join(', ')}`);
  assert.ok(!ranked.includes('blocked:amber'), 'and the row wears one word, not both');
});

test('a pull-request row keeps the court’s reasons and wears none of its words', () => {
  const state = buildDemoState().state;
  const html = render(view());
  const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Build'));
  const rows = rack.split(ROW).slice(1);
  const open = state.world.pullRequests;
  const drawn = [
    ...open.filter((pr) => pr.attention.assignedToYou !== undefined),
    ...open.filter((pr) => pr.attention.assignedToYou === undefined),
  ];
  assert.equal(rows.length, open.length, 'every open pull request is drawn');
  assert.ok(!rack.includes('cn-why-chip'), 'the rack drew a state word');
  for (const [i, row] of rows.entries()) {
    const pr = drawn[i];
    assert.ok(pr, 'the fixtures line up with the rows');
    assert.ok(!row.includes(`>${pr.attention.status}</button>`), `#${pr.number} still wears its court as a word`);
    const unwatched = pr.attention.status === 'unwatched';
    if (pr.attention.reasons.length > 0 && !unwatched) {
      assert.ok(row.includes('cn-said'), `#${pr.number} lost the court’s reasons with the word`);
    }
    if (unwatched) assert.ok(!row.includes('cn-rowsub'), `#${pr.number} is unwatched and still drew a sub-line`);
    const eye = row.indexOf('cn-eye');
    const subject = row.indexOf('cn-grow');
    assert.ok(eye > 0, `#${pr.number} draws no watch switch`);
    assert.ok(eye > subject, `#${pr.number} still draws its switch ahead of the subject`);
    for (const mark of [/class="ck /, /class="ck-slot"/, /class="rv /, /class="pk /]) {
      const found = mark.exec(row);
      if (found !== null) assert.ok(eye < found.index, `#${pr.number} draws its switch behind the readings`);
    }
  }
});

test('a pull-request row draws the agent on its branch instead of its checks', () => {
  const state = buildDemoState().state;
  const live = state.agents.filter((a) => a.endedAt === null);
  const branches = new Set(
    live.map((a) => state.tasks.find((t) => t.id === a.taskId)?.branch).filter((b) => b != null),
  );
  const staffed = state.world.pullRequests.filter((pr) => branches.has(pr.branch));
  assert.ok(staffed.length > 0, 'the fixtures must put an agent on an open pull request’s branch');

  const rowFor = (html: string, title: string): string => {
    const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Build'));
    const found = rack.split(ROW).find((chunk) => chunk.includes(title));
    assert.ok(found, `no row drew "${title}"`);
    return found.slice(0, found.indexOf('cn-refs'));
  };

  const html = render(view());
  for (const pr of staffed) {
    const row = rowFor(html, pr.title);
    assert.match(row, /cn-onit/, `#${pr.number} has an agent on its branch and does not say so`);
    assert.ok(!row.includes('"ck '), `#${pr.number} draws its checks beside a live agent`);
  }

  const quiet = render(
    view({ agents: state.agents.map((a) => ({ ...a, endedAt: a.endedAt ?? new Date().toISOString() })) }),
  );
  assert.ok(!quiet.includes('cn-onit'), 'a finished agent still holds a pull request');
  for (const pr of staffed) assert.match(rowFor(quiet, pr.title), /"ck /, `#${pr.number} lost its checks`);
});

test('the agent mark is the row’s first slot, on both racks', () => {
  const state = buildDemoState().state;
  const html = render(view());
  const racks = {
    'Goals in flight': html.slice(html.indexOf('Goals in flight'), html.indexOf('Pull requests')),
    'Pull requests': html.slice(html.indexOf('Pull requests'), html.indexOf('Build')),
  };

  assert.equal(html.split('cn-lamp-mark').length - 1, 2, 'the lamp column is widened on the wrong number of cards');

  for (const [name, rack] of Object.entries(racks)) {
    const staffed = rack.split(ROW).filter((row) => row.includes('cn-onit'));
    assert.ok(staffed.length > 0, `the fixtures must put an agent on a row of ${name}`);
    for (const row of staffed) {
      assert.ok(row.indexOf('cn-onit') < row.indexOf('cn-grow'), `a ${name} row draws the mark after its subject`);
      assert.ok(
        !/cn-slot[^"]*">(?!<button[^>]*cn-onit)[\s\S]{1,80}?cn-onit/.test(row),
        `a ${name} row puts something ahead of the mark in the row's first slot`,
      );
    }
  }

  const quiet = render(
    view({ agents: state.agents.map((a) => ({ ...a, endedAt: a.endedAt ?? new Date().toISOString() })) }),
  );
  assert.ok(!quiet.includes('cn-onit'), 'a finished agent still holds a row');
});

test('the agent mark says what it is without spelling it out', () => {
  const html = render(view());
  assert.ok(html.includes('cn-onit'), 'the fixtures must put an agent on a row');
  assert.ok(!html.includes('agent on it'), 'the mark is back to spelling itself out on every row');
  assert.match(html, /class="cn-onit"[^>]*aria-label="Agent on it/, 'the mark carries no accessible name');
  assert.match(html, /class="cn-onit-dot"><svg/, 'the mark drew no glyph');
});

test('a goal row wears its pickup verdict in words, not as an enum', () => {
  const state = buildDemoState().state;
  const html = render(view());
  const card = html.slice(html.indexOf('Goals in flight'), html.indexOf('Pull requests'));
  const rows = card.split(ROW).slice(1);
  assert.ok(rows.length > 0, 'the fixtures must put a goal in flight');
  assert.ok(!card.includes('>pickup<'), 'the pickup verdict is still drawn as a fact as well');

  const inFlight = state.world.issues.filter((issue) => card.includes(`#${issue.number} ${issue.title}`));
  assert.ok(
    inFlight.some((issue) => issue.pickup.status === 'has_pr'),
    'the fixtures must exercise a status whose identifier is not a phrase',
  );
  for (const issue of inFlight) {
    const row = rows.find((chunk) => chunk.includes(`#${issue.number} ${issue.title}`));
    assert.ok(row, `no row drew goal #${issue.number}`);
    assert.ok(!/>[a-z]+_[a-z]+</.test(row), `goal #${issue.number} shows an identifier where a word belongs`);
  }
});

test('a goal row says so while an agent is on it', () => {
  const state = buildDemoState().state;
  const card = (html: string): string => html.slice(html.indexOf('Goals in flight'), html.indexOf('Pull requests'));

  const html = render(view());
  const rows = card(html).split(ROW).slice(1);
  const staffed = rows.filter((row) => row.includes('cn-onit'));
  assert.ok(staffed.length > 0, 'the fixtures must put an agent on a goal whose origin is a pull request');
  for (const row of staffed) assert.match(row, /cn-live/, 'a goal says an agent is on it and does not wear it');

  const quiet = render(
    view({ agents: state.agents.map((a) => ({ ...a, endedAt: a.endedAt ?? new Date().toISOString() })) }),
  );
  assert.ok(!card(quiet).includes('cn-onit'), 'a finished agent still holds a goal');
});

test('a finished retained run is behind the kept disclosure, not among the goals in flight', () => {
  const state = buildDemoState().state;
  const retained = state.retainedRuns ?? [];
  assert.ok(retained.length > 0, 'the fixtures must carry a retained run');
  const kept = retained[0]!;

  const html = render(view());
  const goals = html.slice(html.indexOf('Goals in flight'), html.indexOf('Pull requests'));
  for (const issue of retained) {
    assert.ok(
      !goals.includes(`#${issue.number} ${issue.title}`),
      `retained run #${issue.number} is listed as a goal in flight with no work on it`,
    );
  }
  assert.match(goals, /kept/, 'the kept runs have no way in');

  const live = state.agents.find((a) => a.endedAt === null);
  assert.ok(live, 'the fixtures must have an agent out');
  const busy = render(
    view({
      tasks: state.tasks.map((t) => (t.id === live.taskId ? { ...t, originRef: `issue:${kept.number}` } : t)),
    }),
  );
  assert.ok(
    busy
      .slice(busy.indexOf('Goals in flight'), busy.indexOf('Pull requests'))
      .includes(`#${kept.number} ${kept.title}`),
    'a retained run with an agent on it is not drawn as in flight',
  );
});

test('a queued row quotes the queue: its status as the word, its reason as the sentence', () => {
  const v = view();
  const items = v.state.upcoming?.items ?? [];
  assert.ok(items.length > 0, 'the fixtures must carry a queued item');
  for (const item of items) {
    const row = queueRow(item, v, actions);
    assert.equal(row.whyLabel, item.status, `#${item.origin} wears a word the queue did not say`);
    assert.equal(row.why, item.reason, `#${item.origin} re-worded the queue's reason`);
    assert.equal(row.queued, true, 'a queued row is drawn as an agent');
  }
  const asks = items.filter((i) => i.status === 'unapproved');
  for (const item of asks) assert.equal(queueRow(item, v, actions).whyTone, 'ask');
  for (const item of items.filter((i) => i.status !== 'unapproved' && i.status !== 'dispatching')) {
    assert.equal(queueRow(item, v, actions).whyTone, 'hold');
  }
});

test('the fleet card’s rows are a budget the agents spend first', () => {
  const state = buildDemoState().state;
  const queued = state.upcoming?.items.length ?? 0;
  assert.ok(queued > 1, 'the fixtures must carry more than one queued item');
  const live = state.agents.filter((a) => a.endedAt === null);
  assert.ok(live[0], 'the fixtures must have an agent out');

  const card = (html: string): string => html.slice(html.indexOf('Fleet'), html.indexOf('Goals in flight'));
  const rows = (html: string): number => card(html).split(ROW).length - 1;
  const queuedRows = (html: string): number => card(html).split(/class="cn-row[^"]*cn-queued/).length - 1;

  const fleet = (n: number): { drawn: number; queue: number; room: number } => {
    const v = view({ agents: Array.from({ length: n }, (_, i) => ({ ...live[0]!, id: `a${i}` })) });
    // An ejected slot spends a row like any other: it is held, and the queue gets
    // what is left. → `Fleet`
    const out = v.live.length + v.readying.length + v.deskRuns.length + v.ejected.length;
    const html = render(v);
    return { drawn: rows(html), queue: queuedRows(html), room: Math.max(0, 7 - out) };
  };

  for (const n of [1, 4, 6, 7, 9]) {
    const { drawn, queue, room } = fleet(n);
    assert.equal(queue, Math.min(queued, room), `a fleet of ${n} left the queue the wrong number of rows`);
    assert.ok(drawn <= 7 || room === 0, `a fleet of ${n} overran the card at ${drawn} rows`);
  }

  const packed = view({ agents: Array.from({ length: 9 }, (_, i) => ({ ...live[0]!, id: `a${i}` })) });
  assert.ok(render(packed).includes('Up next'), 'the band went with its last row');
});

test('the up next band states the whole queue, and offers the rest', () => {
  const state = buildDemoState().state;
  const items = state.upcoming?.items ?? [];
  assert.ok(items.length > 0, 'the fixtures must carry a queued item');

  const html = render(view());
  const band = html.slice(html.indexOf('Up next'), html.indexOf('Goals in flight'));
  assert.ok(band.includes(`${items.length} queued`), 'the band does not say how big the queue is');

  const packed = render(view({ upcoming: state.upcoming }));
  assert.ok(packed.includes('Up next'), 'the band vanished with rows to report');
});

test('a queued ask is counted on the band, not left to be found', () => {
  const v = view();
  const items = v.state.upcoming?.items ?? [];
  const asking = items.filter((i) => i.status === 'unapproved').length;
  if (asking === 0) return;
  const html = render(v);
  const band = html.slice(html.indexOf('Up next'), html.indexOf('Goals in flight'));
  assert.ok(band.includes(`${asking} on you`), 'the band does not say how much of the queue is yours');
});
