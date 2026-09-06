import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as React from 'react';
import { createElement, isValidElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { EnvironmentHealthReading } from '../web/src/types.js';
import type { GoalPartView } from '../web/src/view/goalPage.js';
import type { CockpitActions, ConsolePanel } from '../web/src/cockpit/actions.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from '../web/src/console/QueueRail.js';
import { buildNeedsYou } from '../web/src/view/needsYou.js';
import { PRESETS } from '../web/src/cockpit/theme.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');
const { ThemeSettings } = await import('../web/src/components/ThemeSettings.js');
const { ColourField } = await import('../web/src/components/ColourField.js');
const { ConfigValues } = await import('../web/src/components/ConfigValues.js');
const { RaiseIssueModal, composeGate, canFile } = await import('../web/src/components/RaiseIssueModal.js');
const { usageReading, environmentsReading, menuEntries } = await import('../web/src/console/TopBar.js');

function view(over: Partial<CockpitView> = {}): CockpitView {
  const state = buildDemoState().state;
  return {
    ...buildViewModel({
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
    }),
    ...over,
  };
}

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

const render = (v: CockpitView) =>
  renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: createElement(ConsoleRoot, { view: v, actions }),
    }),
  );

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('nothing under console/ imports the api module', () => {
  const dir = fileURLToPath(new URL('../web/src/console/', import.meta.url));
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
  const css = readFileSync(fileURLToPath(new URL('../web/src/console/console.css', import.meta.url)), 'utf8');
  for (const cls of ['.escalation-card', '.recovery-panel', '.findings-panel', '.human-task-actions']) {
    assert.ok(!css.includes(cls), `console.css styles ${cls}; shared components restyle through tokens only`);
  }
});

test('console.css reaches no form control through .cn', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/console/console.css', import.meta.url)), 'utf8');
  const offenders = [...css.matchAll(/^\s*(\.cn[\w-]*\s+(?:input|textarea|select|option)\b[^,{]*)/gm)].map((m) =>
    m[1]!.trim(),
  );
  assert.deepEqual(offenders, [], 'a descendant element rule restyles the components the console embeds');
});

test('the why bubble is held between the row’s two edges, cap and all', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/console/console.css', import.meta.url)), 'utf8');
  const rule = /^\.cn-why-tip\s*\{([^}]*)\}/m.exec(css)?.[1];
  assert.ok(rule !== undefined, 'console.css no longer declares .cn-why-tip');
  for (const edge of ['left:', 'right:']) {
    assert.match(rule, new RegExp(`\\b${edge}`), `the bubble drops ${edge.slice(0, -1)} and anchors to the marker`);
  }
  if (/\bmax-width:/.test(rule)) {
    assert.match(
      rule,
      /margin-inline:\s*auto|margin-left:\s*auto/,
      'a capped box with both offsets is over-constrained: without an auto inline margin CSS drops `right`',
    );
  }
});

test('the usage chip carries both windows, and marks the one that binds', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const limits = (five: number | null, seven: number | null, msAgo = 60_000) => ({
    windows: { fiveHourCostUsd: 1.15, sevenDayCostUsd: 12.4 },
    rateLimits: {
      fiveHour: five === null ? null : { usedPercentage: five, resetsAt: null },
      sevenDay: seven === null ? null : { usedPercentage: seven, resetsAt: null },
      capturedAt: at(msAgo),
    },
    unattributedCostUsd: 0,
  });

  const weekly = usageReading(limits(31, 93), now);
  assert.deepEqual(
    weekly.slots.map((s) => `${s.label} ${s.value}${s.binds ? '*' : ''}`),
    ['5h 31%', '7d 93%*'],
    'the slots must stay five-hour then weekly, with the window nearer its limit marked',
  );
  assert.equal(weekly.tone, 'spent', 'the tone reads the window that binds, not the first one');
  assert.equal(weekly.age, null, 'a minute-old reading is current — the age is the stale caveat, not a timestamp');

  const fiveHour = usageReading(limits(62, 30), now);
  assert.deepEqual(
    fiveHour.slots.map((s) => `${s.label} ${s.value}${s.binds ? '*' : ''}`),
    ['5h 62%*', '7d 30%'],
  );
  assert.equal(fiveHour.tone, 'plain');

  const half = usageReading(limits(68, null), now);
  assert.deepEqual(
    half.slots.map((s) => `${s.label} ${s.value}${s.binds ? '*' : ''}`),
    ['5h 68%*', '7d —'],
    'a window nothing reported is an em dash, and cannot be the one nearer its limit',
  );

  const stale = usageReading(limits(62, 30, 3_600_000), now);
  assert.equal(stale.age, '1h ago', 'an hour-old reading is drawn without saying it is an hour old');

  const noLimits = usageReading(
    { windows: { fiveHourCostUsd: 1.15, sevenDayCostUsd: 12.4 }, rateLimits: null, unattributedCostUsd: 0 },
    now,
  );
  assert.deepEqual(noLimits.slots, [], 'there is no pair to draw when nothing reported a window');
  assert.equal(noLimits.cost, '$1.15', 'no fallback to cost — the chip is blank on every API-key deployment');
  assert.equal(noLimits.tone, 'plain');

  const nothing = usageReading(
    { windows: { fiveHourCostUsd: 0, sevenDayCostUsd: 0 }, rateLimits: null, unattributedCostUsd: 0 },
    now,
  );
  assert.equal(nothing.tone, 'quiet', 'nothing spent is a muted reading, never a missing one');
});

test('the usage chip is on the top bar, tagged and unlabelled', () => {
  const html = render(view());
  assert.ok(!/<span>Usage<\/span>/.test(html), 'the chip is back to spending width on its own name');
  assert.ok(html.includes('cn-usage-win'), 'the chip drew no window slots');
  assert.ok(html.includes('cn-binds'), 'neither window is marked as the one nearer its limit');
  assert.ok(html.includes('<em>5h</em>') && html.includes('<em>7d</em>'), 'the windows are not told apart');
  assert.ok(html.includes('cn-usage-sep'), 'the two figures run together with no divider');
});

test('the bar folds its ways-in behind one menu, and keeps the two gauges out of it', () => {
  const keys = menuEntries(view(), actions).map((entry) => entry.key);
  assert.deepEqual(
    keys,
    ['faults', 'launch', 'build', 'env', 'signals', 'record', 'config'],
    'a way-in went missing from the menu, or arrived in a different order',
  );

  const html = render(view());
  assert.ok(html.includes('aria-haspopup="menu"'), 'nothing on the bar opens the menu');
  assert.ok(!html.includes('cn-menu-row'), 'the menu draws its rows before anybody has opened it');
  assert.ok(html.includes('cn-pill'), 'the usage and local gauges left the strip');

  for (const entry of menuEntries(view(), actions)) {
    assert.ok(entry.label.length > 0, `the ${entry.key} row has no word`);
    assert.ok(entry.title.length > 0, `the ${entry.key} row has no sentence behind it`);
  }
});

test('an unsaved theme edit marks the Config row and the menu button in front of it', () => {
  const saved = menuEntries(view(), actions, false).find((entry) => entry.key === 'config');
  assert.equal(saved?.pending, false, 'a saved theme marks Config anyway');

  const pending = menuEntries(view(), actions, true).find((entry) => entry.key === 'config');
  assert.equal(pending?.pending, true, 'an unsaved theme edit leaves Config unmarked');
  assert.match(pending.title, /unsaved theme edit/, 'and the row does not say what is pending');

  assert.ok(
    menuEntries(view(), actions, true).some((entry) => entry.tone !== null || entry.pending === true),
    'nothing in front of the menu says an edit is pending',
  );
});

test('the two ways out ride the readings, together, online and off', () => {
  for (const connected of [true, false]) {
    const html = render(view({ connected }));
    const asks = /<div class="cn-asks">([\s\S]*?)<\/div>\s*<(?:div|i|span)/.exec(html)?.[1] ?? '';
    assert.ok(asks.includes('Issue!'), `the file control left the group (connected: ${String(connected)})`);
    assert.ok(asks.includes('Question?'), `the ask control left the group (connected: ${String(connected)})`);
    const reads = html.indexOf('cn-reads');
    assert.ok(reads > 0 && html.indexOf('cn-asks') > reads, 'the pair is drawn outside the readings group');
  }
});

test('Pets left the nav for the vivarium strip, which says so', () => {
  const html = render(view());
  const nav = html.split('</nav>')[0] ?? '';
  assert.ok(!nav.includes('>Pets'), 'Pets is a nav destination again');

  const strip = /<button[^>]*class="cn-viv-bar"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1];
  assert.ok(strip !== undefined, 'the vivarium drew no strip');
  assert.ok(strip.includes('cn-viv-name'), 'the strip does not name where it goes');
  assert.ok(strip.includes('>Pets<'), 'the strip is captioned rather than labelled with the nav’s own word');
  assert.ok(strip.includes('cn-viv-chev'), 'nothing on the strip says it goes anywhere');
});

