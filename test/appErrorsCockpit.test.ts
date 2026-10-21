import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppErrorEnvironmentView, AppErrorGroupView, AppErrorsPayload } from '../web/src/types.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import { NOWHERE, placeQuery, readPlace, type ErrorsShow } from '../web/src/cockpit/place.js';
import {
  bandRows,
  countsOnGoal,
  filteredRows,
  goalErrorLines,
  shownRows,
  sortedRows,
  stateCounts,
  trackerPresses,
  type ErrorLink as AppErrorLink,
} from '../web/src/view/appErrors.js';
import { decode } from './support/html.js';

(globalThis as { React?: typeof React }).React = React;

const { AppErrorsView } = await import('../web/src/components/AppErrorsPage.js');
const { DetailBody } = await import('../web/src/components/AppErrorDetail.js');
const { GoalErrorBadge } = await import('../web/src/console/goalErrors.js');
const { RefLinks } = await import('../web/src/components/refs.js');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const DAYS = Array.from({ length: 14 }, (_, i) => new Date(NOW - (13 - i) * 86_400_000).toISOString().slice(0, 10));

function group(environment: string, over: Partial<AppErrorGroupView> = {}): AppErrorGroupView {
  return {
    environment,
    fingerprint: 'fp-1',
    title: 'NullReferenceException in OrderService.Submit',
    operation: 'POST /orders',
    version: null,
    frames: ['src/Orders/OrderService.cs:118'],
    hasDetail: false,
    url: 'https://portal.example/problem/1',
    firstSeen: '2026-10-20T08:00:00.000Z',
    lastSeen: '2026-10-20T11:00:00.000Z',
    returnedAt: null,
    daily: DAYS.map((day, i) => ({ day, count: i === 13 ? 5 : 0 })),
    key: 'err:shop:aaaa1111',
    state: 'new',
    count: 5,
    ignored: false,
    spike: null,
    link: null,
    tracker: null,
    ...over,
  };
}

function env(environment: string, band: string, groups: AppErrorGroupView[]): AppErrorEnvironmentView {
  return {
    environment,
    band,
    reading: {
      environment,
      status: 'ok',
      detail: null,
      readAt: '2026-10-20T11:50:00.000Z',
      okAt: '2026-10-20T11:50:00.000Z',
    },
    head: {
      environment,
      sha: 'abcdef1234567',
      previousSha: '7654321fedcba',
      observedAt: '2026-10-20T11:50:00.000Z',
      changedAt: '2026-10-20T07:00:00.000Z',
    },
    groups,
  };
}

/** Two regions of production in one declared band, and a test environment on its own. */
function payload(): AppErrorsPayload {
  const linked: AppErrorLink = {
    goalRef: 'issue:42',
    how: ['frame-match'],
    why: 'OrderService.cs changed only by #42, of 2 goals in the deploy window 7654321..abcdef1.',
    candidates: 2,
    tied: [],
  };
  const eu = env('liveEu', 'prod', [
    group('liveEu', { link: linked }),
    group('liveEu', {
      fingerprint: 'fp-2',
      key: 'err:shop:bbbb2222',
      title: 'Timeout talking to payments',
      state: 'steady',
      count: 30,
    }),
  ]);
  const us = env('liveUs', 'prod', [group('liveUs', { state: 'spiking', count: 7 })]);
  const test = env('test', 'test', [
    group('test', { key: 'err:shop:cccc3333', fingerprint: 'fp-3', state: 'returned', title: 'Came back' }),
    group('test', {
      key: 'err:shop:dddd4444',
      fingerprint: 'fp-4',
      state: 'new',
      link: { goalRef: 'issue:42', how: ['route-hint'], why: 'A hint only.', candidates: 4, tied: [] },
    }),
  ]);
  return {
    project: 'shop',
    environments: [eu, us, test],
    bands: [
      {
        band: 'prod',
        declared: true,
        environments: ['liveEu', 'liveUs'],
        status: 'ok',
        groups: [
          {
            key: 'err:shop:aaaa1111',
            fingerprint: 'fp-1',
            title: 'NullReferenceException in OrderService.Submit',
            state: 'new',
            environments: ['liveEu', 'liveUs'],
            count: 12,
            lastSeen: '2026-10-20T11:00:00.000Z',
          },
          {
            key: 'err:shop:bbbb2222',
            fingerprint: 'fp-2',
            title: 'Timeout talking to payments',
            state: 'steady',
            environments: ['liveEu'],
            count: 30,
            lastSeen: '2026-10-20T11:00:00.000Z',
          },
        ],
      },
      {
        band: 'test',
        declared: false,
        environments: ['test'],
        status: 'ok',
        groups: [],
      },
    ],
  };
}