test('a dropped socket draws no gauge, no rail and no situation area', () => {
  const html = render(view({ connected: false }));
  assert.ok(html.includes('Off the air'));
  assert.ok(!html.includes('cn-rail'), 'the rail must not render while offline');
  assert.ok(!html.includes('cn-sit'), 'the situation area must not render while offline');
});

const COMPOSE_TITLE = 'Write an issue about LubbDubb';

test('the bar offers LubbDubb’s own tracker, online and off', () => {
  const link = /<a[^>]*href="https:\/\/github\.com\/AdamAwan\/LubbDubb\/issues\/new"[^>]*rel="noopener noreferrer"/;
  assert.ok(link.test(render(view({ connected: false }))), 'no new-issue link that keeps the opener while offline');
  assert.ok(render(view({ connected: true })).includes(COMPOSE_TITLE), 'no compose button while connected');
});

test('the bar composes whenever it is connected, and links out when it is not', () => {
  const filing = (canFileTickets: boolean, connected: boolean): CockpitView => {
    const v = view({ connected });
    return { ...v, state: { ...v.state, config: { ...v.state.config, canFileTickets } } };
  };
  const link = /<a[^>]*href="https:\/\/github\.com\/AdamAwan\/LubbDubb\/issues\/new"/;

  for (const canFileTickets of [true, false]) {
    const composing = render(filing(canFileTickets, true));
    assert.ok(composing.includes(COMPOSE_TITLE), `no compose button with canFileTickets=${canFileTickets}`);
    assert.ok(!link.test(composing), 'the external link is drawn beside the compose button');

    const offline = render(filing(canFileTickets, false));
    assert.ok(
      link.test(offline) && !offline.includes(COMPOSE_TITLE),
      `no way out to LubbDubb’s tracker with the socket down and canFileTickets=${canFileTickets}`,
    );
  }
});

test('the compose modal is unusable until the probe has answered', () => {
  const html = renderToStaticMarkup(
    createElement(RaiseIssueModal, {
      probe: () => new Promise<never>(() => undefined),
      fallbackUrl: 'https://github.com/AdamAwan/LubbDubb/issues/new',
      onSubmit: () => Promise.reject(new Error('not reached')),
      onClose: () => undefined,
    }),
  );
  assert.equal(html.match(/<(?:input|textarea)[^>]*disabled/g)?.length, 2, 'title and body');
  assert.ok(/<button[^>]*disabled[^>]*>raise issue<\/button>/.test(html), 'the submit must start dead');
  assert.ok(decode(html).includes('checking where this would go'), 'and must say why it is waiting');
});

test('the probe decides three readings, and only one of them can file', () => {
  assert.equal(composeGate(null), 'checking');
  assert.equal(
    composeGate({ available: true, reason: null, watchable: false, target: 'AdamAwan/LubbDubb', identity: 'octocat' }),
    'ready',
  );
  assert.equal(
    composeGate({ available: false, target: null, identity: null, reason: 'gh is logged out' }),
    'unavailable',
  );

  assert.equal(canFile('ready', 'a title', 'a body'), true);
  for (const [title, body] of [
    ['', 'a body'],
    ['a title', ''],
    ['   ', 'a body'],
    ['a title', '\n  '],
  ] as const) {
    assert.equal(
      canFile('ready', title, body),
      false,
      `submit live on title=${JSON.stringify(title)} body=${JSON.stringify(body)}`,
    );
  }
  assert.equal(canFile('checking', 'a title', 'a body'), false);
  assert.equal(canFile('unavailable', 'a title', 'a body'), false);
});

test('the recovery banner sits outside the situation area', () => {
  const html = render(view({ crashed: [{ taskId: 't1' }] as CockpitView['crashed'] }));
  const banner = html.indexOf('cn-recovery');
  const sit = html.indexOf('cn-sit');
  assert.ok(banner !== -1, 'a held harness must draw its banner');
  assert.ok(banner < sit, 'the banner belongs above the situation area, not inside it');
});

test('decode reverses text-node escaping, and only in that order', () => {
  assert.equal(decode('&amp;lt;'), '&lt;');
  assert.equal(decode('&#x27;'), "'");
});