const noActions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function html(element: ReactElement): string {
  return decode(
    renderToStaticMarkup(
      createElement(RefLinks, {
        refUrls: {},
        openGoal: () => undefined,
        hasGoal: (ref: string) => ref === 'issue:42',
        openPr: () => undefined,
        hasPr: () => false,
        children: element,
      }),
    ),
  );
}

function page(
  over: {
    band?: string | null;
    steady?: boolean;
    data?: AppErrorsPayload;
    show?: ErrorsShow;
    text?: string | null;
  } = {},
): string {
  return html(
    createElement(AppErrorsView, {
      payload: over.data ?? payload(),
      band: over.band ?? null,
      steady: over.steady ?? false,
      show: over.show ?? 'all',
      text: over.text ?? null,
      sort: 'state',
      now: NOW,
      actions: noActions,
    }),
  );
}

test('the selected band and the steady toggle are places, and round-trip through the URL', () => {
  for (const place of [
    { ...NOWHERE, tab: 'errors' as const },
    { ...NOWHERE, tab: 'errors' as const, errorsBand: 'prod' },
    { ...NOWHERE, tab: 'errors' as const, errorsBand: 'prod', errorsSteady: true },
    { ...NOWHERE, tab: 'errors' as const, errorsSort: 'count' as const, errorsShow: 'goalless' as const },
    { ...NOWHERE, tab: 'errors' as const, errorsText: 'OrderService' },
  ])
    assert.deepEqual(readPlace(placeQuery(place)), place, placeQuery(place));
  assert.equal(
    placeQuery({ ...NOWHERE, tab: 'errors', errorsBand: 'prod', errorsSteady: true }),
    '?tab=errors&band=prod&steady=1',
  );
});

test('a band row folds its members: the most moved member leads, the days are summed', () => {
  const data = payload();
  const prod = data.bands[0]!;
  const [row] = bandRows(data, prod);
  assert.equal(row?.state, 'new');
  assert.equal(row?.count, 12);
  assert.deepEqual(row?.environments, ['liveEu', 'liveUs']);
  assert.equal(row?.daily[13], 10);
  assert.equal(row?.frames[0], 'src/Orders/OrderService.cs:118');
  assert.equal(row?.link?.goalRef, 'issue:42');
  const rows = bandRows(data, prod);
  assert.deepEqual(stateCounts(rows), { new: 1, returned: 0, spiking: 0, steady: 1, gone: 0 });
  assert.equal(shownRows(rows, false).length, 1);
  assert.equal(shownRows(rows, true).length, 2);
});