test('a panel draws its backdrop and its close button, both of them ways out', () => {
  const html = render(view({ consolePanel: 'faults' }));

  assert.ok(html.includes('cn-backdrop'), 'the backdrop is an exit and must be drawn');
  assert.ok(html.includes('Close'), 'the button is an exit and must be drawn');
  assert.ok(html.includes('<h2>Faults</h2>'));
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

test('one part is held, not "1 parts" — the count and the noun agree', () => {
  const rows = [
    {
      id: 'a',
      kind: 'bench',
      group: 'yours',
      title: 'Holds exactly one',
      goalRef: 'issue:1',
      agentId: null,
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  assert.ok(html.includes('holding 1 part<'), 'a single held part reads in the singular');
  assert.ok(!html.includes('holding 1 parts'));
});

test('the vivarium comes after the situation area, not inside the rail', () => {
  const html = render(view());
  const rail = html.indexOf('cn-rail');
  const sit = html.indexOf('cn-sit');
  const viv = html.indexOf('cn-viv');
  assert.ok(viv > 0, 'the demo snapshot ships a vivarium');
  assert.ok(rail < sit, 'the rail is drawn before the situation area');
  assert.ok(sit < viv, 'the enclosure is the last thing in the body, not a strip in the middle of it');
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
  assert.ok(lowPos < highPos, 'the blocking group must keep array order, not re-sort by holding');
});

test('every row that opens something is a button; only the recovery hold is not', () => {
  const rows = [
    {
      id: 'clickable',
      kind: 'escalation',
      group: 'blocking',
      title: 'Opens a goal',
      goalRef: 'issue:9',
      opens: 'goal',
      agentId: 'a1',
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'no-goal',
      kind: 'escalation',
      group: 'blocking',
      title: 'Opens the ask panel',
      goalRef: null,
      opens: 'ask',
      agentId: 'a3',
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: 'Answered on the banner above',
      goalRef: null,
      opens: null,
      agentId: null,
      holding: 0,
      raisedAt: '',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));

  const rowWrapper = (title: string): string => {
    const titlePos = html.indexOf(title);
    assert.ok(titlePos !== -1, `row "${title}" must render`);
    const before = html.slice(0, titlePos);
    const matches = [...before.matchAll(/<(button|div)\b([^>]*)>/g)].filter(([, , attrs]) =>
      /class="cn-q cn-t-(?:red|amber|blue|green)(?: cn-parked)?(?: cn-dim)?"/.test(attrs ?? ''),
    );
    const last = matches.at(-1);
    assert.ok(last, `no cn-q wrapper found before "${title}"`);
    const tag = last[1];
    assert.ok(tag, `unmatched capture group for "${title}"`);
    return tag;
  };

  assert.equal(rowWrapper('Opens a goal'), 'button', 'a row that opens a goal is a button');
  assert.equal(
    rowWrapper('Opens the ask panel'),
    'button',
    'an ask with no goal page still has somewhere to go, so it is a button',
  );
  assert.equal(
    rowWrapper('Answered on the banner above'),
    'div',
    'the recovery row opens nothing and must not be wrapped in a button',
  );
});

test('every act a rail card carries is in the card’s action bar', () => {
  const html = render(view());
  const rail = html.slice(html.indexOf('cn-rail'), html.indexOf('cn-sit'));
  const cards = rail.split(/(?=<(?:button|div)[^>]*class="cn-q(?: |"))/).filter((c) => /class="cn-q(?: |")/.test(c));
  assert.ok(cards.length > 0, 'the demo snapshot must fill the rail');

  const ACT = /class="btn btn|ref-pair|ref-goal|cn-copy|cn-inline/g;
  let withActs = 0;
  for (const card of cards) {
    const acts = [...card.matchAll(ACT)].map((m) => m.index ?? 0);
    if (acts.length === 0) continue;
    withActs += 1;
    const bar = card.indexOf('class="cn-qfoot');
    assert.ok(bar !== -1, `a card carrying an act draws the bar to put it in: ${card.slice(0, 120)}`);
    for (const at of acts) {
      assert.ok(at > bar, `an act above the bar is an act back in the body: ${card.slice(at - 40, at + 40)}`);
    }
  }
  assert.ok(withActs >= 3, 'the demo must exercise the bar on more than one kind of card');
});

test('every kind of ask draws in its own tone, under its own glyph', () => {
  const kinds = Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[];

  const symbols = kinds.map((k) => KIND_SYMBOL[k]);
  assert.equal(new Set(symbols).size, symbols.length, 'two kinds sharing a glyph is a glyph that says nothing');
  for (const sym of symbols) {
    assert.equal([...sym].length, 1, `"${sym}" must be a single character`);
    const cp = sym.codePointAt(0) ?? 0;
    assert.ok(cp < 0x10000, `"${sym}" must be a BMP glyph, not an emoji codepoint`);
    assert.ok(!/[\uFE0E\uFE0F]/.test(sym), `"${sym}" must carry no variation selector`);
  }

  const rows = kinds.map((kind, i) => ({
    id: `row-${i}`,
    kind,
    group: i % 2 === 0 ? 'blocking' : 'yours',
    title: `The ${kind} row`,
    goalRef: null,
    originRef: null,
    opens: kind === 'recovery' ? null : 'ask',
    agentId: null,
    holding: 0,
    raisedAt: '2026-01-01T00:00:00.000Z',
  })) as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  for (const kind of kinds) {
    const pos = html.indexOf(`The ${kind} row`);
    assert.ok(pos !== -1, `the ${kind} row must render`);
    const row = html.slice(html.lastIndexOf('<', html.lastIndexOf('cn-q cn-t-', pos)), pos);
    assert.ok(row.includes(`cn-q cn-t-${KIND_TONE[kind]}`), `the ${kind} row must wear its own tone, not the group's`);
    assert.ok(row.includes(KIND_SYMBOL[kind]), `the ${kind} row must draw its glyph beside the word`);
    assert.ok(row.includes(KIND_LABEL[kind]), `and the word beside the glyph — the symbol is a second reading`);
  }
});

test("the group is drawn as weight within the kind's own hue", () => {
  const rows = [
    {
      id: 'parked',
      kind: 'escalation',
      group: 'blocking',
      title: 'An agent is parked on this',
      goalRef: null,
      originRef: null,
      opens: 'ask',
      agentId: 'a1',
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'unparked',
      kind: 'escalation',
      group: 'yours',
      title: 'Nothing is waiting on this',
      goalRef: null,
      originRef: null,
      opens: 'ask',
      agentId: null,
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  assert.ok(html.includes('class="cn-q cn-t-red cn-parked"'), 'a blocking row carries the parked weight');
  assert.ok(html.includes('class="cn-q cn-t-red"'), 'and a row nothing is parked on carries the tone alone');
});

function goalRef(): string {
  const ref = view().needsYou.find((n) => n.kind === 'plan' && n.goalRef !== null)?.goalRef;
  assert.ok(ref, 'the demo fixtures must carry a plan ask that names a goal');
  return ref;
}

function goalView(
  mutate: (state: CockpitView['state']) => void = () => {},
  ref: string = goalRef(),
  goalOpen: readonly string[] = [],
  goalShut: readonly string[] = [],
): CockpitView {
  const state = buildDemoState().state;
  mutate(state);
  return buildViewModel({
    goalOpen,
    goalShut,
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
    selectedGoal: ref,
    consolePanel: null,
    tab: 'overview',
  });
}

function prView(prNumber: number, ref: string | null = 'issue:412'): CockpitView {
  const state = buildDemoState().state;
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
    selectedGoal: ref,
    selectedPr: prNumber,
    consolePanel: null,
    tab: 'overview',
  });
}

test('a pull request outranks the goal it was reached from, and the crumb leads back to it', () => {
  const html = decode(render(prView(412)));
  assert.ok(html.includes('PR #412'), 'the crumb names where you are');
  assert.ok(html.includes('Review threads'), 'and the page draws the review');
  assert.ok(!html.includes('>Pull requests<'), 'the goal page underneath is replaced, not stacked with');
});

test('the crumb draws every rung of the ladder, not just the one beneath', () => {
  const view = prView(412);
  const html = decode(render(view));
  const crumb = /<nav class="cn-crumb"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1];
  assert.ok(crumb, 'the pull request page draws a crumb');
  assert.ok(crumb.includes('Overview'), 'the tab the page hangs off is on the trail');
  const goal = view.prPage?.goal;
  assert.ok(goal, 'the fixture opens the pull request over a goal');
  assert.ok(crumb.includes(`#${goal.number}`), 'and so is the goal it was reached from');
  assert.ok(crumb.includes('PR #412'), 'with the page itself as the last rung');
  assert.equal((crumb.match(/<button/g) ?? []).length, 2, 'both rungs above are controls');
  assert.ok(/cn-crumbnow[^>]*>PR #412/.test(crumb), 'and the page you are on is not one');
});

function findComponent(node: unknown, name: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findComponent(child, name);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (typeof node.type === 'function' && node.type.name === name) return node;
  return findComponent((node.props as { children?: unknown }).children, name);
}

test('the goal rung leads to the goal even when the page was opened without one', () => {
  const view = prView(412, null);
  const goal = view.prPage?.goal;
  assert.ok(goal, 'the pull request still knows the goal that owns it');
  const calls: Array<[string, unknown]> = [];
  const recorder = new Proxy(
    {},
    { get: (_t, name: string) => (arg: unknown) => calls.push([name, arg]) },
  ) as CockpitActions;

  const crumb = findComponent(ConsoleRoot({ view, actions: recorder }), 'PrCrumb');
  assert.ok(crumb, 'the pull request page draws its crumb');
  const trail = (crumb.type as (props: unknown) => ReactElement)(crumb.props).props.trail as ReadonlyArray<{
    label: string;
    go: () => void;
  }>;
  const rung = trail.find((step) => step.label.startsWith(`#${goal.number}`));
  assert.ok(rung, 'the goal is a rung on the trail');
  rung.go();
  assert.deepEqual(calls, [['selectGoal', view.prPage?.goalRef]], 'and standing on it opens that goal');
});

test('a goal page draws one rung and a tab draws no crumb at all', () => {
  const goal = decode(render(goalView()));
  const crumb = /<nav class="cn-crumb"[^>]*>([\s\S]*?)<\/nav>/.exec(goal)?.[1];
  assert.ok(crumb, 'a goal page draws a crumb');
  assert.equal((crumb.match(/<button/g) ?? []).length, 1, 'one rung above a goal: the tab');
  assert.ok(!render(view()).includes('cn-crumb'), 'a tab is the foot of the ladder and has no trail');
});

test('a thread is drawn with its state, its conversation and where it hangs', () => {
  const html = decode(render(prView(412)));
  for (const state of ['open', 'answered', 'resolved']) {
    assert.ok(html.includes(`cn-th-${state}`), `the demo's ${state} thread must be drawn as one`);
  }
  assert.ok(html.includes('the cut alone would drop the tail it needs'), 'a reply is part of the thread');
  assert.match(html, /class="tag t-violet[^"]*"[^>]*>fleet</, 'and a reply the fleet wrote says so');
  assert.ok(html.includes('src/context/rank.ts'), 'a thread names the place it hangs');
});

test('the pull request page carries the way out to the provider', () => {
  const html = decode(render(prView(412)));
  assert.ok(html.includes('Open pull request ↗'), 'the page a ref lands on must still reach the provider');
});

test('a pull request the world has lost is said so, rather than falling through to the goal', () => {
  const html = decode(render(prView(9999)));
  assert.ok(html.includes('is not in the current world'), 'the page says what happened');
  assert.ok(!html.includes('Review threads'), 'and draws no page for a pull request it does not have');
});

test('a goal draws its own durable record, not only the live snapshot', () => {
  const shut = render(goalView());
  assert.ok(shut.includes('The record'), 'the goal page must carry the history the snapshot forgets');
  assert.ok(
    !shut.includes('Reading the record'),
    'folded away it fetches nothing — "on open, never polled" is the disclosure now, not the page',
  );

  const open = render(goalView(() => {}, goalRef(), ['record']));
  assert.ok(open.includes('Reading the record'), 'the card must say it is fetching rather than draw an empty box');
});

test('a goal can still be sent back for more work, not only marked done', () => {
  const html = render(goalView());
  assert.ok(html.includes('Give instructions'), 'the goal page must offer the way to say what is left');

  const already = goalView((s) => {
    const issue = s.world.issues.find((i) => `issue:${i.number}` === goalRef());
    assert.ok(issue, 'the fixture goal must be in the world');
    issue.conclusion = { ...issue.conclusion, verdict: 'more_work' };
    issue.instructions = [
      {
        id: 'ins_demo',
        originRef: `issue:${issue.number}`,
        text: 'change the button to primary',
        createdAt: new Date().toISOString(),
        settledAt: null,
      },
    ];
  });
  const standing = render(already);
  assert.ok(standing.includes('Give instructions'), 'and it still is once one stands');
  assert.ok(standing.includes('change the button to primary'), 'what was asked for is drawn, not just counted');
  assert.ok(standing.includes('Withdraw'), 'and there is a way to take it back');
});

test('the goal header captions its groups and draws the run state as one control', () => {
  const html = render(goalView());

  for (const caption of ['Run state', 'Steer the work', 'Leave this page']) {
    assert.ok(html.includes(caption), `the group caption "${caption}" is what explains the controls under it`);
  }

  assert.match(html, /class="cn-ctlseg"/, 'the run states share one control');
  for (const state of ['Working', 'Done']) {
    assert.ok(html.includes(state), `${state} is a segment of the run state`);
  }

  assert.ok(!html.includes('More work'), 'no control or chip carries the old ambiguous words');
});

test('an unanswered profile proposal reaches the rail, not only the goal page', () => {
  const ref = goalRef();
  const gated = (state: CockpitView['state']) => {
    const issue = state.world.issues.find((i) => `issue:${i.number}` === ref);
    assert.ok(issue, 'the fixture goal must be in the world');
    issue.appraisal = {
      verdict: 'workable',
      summary: 'Three subsystems and an auth guard between them.',
      missing: [],
      by: 'appraiser',
      decidedAt: new Date(Date.now() - 3600_000).toISOString(),
      commentRef: null,
      proposedProfile: 'deep',
      awaitingProfileAnswer: true,
      placement: [],
      parentSettledAt: null,
    };
  };

  const html = decode(render(goalView(gated)));
  assert.ok(html.includes(KIND_LABEL.profile), 'the rail names the kind');
  assert.ok(html.includes('The goal appraisal wants this run on “deep”'), 'and says what is being asked');
  assert.ok(html.includes('Use “deep”'), 'the band offers the proposal');
  assert.ok(html.includes('Leave it unpinned') || /Keep “/.test(html), 'and the way to keep what is standing');

  assert.equal(html.split('Use “deep”').length - 1, 1, 'the gate is drawn once on the goal page');
});

test('the band on the goal page wears the tone and glyph its rail row does', () => {
  const ref = goalRef();
  const v = goalView();
  const row = v.needsYou.find((n) => n.goalRef === ref && n.opens === 'goal');
  assert.ok(row, 'the demo goal must carry an ask read on its own page');

  const html = render(v);
  assert.ok(html.includes(`cn-needs cn-t-${KIND_TONE[row.kind]}`), "the band takes the kind's tone");
  assert.ok(html.includes(`cn-q cn-t-${KIND_TONE[row.kind]}`), 'and the rail row it came from takes the same one');
  assert.ok(html.includes(KIND_SYMBOL[row.kind]), 'the glyph is drawn on both');
});

test('the goal page answers with the shared card’s rules rather than its own', () => {
  const row = view().needsYou.find((n) => n.goalRef !== null && n.kind === 'escalation');
  assert.ok(row, 'the demo fixtures must carry a goal-scoped question an agent is parked on');
  const ref = row.goalRef!;

  const withOptions = render(
    goalView((s) => {
      const asked = s.escalations.find((e) => e.id === row.id)!;
      asked.context = { ...asked.context, options: ['Take ours', 'Take theirs'] };
    }, ref),
  );
  assert.match(withOptions, /class="esc-quick"/, 'offered choices stay one click in the band');
  assert.match(withOptions, />Take theirs</);

  const proposal = render(
    goalView((s) => {
      s.escalations = s.escalations.filter((e) => e.id === row.id);
      s.proposals = [{ ...s.proposals![0]!, id: 'p-band', kind: 'merge', status: 'pending', escalationId: row.id }];
    }, ref),
  );
  assert.match(proposal, /needs your decision/, 'a decision must read as one in the band');
  assert.match(proposal, />Approve merge</);
  assert.doesNotMatch(proposal, /placeholder="Your answer…"/, 'a proposal is never answered with free text');
});

test('a selected goal draws its page instead of the overview', () => {
  const v = goalView();
  const html = render(v);
  assert.ok(html.includes('cn-goal'));
  assert.ok(v.goalPage !== null);
  assert.ok(decode(html).includes(String(v.goalPage!.issue.title)));
});

test('the rail marks the open goal’s asks and mutes the rest', () => {
  const ref = goalRef();
  const rows = [
    {
      id: 'mine',
      kind: 'escalation',
      group: 'blocking',
      title: 'On the open goal',
      goalRef: ref,
      opens: 'goal',
      agentId: 'a1',
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'other',
      kind: 'escalation',
      group: 'blocking',
      title: 'On some other goal',
      goalRef: 'issue:9999',
      opens: 'ask',
      agentId: 'a2',
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: 'Answered on the banner above',
      goalRef: null,
      opens: null,
      agentId: null,
      holding: 0,
      raisedAt: '',
    },
  ] as CockpitView['needsYou'];

  const opened = render({ ...goalView(), needsYou: rows });
  const wrapper = (title: string): string => {
    const before = opened.slice(0, opened.indexOf(title));
    const tag = [...before.matchAll(/<(?:button|div)\b[^>]*class="cn-q(?: [^"]*)?"[^>]*>/g)].at(-1);
    assert.ok(tag, `no cn-q wrapper found before "${title}"`);
    return tag[0];
  };

  assert.match(wrapper('On the open goal'), /aria-current="true"/, 'an ask on the open goal is the current row');
  assert.doesNotMatch(wrapper('On the open goal'), /cn-dim/, 'the current row is never the muted one');
  assert.match(wrapper('On some other goal'), /cn-dim/, 'another goal’s ask recedes while this one is open');
  assert.doesNotMatch(
    wrapper('Answered on the banner above'),
    /cn-dim/,
    'the recovery hold blocks every goal, so it is nobody else’s business to mute',
  );

  const overview = render(view({ needsYou: rows }));
  assert.ok(!overview.includes('cn-dim'), 'the rail mutes nothing while the overview is drawn');
  assert.ok(!overview.includes('aria-current'), 'no row is current while no goal is open');
});

test('the ask is drawn above the plan, which is the whole point of the page', () => {
  const v = goalView();
  if ((v.goalPage?.needs.length ?? 0) === 0) return;
  const html = render(v);
  assert.ok(html.indexOf('cn-needs') < html.indexOf('cn-waves'));
});

test('a goal with no ask draws no band at all', () => {
  const v = goalView();
  const html = render({ ...v, goalPage: { ...v.goalPage!, needs: [] } });
  assert.ok(!html.includes('cn-needs'), 'a band with nothing in it is not a band');
});

test('a held part quotes the reconciler’s own reason rather than inventing one', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const first = page.parts[0];
  if (!first) return;

  const parts: GoalPartView[] = [
    {
      part: { ...first.part, status: 'blocked', blockedReason: 'waits on staging credentials' },
      group: 'held',
      agentId: null,
      agentLive: false,
    },
  ];

  const html = render({ ...v, goalPage: { ...page, parts } });
  assert.ok(html.includes('waits on staging credentials'));
});

test('a plan with no live parts draws what it proposed rather than only saying so', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const seed = page.parts[0]?.part ?? v.state.planParts?.[0];
  assert.ok(seed, 'the fixtures must carry a part to retire');

  const html = render({
    ...v,
    goalPage: {
      ...page,
      parts: [],
      retiredParts: [{ ...seed, status: 'retired', title: 'split the store in two' }],
    },
  });

  assert.ok(decode(html).includes('Every part of this plan was retired'));
  assert.ok(decode(html).includes('split the store in two'));
  assert.ok(html.includes('cn-retired'));
});

test('the plan card is a way into the whole plan, not only its shape', () => {
  const planned = view().state.plans?.[0];
  assert.ok(planned, 'the demo fixtures must carry a plan');
  const v = goalView(() => {}, planned.originRef);
  assert.ok(v.goalPage?.plan, 'the plan must reach the page of the goal it hangs off');

  const html = decode(render(v));
  assert.ok(html.includes('open the full plan'), 'the plan card must offer the sheet');
  assert.ok(html.indexOf('open the full plan') < html.indexOf('cn-waves'), 'the way in belongs in the header');
});

test('a goal with no plan draws no way into one', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const html = decode(render({ ...v, goalPage: { ...page, plan: null } }));
  assert.ok(!html.includes('open the full plan'), 'a control onto a plan that does not exist is a dead end');
});

test('the ticket is drawn as HTML when the tracker wrote HTML', () => {
  const v = goalView(() => {}, goalRef(), ['ticket']);
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');

  const html = render({
    ...v,
    goalPage: { ...page, issue: { ...page.issue, body: '<div>Login is broken.<br>Twice.</div>' } },
  });

  assert.ok(html.includes('Login is broken.'));
  assert.ok(!html.includes('&lt;div&gt;'), 'the tags are structure, not text to print');
});

test('the ticket arrives folded on a goal under way, and opens from the place', () => {
  const shut = render(goalView());
  assert.ok(shut.includes('The ticket'), 'the ticket is named even while it is folded away');
  assert.ok(!shut.includes('as it stood at pickup</span><div class="cn-tick"'), 'and its body is not drawn');

  const open = render(goalView(() => {}, goalRef(), ['ticket']));
  assert.ok(open.includes('class="cn-tick"'), 'the place is what opens it');
});

test('a goal nobody has planned opens on its ticket, unless the operator folded it', () => {
  const fresh = goalView((s) => {
    s.plans = [];
    s.planParts = [];
    s.agents = [];
    s.world = { ...s.world, pullRequests: [] };
  });
  const page = fresh.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const bare = { ...fresh, goalPage: { ...page, plan: null, parts: [], openPullRequests: [], agents: [] } };
  assert.ok(render(bare).includes('class="cn-tick"'), 'the ticket is the page on a goal with nothing else on it');

  assert.ok(
    !render({ ...bare, goalShut: new Set(['ticket']) }).includes('class="cn-tick"'),
    'and the operator folding it outranks that reading',
  );
});