test('the page draws the moved groups and folds steady and gone away until asked', () => {
  const folded = page();
  assert.match(folded, /prod: liveEu, liveUs/);
  assert.match(folded, /1 new/);
  assert.match(folded, /0 spiking/);
  assert.match(folded, /1 steady, 0 gone \(hidden\)/);
  assert.match(folded, /Show steady and gone/);
  assert.match(folded, /NullReferenceException in OrderService\.Submit/);
  assert.match(folded, /err:shop:aaaa1111/);
  assert.match(folded, /POST \/orders/);
  assert.match(folded, /Open in telemetry/);
  assert.match(folded, /https:\/\/portal\.example\/problem\/1/);
  assert.match(folded, /frame match/);
  assert.match(folded, /#42/);
  assert.doesNotMatch(folded, /Timeout talking to payments/);
  const shown = page({ steady: true });
  assert.match(shown, /Timeout talking to payments/);
  assert.match(shown, /1 steady, 0 gone(?! \(hidden\))/);
  assert.match(shown, /Hide steady and gone/);
});

test('fourteen bars, the last three in the state’s hue', () => {
  const bars = [...page().matchAll(/class="ae-bar( ae-new)?"/g)];
  assert.equal(bars.length, 14);
  assert.equal(bars.filter((b) => b[1] !== undefined).length, 3);
});

test('no link and no tracker are drawn as a dash, never as a claim', () => {
  const data = payload();
  data.bands[0]!.groups[0]!.state = 'new';
  data.environments[0]!.groups[0]!.link = null;
  const out = page({ data });
  assert.equal((out.match(/class="ae-none">—</g) ?? []).length, 2);
});

test('a group the evidence could not pin draws why, the goals it tied, and never a goal of its own', () => {
  const data = payload();
  data.environments[0]!.groups[0]!.link = {
    goalRef: null,
    how: [],
    why: 'No link: OrderService.cs changed as much by #42 as by #7, of 3 goals in the deploy window, and nothing else separates them.',
    candidates: 3,
    tied: ['issue:42', 'issue:7'],
  };
  const out = page({ data });
  assert.match(out, /no link/);
  assert.match(out, /nothing else separates them/);
  assert.match(out, /#42/);
  assert.match(out, /#7/);
  assert.match(out, /candidates: 3/);
  assert.deepEqual(goalErrorLines(data, 'issue:42'), [], 'a tie is not counted on either goal');
});

test('a window that could not be decided says so, and its candidates are unknown', () => {
  const data = payload();
  data.environments[0]!.groups[0]!.link = {
    goalRef: null,
    how: [],
    why: 'No link: the window cannot be decided — the clone did not answer within 5s.',
    candidates: null,
    tied: [],
  };
  const out = page({ data });
  assert.match(out, /the clone did not answer within 5s/);
  assert.match(out, /candidates: unknown/);
});

test('a tracker reading is drawn when a later stage fills it', () => {
  const data = payload();
  data.environments[0]!.groups[0]!.tracker = { status: 'open', ticketRef: 'issue:77', note: 'Filed by fleet B' };
  const out = page({ data });
  assert.match(out, /Filed by fleet B/);
  assert.match(out, /#77/);
});

test('the tracker column offers the press its search answers, and never File bug over an open bug', () => {
  const link: AppErrorLink = { goalRef: 'issue:42', how: ['frame-match'], why: 'w', candidates: 1, tied: [] };
  const unlinked: AppErrorLink = { goalRef: null, how: [], why: 'w', candidates: 3, tied: ['issue:42', 'issue:7'] };
  assert.deepEqual(trackerPresses({ status: 'none', ticketRef: null, note: null }, null), ['file', 'investigate']);
  assert.deepEqual(trackerPresses({ status: 'none', ticketRef: null, note: null }, link), ['file']);
  assert.deepEqual(
    trackerPresses({ status: 'none', ticketRef: null, note: null }, unlinked),
    ['file', 'investigate'],
    'a link that names no goal leaves the error unexplained, so Investigate is offered',
  );
  assert.deepEqual(trackerPresses({ status: 'open', ticketRef: 'issue:7', note: null }, null), []);
  assert.deepEqual(trackerPresses({ status: 'closed', ticketRef: 'issue:7', note: null }, null), [
    'reopen',
    'file-new',
  ]);
  assert.deepEqual(trackerPresses({ status: 'unknown', ticketRef: null, note: 'x' }, null), ['file-anyway', 'search']);
  assert.deepEqual(trackerPresses(null, null), [], 'not searched yet offers nothing to press');
});

test('each tracker status draws its buttons, with the ticket beside them and never inside one', () => {
  const draw = (tracker: AppErrorGroupView['tracker'], linked = true): string => {
    const data = payload();
    data.environments[0]!.groups[0]!.tracker = tracker;
    if (!linked) data.environments[0]!.groups[0]!.link = null;
    return page({ data });
  };
  const linked = draw({ status: 'none', ticketRef: null, note: null });
  assert.match(linked, />File bug</);
  assert.doesNotMatch(linked, />Investigate</, 'a linked group has a goal to look at already');
  const none = draw({ status: 'none', ticketRef: null, note: null }, false);
  assert.match(none, />Investigate</);
  const open = draw({ status: 'open', ticketRef: 'issue:77', note: null });
  assert.match(open, /Filed:/);
  assert.doesNotMatch(open, />File bug</);
  assert.doesNotMatch(open, /class="btn[^"]*"[^>]*>[^<]*#77/, 'the ticket is drawn beside the controls');
  const closed = draw({ status: 'closed', ticketRef: 'issue:77', note: 'fixed 2026-10-01, error is back' });
  assert.match(closed, />Reopen</);
  assert.match(closed, />File new</);
  assert.match(closed, /fixed 2026-10-01, error is back/);
  const unknown = draw({ status: 'unknown', ticketRef: null, note: 'the tracker search failed: 503' });
  assert.match(unknown, /search failed — not 'no bug'/);
  assert.match(unknown, />File bug anyway</);
  assert.match(unknown, />Retry search</);
});

test('an unknown reading is a warning with its account, never "no errors"', () => {
  const data = payload();
  data.environments[2]!.reading = {
    ...data.environments[2]!.reading!,
    status: 'unknown',
    detail: 'the errors command exited 1: az: token expired',
  };
  data.bands[1]!.status = 'unknown';
  const out = page({ data, band: 'test' });
  assert.match(out, /this is not “no errors”/);
  assert.match(out, /az: token expired/);
  assert.match(out, /unknown/);
});

test('a place naming a band nobody declares draws the first one', () => {
  assert.match(page({ band: 'gone-away' }), /prod: liveEu, liveUs/);
});

test('with nothing declared the page says how to declare it', () => {
  const out = page({ data: { project: 'shop', environments: [], bands: [] } });
  assert.match(out, /No environment declares an <code>errors<\/code> block/);
});

test('the goal card counts the moved groups linked to it, and not a hint', () => {
  const data = payload();
  assert.deepEqual(goalErrorLines(data, 'issue:42'), [
    { environment: 'liveEu', band: 'prod', count: 1, how: ['frame-match'] },
  ]);
  assert.deepEqual(goalErrorLines(data, 'issue:7'), []);
  const link = (over: Partial<AppErrorLink>): AppErrorLink => ({
    goalRef: 'issue:42',
    how: [],
    why: '',
    candidates: 1,
    tied: [],
    ...over,
  });
  assert.equal(countsOnGoal(link({ how: ['route-hint'] })), false);
  assert.equal(countsOnGoal(link({ how: ['route-hint', 'test-arrival'] })), true);
  assert.equal(countsOnGoal(link({ how: ['frame-match'] })), true);
  assert.equal(countsOnGoal(link({ goalRef: null, tied: ['issue:42', 'issue:7'] })), false, 'no goal, nothing counted');
  data.environments[0]!.groups[0]!.state = 'steady';
  assert.deepEqual(goalErrorLines(data, 'issue:42'), []);
});

test('the goal card badge says how many and where, and draws nothing for none', () => {
  const lines = goalErrorLines(payload(), 'issue:42');
  const out = html(createElement(GoalErrorBadge, { lines, actions: noActions }));
  assert.match(out, /1 new error on liveEu since this arrived/);
  assert.match(out, /linked by frame match/);
  assert.equal(html(createElement(GoalErrorBadge, { lines: [], actions: noActions })), '');
});

test('a row opens onto its message and stack, or its frames when no stack was reported', () => {
  const frames = ['src/Orders/OrderService.cs:118'];
  const body = (loaded: Parameters<typeof DetailBody>[0]['loaded']): string =>
    html(createElement(DetailBody, { frames, loaded }));
  const withStack = body({ message: 'Object reference not set', stack: 'at OrderService.Submit()\nat Post()' });
  assert.match(withStack, /<p class="ae-message">Object reference not set<\/p>/);
  assert.match(withStack, /<pre class="ae-stack">at OrderService.Submit\(\)\nat Post\(\)<\/pre>/);
  assert.doesNotMatch(withStack, /No stack reported/);

  const framesOnly = body({ message: null, stack: null });
  assert.match(framesOnly, /No stack reported — the top in-app frames/);
  assert.match(framesOnly, /<pre class="ae-stack">src\/Orders\/OrderService.cs:118<\/pre>/);
  assert.match(body('failed'), /could not be read/);

  assert.match(page(), /Error and stack/, 'a row with frames offers the fold');
});

test('rows sort by count, last or first seen, and keep the route’s moved-first order by default', () => {
  const rows = shownRows(bandRows(payload(), payload().bands[0]!), true);
  assert.deepEqual(
    sortedRows(rows, 'state').map((r) => r.state),
    ['new', 'steady'],
  );
  assert.deepEqual(
    sortedRows(rows, 'count').map((r) => r.count),
    [30, 12],
  );
});

test('rows narrow by what is missing on them and by text, without case', () => {
  const rows = shownRows(bandRows(payload(), payload().bands[0]!), true);
  assert.deepEqual(
    filteredRows(rows, 'goalless', null).map((r) => r.key),
    ['err:shop:bbbb2222'],
  );
  assert.equal(filteredRows(rows, 'ticketless', null).length, 2, 'no row has an open ticket');
  assert.deepEqual(
    filteredRows(rows, 'all', 'PAYMENTS').map((r) => r.key),
    ['err:shop:bbbb2222'],
  );
  assert.deepEqual(
    filteredRows(rows, 'all', 'aaaa1111').map((r) => r.key),
    ['err:shop:aaaa1111'],
  );
  assert.match(page({ text: 'nothing like this' }), /Nothing here matches the filter/);
});

test('a spiking row says its rate against the baseline it was read off', () => {
  const data = payload();
  const spiking = data.environments[1]!.groups[0]!;
  spiking.spike = { perDay: 24, baselinePerDay: 2.25 };
  data.bands[0]!.groups[0]!.state = 'spiking';
  assert.match(page({ data }), /24\/day vs 2\.3 usual on liveUs/, 'a band of several says whose rate it is');
  spiking.state = 'new';
  data.bands[0]!.groups[0]!.state = 'new';
  assert.doesNotMatch(page({ data }), /usual/, 'a rate is drawn only under a spiking chip');
});

test('a whitespace search in the address is no search', () => {
  assert.equal(readPlace('?tab=errors&etext=%20%20').errorsText, null);
});

test('a link’s reasoning rides on hover, not in the cell', () => {
  const out = page();
  assert.match(out, /title="OrderService\.cs changed only by #42[^"]*\(candidates: 2\)"/);
});