test('validation and signals are folded on a goal that has not shipped', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const nowhere = {
    ...v,
    goalPage: {
      ...page,
      checks: [],
      signals: page.signals.map((s) => ({ ...s, live: true, proposal: null })),
      environments: [
        { environment: 'prod' as const, status: 'absent' as const, landed: 0, total: 2, at: null, opens: [] },
      ],
    },
  };
  const html = render(nowhere);
  assert.ok(html.includes('Validation'), 'the card is named — a surface that vanishes when quiet looks broken');
  assert.ok(!html.includes('cn-vin'), 'and its body is not drawn while there is nothing in it');
  assert.ok(html.includes('0/1 reached'), 'a folded environments card still says how far the work has got');

  const open = render({ ...nowhere, goalOpen: new Set(['validation']) });
  assert.ok(open.includes('cn-vin'), 'the place is what opens it');
});

test('a held goal is a way into the goal it names', () => {
  const v = view();
  const row = v.needsYou.find((n) => n.kind === 'intake');
  assert.ok(row, 'the demo fixtures must carry a goal the appraisal refused');
  assert.equal(row.opens, 'goal', 'a held goal has a page, so the row opens it');
  assert.ok(decode(render(v)).includes(row.title), 'and the rail draws it');
});

test('every config section in the strip has a render arm', () => {
  const source = readFileSync('web/src/components/ConfigPage.tsx', 'utf8');
  const strip = /const TABS: readonly \{ id: ConfigTab; label: string \}\[\] = \[([\s\S]*?)\];/.exec(source);
  assert.ok(strip, 'TABS is declared where this test looks for it');
  const sections = [...strip[1]!.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(sections.length >= 6, `found ${sections.length} sections, which is too few to be the real list`);
  for (const id of sections) {
    assert.ok(source.includes(`tab === '${id}' &&`), `the ${id} section is in the strip with nothing to draw`);
  }
});

test('every colour input in the cockpit is the shared field', () => {
  const owners: string[] = [];
  for (const path of readdirSync('web/src/components').filter((f) => f.endsWith('.tsx'))) {
    const source = readFileSync(join('web/src/components', path), 'utf8');
    if (source.includes('type="color"')) owners.push(path);
  }
  assert.deepEqual(owners, ['ColourField.tsx'], 'a second colour input has appeared beside the shared one');
});

test('the tracker-state colour picker draws the shared field', () => {
  const entry = {
    path: 'issueStateColours',
    value: { 'In Review': '#ff8800' },
    isDefault: false,
    type: 'colourMap' as const,
    access: 'plain' as const,
    live: false,
    env: null,
    why: 'The colour a state chip draws in',
  };
  const html = renderToStaticMarkup(
    createElement(ConfigValues, {
      payload: {
        groups: [{ title: 'Features', entries: [entry] }],
        file: 'lubbdubb.config.json',
        projectFile: null,
        text: '{}',
        revision: 'abc123',
        pending: [],
        canRestart: false,
      },
      staged: { set: {}, clear: [] },
      saved: null,
      group: 'Features',
      control: { cap: 2, paused: false },
      states: ['In Review', 'Done'],
      onGroup: () => undefined,
      onStage: () => undefined,
      onReview: () => undefined,
      onReloaded: () => undefined,
    }),
  );
  assert.ok(html.includes('cfg-colours'), 'the colourMap widget is drawn');
  assert.match(html, /class="cf"/, 'and the swatch is the shared colour field');
  assert.ok(html.includes('value="#ff8800"'), 'showing the operator’s colour');
  assert.ok(html.includes('aria-label="Colour for In Review"'), 'named for the state it colours');
  assert.ok(html.includes('value="Done"'), 'an uncoloured state is offered in the datalist');
});

test('a key the staged config requires is marked, offered a value, and blocks the write', () => {
  const html = renderToStaticMarkup(
    createElement(ConfigValues, {
      payload: {
        groups: [
          {
            title: 'Integrations',
            entries: [
              {
                path: 'integrations.pool',
                value: 'fake',
                isDefault: true,
                type: 'enum' as const,
                options: ['fake', 'git'],
                access: 'plain' as const,
                live: false,
                env: null,
                why: 'Which substrate carries the cross-fleet pool.',
              },
              {
                path: 'fleetId',
                value: '',
                isDefault: true,
                type: 'string' as const,
                access: 'plain' as const,
                live: false,
                env: null,
                why: 'Who this fleet is in the pool.',
                requiredWhen: { path: 'integrations.pool', unless: 'fake' },
                suggestion: 'adam@lubbdubb',
              },
            ],
          },
        ],
        file: 'lubbdubb.config.json',
        projectFile: null,
        text: '{}',
        revision: 'abc123',
        pending: [],
        canRestart: false,
      },
      staged: { set: { 'integrations.pool': 'git' }, clear: [] },
      saved: null,
      group: 'Integrations',
      control: { cap: 2, paused: false },
      states: [],
      onGroup: () => undefined,
      onStage: () => undefined,
      onReview: () => undefined,
      onReloaded: () => undefined,
    }),
  );
  assert.ok(html.includes('cfg-need'), 'the row is marked as needed');
  assert.ok(html.includes('cfg-suggest'), 'the suggestion is offered as a control');
  assert.ok(html.includes('adam@lubbdubb'), 'and it is userId@pool.project');
  assert.match(
    html,
    /<button[^>]*\bdisabled=""[^>]*>Review &amp; write<\/button>/,
    'the write is refused while the requirement is unmet',
  );
  assert.match(
    html,
    /<button[^>]*class="btn btn primary small"[^>]*>Review &amp; write<\/button>/,
    'and it is still the surface\u2019s primary control',
  );
  assert.ok(html.includes('fleetId is needed while'), 'and the save bar says which key and why');
});

test('a required key that is filled in does not block the write', () => {
  const html = renderToStaticMarkup(
    createElement(ConfigValues, {
      payload: {
        groups: [
          {
            title: 'Integrations',
            entries: [
              {
                path: 'integrations.pool',
                value: 'git',
                isDefault: false,
                type: 'enum' as const,
                options: ['fake', 'git'],
                access: 'plain' as const,
                live: false,
                env: null,
                why: 'Which substrate carries the cross-fleet pool.',
              },
              {
                path: 'fleetId',
                value: 'adam@lubbdubb',
                isDefault: false,
                type: 'string' as const,
                access: 'plain' as const,
                live: false,
                env: null,
                why: 'Who this fleet is in the pool.',
                requiredWhen: { path: 'integrations.pool', unless: 'fake' },
                suggestion: 'adam@lubbdubb',
              },
            ],
          },
        ],
        file: 'lubbdubb.config.json',
        projectFile: null,
        text: '{}',
        revision: 'abc123',
        pending: [],
        canRestart: false,
      },
      staged: { set: { fleetId: 'adam@lubbdubb' }, clear: [] },
      saved: null,
      group: 'Integrations',
      control: { cap: 2, paused: false },
      states: [],
      onGroup: () => undefined,
      onStage: () => undefined,
      onReview: () => undefined,
      onReloaded: () => undefined,
    }),
  );
  assert.ok(!html.includes('cfg-need'), 'nothing is marked as needed');
  assert.ok(!html.includes('cfg-suggest'), 'and the offer is gone');
});

test('the shared colour field keeps the alpha a picker cannot express', () => {
  const seen: string[] = [];
  const html = renderToStaticMarkup(
    createElement(ColourField, { value: '#00000099', label: 'Modal scrim', onChange: (v) => seen.push(v) }),
  );
  assert.ok(html.includes('value="#000000"'), 'the picker is handed #rrggbb');
  assert.ok(html.includes('value="#00000099"'), 'the hex field shows the whole value');
  assert.equal(seen.length, 0);
});

test('a refused colour is marked and still shown', () => {
  const html = renderToStaticMarkup(
    createElement(ColourField, { value: '#no', label: 'Border', valid: false, onChange: () => undefined }),
  );
  assert.match(html, /class="cf-hex bad"/, 'the field is marked');
  assert.ok(html.includes('value="#no"'), 'and what was typed is left on screen rather than swallowed');
});

test('the theme section draws a preset picker, the token rows and the save bar', () => {
  const html = renderToStaticMarkup(createElement(ThemeSettings));
  for (const preset of PRESETS) {
    assert.ok(html.includes(`data-theme-swatch="${preset.id}"`), `${preset.id} has no preview card`);
  }
  assert.ok(html.includes('--panel-2'), 'a row names the property, not only its label');
  assert.ok(html.includes('The slightly recessed face inside a card'), 'and says what moving it changes');
  assert.ok(html.includes('Dark, unmodified'), 'the bar states where the theme stands');
  assert.ok(!html.includes('--cn-violet-line'), 'an advanced group must start folded');
});

test('a goal with no measured spend draws no spend row rather than $0.00', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');

  const measured = render({
    ...v,
    goalPage: {
      ...page,
      issue: {
        ...page.issue,
        spend: {
          originRef: `issue:${page.issue.number}`,
          issueNumber: page.issue.number,
          costUsd: 6.4,
          localRuns: 0,
          inputTokens: 0,
          outputTokens: 0,
          agents: 7,
        },
      },
    },
  });
  assert.ok(measured.includes('$6.40'), 'a measured goal states what it cost');
  assert.ok(!measured.includes('Local runs'), 'a goal nobody ran locally names no such row');

  const previewed = render({
    ...v,
    goalPage: {
      ...page,
      issue: {
        ...page.issue,
        spend: {
          originRef: `issue:${page.issue.number}`,
          issueNumber: page.issue.number,
          costUsd: 7.1,
          localRuns: 2,
          inputTokens: 0,
          outputTokens: 0,
          agents: 7,
        },
      },
    },
  });
  assert.ok(previewed.includes('Local runs'), 'money no agent spent has to be accounted for on the card');

  const unmeasured = render({ ...v, goalPage: { ...page, issue: { ...page.issue, spend: null } } });
  assert.ok(!unmeasured.includes('$0.00'), 'null is "never measured", not zero');
});

test('with no goal selected the overview draws its cards, and neither feed is one of them', () => {
  const html = render(view());
  for (const title of ['Fleet', 'Goals in flight', 'Pull requests']) {
    assert.ok(html.includes(title), `the overview is missing ${title}`);
  }
  assert.ok(!html.includes('World signals'), 'world signals is still drawing on the overview');
  assert.ok(
    html.includes('Up next is determined by world signals'),
    'the fleet card offers no way to the signals the queue is decided off',
  );
  assert.ok(!html.includes('<h3>Up next'), 'the queue is still drawing as a card of its own');
  assert.match(html, /\d+ queued/, 'the fleet card does not say how much is queued behind it');
});

test('an unwell environment reads on the bar, and no card draws it', () => {
  const v = view();
  const html = render(v);
  assert.ok(html.includes('cn-env-ill'), 'the bar does not carry the unwell environment');
  assert.ok(!html.includes('<h3>Environments'), 'the overview is still drawing the card');
});

test('the environments panel draws every reading, in the check’s own words', () => {
  const v = view();
  const html = decode(render({ ...v, consolePanel: 'environments' }));
  assert.ok(html.includes('Pipeline failing'), 'the check’s own words, drawn verbatim');
  assert.ok(html.includes('not well'), 'and what they add up to, in the operator’s words');

  const none = decode(render({ ...v, consolePanel: 'environments', state: { ...v.state, environmentHealth: [] } }));
  assert.ok(none.includes('No environment declares a health check'), 'an empty panel that explains nothing');
});

test('the queue’s asks are counted on the glass, not folded away with the rows', () => {
  const v = view();
  const items = v.upNext;
  const asking = items.filter((i) => i.status === 'unapproved').length;
  const text = decode(render(v).replace(/<[^>]*>/g, ''));
  assert.ok(text.includes(`${items.length} queued`), 'the fleet card does not state the size of its queue');
  if (asking > 0) assert.ok(text.includes(`${asking} on you`), 'a queued ask is folded away with nothing saying so');
});

test('an empty rack still draws — a surface that vanishes reads as one that broke', () => {
  const v = view();
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, pullRequests: [] } } });
  assert.ok(html.includes('Pull requests'));
});

test('an unwatched PR is drawn spent, not at the same weight as the ones being worked', () => {
  const v = view();
  const prs = v.state.world.pullRequests;
  const first = prs[0];
  assert.ok(first, 'the demo fixtures must carry an open PR');
  const ignored = {
    ...first,
    labels: [],
    attention: {
      status: 'unwatched' as const,
      reasons: [`not tagged "${v.state.config.watchLabel}" — the harness is leaving it alone`],
    },
  };
  const html = render({
    ...v,
    state: { ...v.state, world: { ...v.state.world, pullRequests: [ignored, ...prs.slice(1)] } },
  });
  const row = html.split('<div class="cn-row').find((chunk) => chunk.includes(ignored.title));
  assert.ok(row, 'the unwatched PR is still listed — one that vanishes is the other bug');
  assert.ok(row.slice(0, row.indexOf('"')).includes('cn-spent'), 'the unwatched PR’s row carries the spent tone');
  assert.ok(row.includes('Tag this PR'), 'the watch switch does not read as one that is off');
  assert.ok(!row.includes('>unwatched</button>'), 'the rack drew the court as a word again');
  assert.ok(!row.includes('cn-rowsub'), 'an unwatched row spent a second line on what it is waiting for');
  assert.ok(!row.includes('the harness is leaving it alone'), 'the row drew a reason nobody will read');
});

test('a goal row is a way into its page', () => {
  const html = render(view());
  assert.ok(html.includes('cn-goal-row'));
});

test('a goal the appraisal refused is raised on the rail, quoted whole, with its override under it', () => {
  const v = view();
  const row = v.needsYou.find((n) => n.kind === 'intake');
  assert.ok(row, 'the demo fixtures must carry a goal the appraisal refused');
  const appraisal = v.state.world.issues.find((i) => `issue:${i.number}` === row.goalRef)?.appraisal;
  assert.ok(appraisal);

  const decoded = decode(render({ ...v, consolePanel: { ask: row.id } }));
  assert.ok(decoded.includes('could not say this is workable'), 'the band names what is holding the work');
  assert.ok(decoded.includes(appraisal.summary), 'the appraiser’s own words are quoted, never reworded');
  assert.ok(decoded.includes('Override → workable'), 'and the one button that unblocks it sits under them');
});

test('a goal nothing is holding raises no intake row at all', () => {
  const v = view();
  const issues = v.state.world.issues.map((i) => ({ ...i, appraisal: null }));
  const cleared = buildNeedsYou({ ...v.state, world: { ...v.state.world, issues } });
  assert.equal(cleared.filter((r) => r.kind === 'intake').length, 0, 'no goal is held, so nothing claims one is');
});

test('the tickets tab is where unrecorded work is triaged', () => {
  const src = readFileSync(fileURLToPath(new URL('../web/src/components/TicketsPanel.tsx', import.meta.url)), 'utf8');
  assert.ok(/import\s+\{[^}]*UnrecordedWork/.test(src), 'the tickets tab must mount the unrecorded-work call-out');
  assert.ok(src.includes('<UnrecordedWork'), 'and render it, not merely import it');

  assert.ok(!render(view({ tab: 'tickets' })).includes('Unrecorded work'));
});

test('the fault log keeps its clear even when it is empty', () => {
  const v = view({ consolePanel: 'faults' });
  const html = render({ ...v, state: { ...v.state, errors: [] } });
  assert.ok(html.includes('Clear'), 'the only route to clear must not depend on there being rows');

  const full = render(v);
  const first = v.state.errors[0];
  assert.ok(first, 'the demo fixtures must carry a recorded fault');
  assert.ok(
    full.indexOf('Clear') < full.indexOf(first.message),
    'one misclick between “leave” and “delete the only copy” is too few',
  );
});

test('a reading opens the panel behind it, in front of the console', () => {
  const panels: [ConsolePanel, string][] = [
    ['faults', 'Faults'],
    ['launch', 'Launch'],
  ];
  for (const [panel, title] of panels) {
    const html = render(view({ consolePanel: panel }));
    assert.ok(html.includes('cn-backdrop'), `${String(panel)} must draw in front of the console`);
    assert.ok(html.includes(`<h2>${title}</h2>`), `${String(panel)} must name itself`);
  }
});

test('the local run panel names the ref each goal would run', () => {
  const v = view({ consolePanel: 'localRun' });
  const runnable = v.state.localRunTargets.filter((t) => t.runnable);
  assert.ok(runnable.length > 0, 'the demo fixtures must carry a goal with a branch of its own');
  const html = decode(render(v));
  for (const target of runnable) assert.ok(html.includes(target.target.ref), `no row names ${target.target.ref}`);

  const orphan = runnable.find((t) => t.target.pr === null);
  if (orphan) assert.ok(html.includes('no pull request of its own'));
});

test('the local run panel states what the run holding the environment has cost', () => {
  const v = view({ consolePanel: 'localRun' });
  const run = v.state.localRun;
  assert.ok(run?.costUsd != null, 'the demo fixture must carry a measured run');
  const html = decode(render(v));
  assert.ok(html.includes(`$${run.costUsd.toFixed(2)}`), 'the run’s own cost is not on the panel');

  const unmeasured = decode(
    render({ ...v, state: { ...v.state, localRun: { ...run, costUsd: null, numTurns: null } } }),
  );
  assert.ok(!unmeasured.includes('$0.00'), 'null is "never measured", not zero');
});

test('the local run panel offers its filter when the filter is what is hiding the rows', () => {
  const base = view({ consolePanel: 'localRun' });
  const withState = (localRunTargets: CockpitView['state']['localRunTargets']): CockpitView => ({
    ...base,
    state: { ...base.state, localRunTargets },
  });

  const held = decode(render(withState(base.state.localRunTargets.map((t) => ({ ...t, runnable: false })))));
  assert.ok(held.includes('show every goal'), 'the control that would reveal them must be on screen');
  assert.ok(held.includes('would run the integration branch'), 'and the message must say what ticking it does');

  const nothing = decode(render(withState([])));
  assert.ok(nothing.includes('nowhere to run yet') || nothing.includes('anywhere to run yet'));
  assert.ok(!nothing.includes('show every goal'), 'a filter that can reveal nothing must not be drawn');
});

test('the local run panel draws the readings and offers Refresh only while behind the tip', () => {
  const v = view({ consolePanel: 'localRun' });
  const run = v.state.localRun;
  assert.ok(run?.ports?.listening != null && run.freshness?.behindTip != null, 'the demo fixture must carry readings');
  assert.ok(run.freshness.behindTip > 0, 'and be behind its tip, so the control has a reason to exist');
  const html = decode(render(v));
  for (const port of run.ports.listening) assert.ok(html.includes(String(port)), `port ${String(port)} is not drawn`);
  assert.ok(html.includes(`${String(run.freshness.behindTip)} commits behind the tip`));
  assert.ok(html.includes('Move the checkout to the tip of'), 'the Refresh control is offered');

  const withRun = (localRun: typeof run): string => decode(render({ ...v, state: { ...v.state, localRun } }));
  const current = withRun({ ...run, freshness: { ...run.freshness, behindTip: 0 } });
  assert.ok(!current.includes('Move the checkout to the tip of'), 'nothing to pick up, no control');
  assert.ok(current.includes('>current<'));
  const unknown = withRun({ ...run, freshness: null });
  assert.ok(!unknown.includes('Move the checkout to the tip of'));
  assert.ok(unknown.includes('>not checked<'), 'null is "not checked", never a zero');
  const unreadable = withRun({ ...run, ports: { ...run.ports, listening: null } });
  assert.ok(unreadable.includes('>could not read<'), 'and a lister that could not say says so');
});

test('the local run panel offers the message box only while something holds an idle session', () => {
  const v = view({ consolePanel: 'localRun' });
  const run = v.state.localRun;
  assert.ok(run !== null && run.holdsSession && run.status === 'running' && run.turn === null);
  const withRun = (localRun: typeof run): string => decode(render({ ...v, state: { ...v.state, localRun } }));
  assert.ok(withRun(run).includes('Tell the session something'));
  assert.ok(!withRun({ ...run, holdsSession: false }).includes('Tell the session something'));
  const busy = withRun({ ...run, turn: 'message' });
  assert.ok(!busy.includes('Tell the session something'), 'one turn at a time');
  assert.ok(busy.includes('replying'), 'and the stage line says which turn is in flight');
});

function orphanAsk(): { v: CockpitView; row: CockpitView['needsYou'][number] } {
  const base = view();
  const found = base.needsYou.find((n) => n.kind === 'escalation' || n.kind === 'plan' || n.kind === 'permission');
  assert.ok(found, 'the demo fixtures must carry an escalation to build the orphan from');
  const row = { ...found, goalRef: null, originRef: 'pr:9999', opens: 'ask' as const };
  return { v: { ...base, needsYou: [row, ...base.needsYou.filter((n) => n.id !== row.id)] }, row };
}

test('an ask with no goal page is answered in the ask panel', () => {
  const { v, row } = orphanAsk();

  const html = render({ ...v, consolePanel: { ask: row.id } });
  assert.ok(html.includes('cn-backdrop'), 'the ask must draw in front of the console');
  assert.ok(
    html.includes(`<h2>${KIND_SYMBOL[row.kind]} Needs you · ${KIND_LABEL[row.kind]}</h2>`),
    'the panel names the ask the rail named, under the same glyph',
  );
  assert.ok(html.includes('escalation-prompt'), 'the panel embeds the shared escalation card');
});

test('the ask panel says what the ask is about, and says so when there is no goal', () => {
  const { v, row } = orphanAsk();
  const orphan = decode(render({ ...v, consolePanel: { ask: row.id } }));
  assert.match(orphan, /No linked goal/, 'an ask with no goal must say so in those words');
  assert.match(orphan, /#9999/, 'and still name the pull request it was raised on');

  const onGoal = v.needsYou.find((n) => n.goalRef !== null);
  assert.ok(onGoal, 'the demo fixtures must carry an ask that names a goal');
  const linked = decode(render({ ...v, consolePanel: { ask: onGoal.id } }));
  assert.match(linked, /On goal/);
  assert.match(linked, new RegExp(`cn-goto[^<]*>\\s*${onGoal.goalRef!.replace('issue:', '#')}`));
});

test('the ask panel closes itself once the row it was drawing is settled', () => {
  const v = view();
  const row = v.needsYou[0];
  assert.ok(row, 'the demo fixtures must carry an ask');

  const html = render({ ...v, consolePanel: { ask: row.id }, needsYou: v.needsYou.filter((n) => n.id !== row.id) });
  assert.ok(!html.includes('cn-backdrop'), 'a settled ask must not leave a panel standing');
});

test('injection rides in the launch panel, and the demo build is the whole of it', () => {
  assert.match(render(view({ consolePanel: 'launch' })), /class="inject"/);
  assert.doesNotMatch(
    render(view({ consolePanel: 'launch', demo: false })),
    /class="inject"/,
    'a real run must not offer a panel that lies to the harness',
  );
});

test('each tab replaces the last, and a selected goal outranks every one of them', () => {
  assert.ok(render(view()).includes('Goals in flight'), 'the overview is the tab the console opens on');
  assert.ok(!render(view({ tab: 'tickets' })).includes('Goals in flight'), 'a tab replaces the one before it');
  assert.ok(!render(view({ tab: 'insights' })).includes('Goals in flight'));

  const v = goalView();
  for (const tab of ['tickets', 'insights'] as const) {
    assert.ok(render({ ...v, tab }).includes('cn-goal'), `a goal must outrank the ${tab} tab`);
  }
});

test('the work graph is a panel reached from the bar, not a nav destination', () => {
  const nav = render(view()).split('</nav>')[0] ?? '';
  for (const label of ['Overview', 'Tickets', 'Obstacles', 'Insights']) {
    assert.ok(nav.includes(`>${label}`), `the nav is missing ${label}`);
  }
  assert.ok(!nav.includes('>Work'), 'the record is not a nav destination — it is the Record reading');
  assert.ok(
    menuEntries(view(), actions).some((entry) => entry.key === 'record'),
    'and the bar carries the way to it',
  );
  assert.ok(render(view()).includes('aria-haspopup="menu"'), 'with nothing on the bar to open the menu it is in');

  const panel = render(view({ consolePanel: 'record' }));
  assert.ok(panel.includes('The record'), 'the panel names itself');
  assert.ok(!render(view()).includes('The record'), 'and nothing draws it unopened');

  assert.ok(render({ ...goalView(), consolePanel: 'record' as ConsolePanel }).includes('The record'));
});

test('Insights is where the three cost readings went, and they did not stay behind', () => {
  const bar = render(view()).split('</div>')[0] ?? '';
  const full = render(view());
  for (const gone of ['>Spend<', '>Yield<', '>Output<']) {
    assert.ok(!full.includes(gone), `${gone} must not be on the bar beside the page that replaced it`);
  }
  assert.ok(!bar.includes('Yield'), 'the bar states a subject once');

  const page = render(view({ tab: 'insights' }));
  assert.ok(page.includes('insights-bar'), 'the Insights tab draws its window control');
  assert.ok(!page.includes('read-backdrop'), 'Insights is a destination, not a modal over the console');
  assert.ok(page.includes('cn-rail'), 'the queue rail stays in frame while a reading is open');
  assert.ok(!render(view()).includes('insights-bar'), 'and no other tab draws it');
});

test('the shell renders the console, and the drawer that the console only asks for', () => {
  const src = readFileSync(fileURLToPath(new URL('../web/src/App.tsx', import.meta.url)), 'utf8');
  assert.ok(src.includes('ConsoleRoot'), 'the shell must render the console');
  assert.ok(src.includes('AgentDrawer'), 'the shell must answer the console’s request for a drawer');
  assert.ok(!/import\s+\{[^}]*RecordPanel/.test(src), 'the shell must not import the work graph');
  assert.ok(!src.includes('<RecordPanel'), 'the work graph is a console panel, not a strip under the shell');
});

test('the way to the tracker is always drawn, and prefers the unambiguous key', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const n = page.issue.number;
  const noUrl = { ...page, issue: { ...page.issue, url: undefined } };

  const both = render({
    ...v,
    state: {
      ...v.state,
      refUrls: {
        ...v.state.refUrls,
        [`#${n}`]: 'https://tracker/pull/collision',
        [`issue:${n}`]: 'https://tracker/browse/right',
      },
    },
    goalPage: noUrl,
  });
  const opener = /<a[^>]*href="([^"]*)"[^>]*>(?:<svg(?:(?!<\/svg>)[\s\S])*<\/svg>)?Open ticket/.exec(both);
  assert.ok(opener, 'the control is drawn as a link when there is somewhere to go');
  assert.equal(opener[1], 'https://tracker/browse/right', 'the goal’s own ref wins over the number a PR shares');

  const nowhere = render({ ...v, state: { ...v.state, refUrls: {} }, goalPage: noUrl });
  assert.ok(nowhere.includes('Open ticket'), 'the row’s shape must not depend on what a provider resolved');
  assert.ok(nowhere.includes('aria-disabled="true"'), 'and it says it is unavailable rather than pretending');
  assert.ok(
    !/<a[^>]*>(?:<svg(?:(?!<\/svg>)[\s\S])*<\/svg>)?Open ticket/.test(nowhere),
    'a link that leads nowhere is the dead end refs exist to prevent, so it stops being one',
  );
});

const envRead = (over: Partial<EnvironmentHealthReading> & { environment: string }): EnvironmentHealthReading => ({
  state: 'healthy',
  tier: null,
  reasons: [],
  detail: null,
  observedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  changedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
  ...over,
});

test('the environments chip reads the worst environment, as a count and a word', () => {
  const now = Date.now();
  const red = environmentsReading(
    [
      envRead({ environment: 'liveUk' }),
      envRead({ environment: 'testUk', state: 'unhealthy', tier: 'red', reasons: ['Solr down'] }),
      envRead({ environment: 'liveEu', state: 'unhealthy', tier: 'orange' }),
    ],
    now,
  );
  assert.equal(red.value, '1 red');
  assert.equal(red.tone, 'ill');
  assert.equal(red.quiet, false);
  assert.match(red.title, /testUk is not well/);

  const two = environmentsReading(
    [
      envRead({ environment: 'a', state: 'unhealthy', tier: 'red' }),
      envRead({ environment: 'b', state: 'unhealthy', tier: 'red' }),
      envRead({ environment: 'c', state: 'unhealthy', tier: 'orange' }),
    ],
    now,
  );
  assert.equal(two.value, '2 red');
});

test('an untiered unhealthy ranks and draws with a red, not below an orange', () => {
  const reading = environmentsReading(
    [
      envRead({ environment: 'liveEu', state: 'unhealthy', tier: 'orange' }),
      envRead({ environment: 'testUk', state: 'unhealthy', tier: null, reasons: ['down'] }),
    ],
    Date.now(),
  );
  assert.equal(reading.value, '1 not well');
  assert.equal(reading.tone, 'ill');
});

test('a check that could not answer is amber and says so, never green and never red', () => {
  const reading = environmentsReading(
    [envRead({ environment: 'liveUk' }), envRead({ environment: 'liveEu', state: 'unknown', detail: 'exit 127' })],
    Date.now(),
  );
  assert.equal(reading.value, '1 no answer');
  assert.equal(reading.tone, 'watch');
  assert.match(reading.title, /liveEu did not answer/);
});

test('a well fleet mutes the chip rather than moving it', () => {
  const reading = environmentsReading(
    [envRead({ environment: 'liveUk' }), envRead({ environment: 'liveEu' })],
    Date.now(),
  );
  assert.equal(reading.value, '2 well');
  assert.equal(reading.quiet, true);
  assert.equal(reading.tone, null);
});

test('the environments row is absent, not zeroed, where no environment declares a check', () => {
  const v = view();
  const none = menuEntries({ ...v, state: { ...v.state, environmentHealth: [] } }, actions);
  assert.ok(!none.some((entry) => entry.key === 'env'), 'no environment health, no row');

  const withOne = menuEntries(
    {
      ...v,
      state: { ...v.state, environmentHealth: [envRead({ environment: 'testUk', state: 'unhealthy', tier: 'red' })] },
    },
    actions,
  );
  const env = withOne.find((entry) => entry.key === 'env');
  assert.ok(env !== undefined, 'and it is drawn as soon as one environment answers');
  assert.equal(env.tone, 'ill', 'wearing the tint its worst reading earns');
});

test('the chip is absent while every environment is well, and while none declares a check', () => {
  const v = view();
  const envs = (readings: EnvironmentHealthReading[]): string =>
    render({ ...v, state: { ...v.state, environmentHealth: readings } });

  assert.ok(!envs([]).includes('cn-env-'), 'no environment health, no chip');
  assert.ok(!envs([envRead({ environment: 'liveUk' })]).includes('cn-env-'), 'a well environment says nothing');
  assert.ok(
    envs([envRead({ environment: 'liveEu', state: 'unknown', detail: 'exit 127' })]).includes('cn-env-watch'),
    'a check that could not answer went quiet',
  );
  assert.ok(
    envs([envRead({ environment: 'testUk', state: 'unhealthy', tier: 'red' })]).includes('cn-env-ill'),
    'an outage must be impossible to miss',
  );
});

test('the goal header offers Validate locally only where an agent could run it', () => {
  const ref = 'issue:390';
  const offered = render(goalView(() => undefined, ref));
  assert.ok(offered.includes('Validate locally'), 'a runnable, configured goal with nothing in flight');
  assert.ok(offered.includes('Check the work'), 'the group caption is what explains the control under it');

  const noBranch = decode(
    render(
      goalView((state) => {
        const target = state.localRunTargets.find((t) => t.issueNumber === 390);
        if (target) target.runnable = false;
      }, ref),
    ),
  );
  assert.ok(!noBranch.includes('Validate locally'));
  assert.ok(noBranch.includes('no branch of its own'), 'the card says why the control is not there');

  const unconfigured = decode(
    render(
      goalView((state) => {
        state.config.localRunConfigured = false;
      }, ref),
    ),
  );
  assert.ok(!unconfigured.includes('Validate locally'));
  assert.ok(unconfigured.includes('localRun.instruction'), 'and names the field that would fix it');

  const inFlight = decode(
    render(
      goalView((state) => {
        const goal = state.world.issues.find((i) => i.number === 390);
        if (goal?.localValidation)
          goal.localValidation = { ...goal.localValidation, status: 'dispatched', phase: 'driving' };
      }, ref),
    ),
  );
  assert.ok(!inFlight.includes('Validate locally'));
  assert.ok(inFlight.includes('running the plan'), 'the chip says which minute of it we are in');
});

test('the local validation chip words each phase of a run in flight', () => {
  const ref = 'issue:390';
  const said: [string, string][] = [
    ['queued', 'waiting for a slot'],
    ['planning', 'writing the test plan'],
    ['environment', 'waiting for the environment'],
    ['driving', 'running the plan'],
  ];
  for (const [phase, words] of said) {
    const html = decode(
      render(
        goalView((state) => {
          const goal = state.world.issues.find((i) => i.number === 390);
          if (goal?.localValidation)
            goal.localValidation = {
              ...goal.localValidation,
              status: phase === 'queued' ? 'pending' : 'dispatched',
              phase: phase as never,
            };
        }, ref),
      ),
    );
    assert.ok(html.includes(words), `phase "${phase}" reads as "${words}"`);
  }
});

test('the local validation card draws the findings, the pages and the plan it ran', () => {
  const html = decode(render(goalView(() => undefined, 'issue:390', ['localValidation'])));
  assert.ok(html.includes('A job with no schema is accepted'), 'the finding');
  assert.ok(html.includes('blocker'), 'and what it is worth');
  assert.ok(html.includes('http://localhost:5173/jobs/new'), 'the page it was found on');
  assert.ok(html.includes('The test plan it wrote'), 'the plan, folded');
  assert.ok(html.includes('<details'), 'a browser-owned fold, not a Place');
  assert.ok(html.includes('an agent, in your own dev environment'));
});

test('a passed local validation reads settled and offers nothing to do', () => {
  const html = decode(
    render(
      goalView(
        (state) => {
          const goal = state.world.issues.find((i) => i.number === 390);
          if (goal?.localValidation)
            goal.localValidation = { ...goal.localValidation, status: 'passed', findings: [], phase: null };
        },
        'issue:390',
        ['localValidation'],
      ),
    ),
  );
  assert.ok(html.includes('cn-lv-passed'), 'drawn a step back');
  assert.ok(!html.includes('Call it off'), 'there is nothing left to call off');
  assert.ok(!html.includes('blocker'), 'and nothing outstanding to draw');
});

test('the local run panel offers Validate only while the environment is idle', () => {
  const panel = (mutate: (state: CockpitView['state']) => void = () => undefined): string => {
    const state = buildDemoState().state;
    mutate(state);
    return decode(
      render({
        ...buildViewModel({
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
          consolePanel: 'localRun',
          tab: 'overview',
        }),
      }),
    );
  };

  assert.ok(panel().includes('Validate #'), 'an idle, running environment');
  assert.ok(
    !panel((state) => {
      if (state.localRun) state.localRun = { ...state.localRun, turn: 'message' };
    }).includes('Validate #'),
    'a turn in flight is not a moment to start one',
  );
  assert.ok(
    !panel((state) => {
      if (state.localRun) state.localRun = { ...state.localRun, status: 'starting' };
    }).includes('Validate #'),
    'nor is an environment still coming up',
  );
});
