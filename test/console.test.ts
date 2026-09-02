import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// `fileURLToPath`, never `URL.pathname`: on Windows the latter yields
// `/C:/…`, which `fs` reads as the relative path `C:\C:\…` — so every
// structural guard in this file threw ENOENT rather than asserting, and a
// violation of the rule it pins would have merged green on that platform.

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { EnvironmentHealthReading } from '../web/src/types.js';
import type { GoalPartView } from '../web/src/view/goalPage.js';
import type { CockpitActions, ConsolePanel } from '../web/src/cockpit/actions.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from '../web/src/console/QueueRail.js';
import { buildNeedsYou } from '../web/src/view/needsYou.js';
import { PRESETS } from '../web/src/cockpit/theme.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the console's modules load so the test exercises the same sources.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { Panel } = await import('../web/src/console/Panel.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');
const { ThemeSettings } = await import('../web/src/components/ThemeSettings.js');
const { ColourField } = await import('../web/src/components/ColourField.js');
const { ConfigValues } = await import('../web/src/components/ConfigValues.js');
const { RaiseIssueModal, composeGate, canFile } = await import('../web/src/components/RaiseIssueModal.js');
const { usageReading, environmentsReading } = await import('../web/src/console/TopBar.js');

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

/**
 * The console as the shell mounts it — inside `RefLinks`, because every reference
 * it draws resolves against that and a `<Ref>` outside it throws rather than
 * quietly rendering a number with no link on it.
 */
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

/**
 * The same rule, at the one selector shape that gets past the check above. `.cn`
 * *contains* nearly every shared component the cockpit embeds, so `.cn textarea`
 * names no shared class and reaches all of them anyway — at (0,1,1), which outranks
 * the single class each one styles itself with. There was one, and it was silently
 * redrawing five components' note boxes and overriding the `rows` their callers
 * chose. The console's own fields wear `.cn-in`, which reaches only what it is put
 * on. → docs/spec/17-cockpit.md#fields
 */
test('console.css reaches no form control through .cn', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/console/console.css', import.meta.url)), 'utf8');
  const offenders = [...css.matchAll(/^\s*(\.cn[\w-]*\s+(?:input|textarea|select|option)\b[^,{]*)/gm)].map((m) =>
    m[1]!.trim(),
  );
  assert.deepEqual(offenders, [], 'a descendant element rule restyles the components the console embeds');
});

/**
 * The why marker's bubble, which is positioned against the **row** rather than
 * against the 16px marker so that it cannot leave the card whatever the marker's
 * position in the row — and stays positioned against the row past its own cap.
 *
 * `left` + `right` + `max-width` is an over-constrained absolutely positioned box,
 * and CSS resolves that by dropping the `right` offset: the bubble silently stopped
 * spanning the row on every card wider than the cap and hugged the row's left edge
 * instead, 420px of it under the *title* rather than under the marker it explains.
 * An auto inline margin is what is not dropped — the slack goes to the margins and
 * the two edges keep the box between them.
 *
 * Asserted here because nothing else in `npm run check` reads a stylesheet, and the
 * failure has nothing to show for itself: the sheet is valid, both offsets are
 * written down, and only a wide card renders the difference.
 * → docs/spec/17-cockpit.md#the-row-grammar
 */
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

/**
 * The Usage chip (docs/spec/17-cockpit.md#the-usage-chip). Four things about it are
 * load-bearing and not one of them shows in a screenshot of the resting state.
 *
 * **Both windows are drawn, in a fixed order.** Either one parks the fleet, so a chip
 * carrying only the five-hour reads fine on the morning a weekly allowance runs out —
 * and a chip that reordered itself by which is worse would move the number an
 * operator glances at without reading.
 *
 * **The binding window is marked and the tone follows it**, or the chip is two
 * numbers and a shrug: the comparison is the work it exists to have already done.
 *
 * **A window nothing reported is an em dash**, because each is independently nullable
 * and `0%` would claim a fresh allowance nobody measured.
 *
 * **The fallback is the whole of what the chip does on API-key auth** and on a fleet
 * that has not taken a turn — `rateLimits` is null far more often than not, and a chip
 * that went blank there is a hole in the bar where the reading was.
 */
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

  // The weekly is the one about to stop the fleet; the five-hour has room. A chip
  // reading only the five-hour would call this fine.
  const weekly = usageReading(limits(31, 93), now);
  assert.deepEqual(
    weekly.slots.map((s) => `${s.label} ${s.value}${s.binds ? '*' : ''}`),
    ['5h 31%', '7d 93%*'],
    'the slots must stay five-hour then weekly, with the window nearer its limit marked',
  );
  assert.equal(weekly.tone, 'spent', 'the tone reads the window that binds, not the first one');
  assert.equal(weekly.age, null, 'a minute-old reading is current — the age is the stale caveat, not a timestamp');

  // The other direction, and the resting state: same order, the other slot marked.
  const fiveHour = usageReading(limits(62, 30), now);
  assert.deepEqual(
    fiveHour.slots.map((s) => `${s.label} ${s.value}${s.binds ? '*' : ''}`),
    ['5h 62%*', '7d 30%'],
  );
  assert.equal(fiveHour.tone, 'plain');

  // An unreported window never binds, whatever the reported one says.
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

/** And it is on the bar, both windows and all — the demo fixture reports 62% / 30%. */
test('the usage chip is on the top bar', () => {
  const html = render(view());
  assert.ok(/<span>Usage<\/span>/.test(html), 'the top bar draws no usage reading');
  assert.ok(html.includes('cn-usage-win'), 'the chip drew no window slots');
  assert.ok(html.includes('cn-binds'), 'neither window is marked as the one nearer its limit');
});

test('a dropped socket draws no gauge, no rail and no situation area', () => {
  const html = render(view({ connected: false }));
  assert.ok(html.includes('Off the air'));
  assert.ok(!html.includes('cn-rail'), 'the rail must not render while offline');
  assert.ok(!html.includes('cn-sit'), 'the situation area must not render while offline');
});

/**
 * The way to report a fault in LubbDubb is on the bar whether the harness is
 * talking to us or not (#404), and the offline arm is a whole second return in
 * `TopBar` — the one a change would forget, and the state an operator is most
 * likely to have something to file about.
 *
 * The href is pinned to the new-issue *form*, not the repo or the issue list: the
 * feature is the click count, and a link that lands one page short of writing
 * anything down still reads as done.
 */
test('the bar offers LubbDubb’s own tracker, online and off', () => {
  // One anchor carrying both, rather than two `includes` — the console draws other
  // external refs, so a loose `rel` assertion would pass on somebody else's link.
  const link = /<a[^>]*href="https:\/\/github\.com\/AdamAwan\/LubbDubb\/issues\/new"[^>]*rel="noopener noreferrer"/;
  assert.ok(link.test(render(view({ connected: false }))), 'no new-issue link that keeps the opener while offline');
  // Connected, the same destination is reached through the compose modal instead —
  // which is the point of #449: two faces, one repository.
  assert.ok(render(view({ connected: true })).includes('cn-issue-btn'), 'no compose button while connected');
});

/**
 * Issues #413 and #449. The bar's control has two faces and the fallback is the
 * load-bearing one: the compose modal posts to this harness's own server, so on a
 * dropped socket — the state an operator is most likely to have something to file
 * about — there is nothing behind it.
 *
 * `canFileTickets` is deliberately **not** in this gate. It says whether the
 * tracker the fleet is pointed at accepts new items, and since #449 the report goes
 * somewhere else entirely: the demo fixtures carry `false`, and a connected cockpit
 * composes anyway.
 */
test('the bar composes whenever it is connected, and links out when it is not', () => {
  const filing = (canFileTickets: boolean, connected: boolean): CockpitView => {
    const v = view({ connected });
    return { ...v, state: { ...v.state, config: { ...v.state.config, canFileTickets } } };
  };
  const link = /<a[^>]*href="https:\/\/github\.com\/AdamAwan\/LubbDubb\/issues\/new"/;

  for (const canFileTickets of [true, false]) {
    const composing = render(filing(canFileTickets, true));
    assert.ok(composing.includes('cn-issue-btn'), `no compose button with canFileTickets=${canFileTickets}`);
    assert.ok(!link.test(composing), 'the external link is drawn beside the compose button');

    const offline = render(filing(canFileTickets, false));
    assert.ok(
      link.test(offline) && !offline.includes('cn-issue-btn'),
      `no way out to LubbDubb’s tracker with the socket down and canFileTickets=${canFileTickets}`,
    );
  }
});

/**
 * The resting state, which is the one `renderToStaticMarkup` can reach: effects do
 * not run, so this is the modal exactly as it paints before the probe answers. That
 * is the state worth pinning — both fields disabled and the submit dead — because
 * everything the modal is for depends on nobody being invited to type a paragraph
 * the harness may turn out to be unable to file.
 */
test('the compose modal is unusable until the probe has answered', () => {
  const html = renderToStaticMarkup(
    createElement(RaiseIssueModal, {
      probe: () => new Promise<never>(() => undefined),
      fallbackUrl: 'https://github.com/AdamAwan/LubbDubb/issues/new',
      onSubmit: () => Promise.reject(new Error('not reached')),
      onClose: () => undefined,
    }),
  );
  // Two, not three: the watch opt-in is not drawn at all until the probe says this
  // fleet is one that could act on the label (issue #449).
  assert.equal(html.match(/<(?:input|textarea)[^>]*disabled/g)?.length, 2, 'title and body');
  assert.ok(/<button[^>]*disabled[^>]*>raise issue<\/button>/.test(html), 'the submit must start dead');
  assert.ok(decode(html).includes('checking where this would go'), 'and must say why it is waiting');
});

/**
 * The two rules the control turns on, as rules rather than as a rendering of them.
 * `null` is a reading and not a missing one — "not yet" and "no" disable the same
 * fields for opposite reasons, and only one of them ever becomes typeable.
 */
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
    // Trimmed, so a page of spaces is empty — the route trims before it refuses,
    // and a live button over it would promise a 400.
    ['   ', 'a body'],
    ['a title', '\n  '],
  ] as const) {
    assert.equal(
      canFile('ready', title, body),
      false,
      `submit live on title=${JSON.stringify(title)} body=${JSON.stringify(body)}`,
    );
  }
  // No amount of text unlocks a target that cannot be filed into.
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

/**
 * One DOM for every width, so where the vivarium lands when the shell collapses to
 * one column is decided by document order alone — and last is the foot of the page.
 * Inside the rail it drew between the queue and the work, which is the position
 * this pins it out of. The wide arrangement is grid placement over the same order,
 * so a move back into `.cn-rail` would still read correctly at 1400px.
 * → docs/spec/17-cockpit.md#the-console-at-width
 */
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
      // The escalation a pull request raised: no goal page to be answered on, so
      // it opens the ask panel. Before that destination existed it drew as a
      // `div` and a click on it did nothing at all.
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

  // The row wrapper is the element whose class starts `cn-q ` and is followed by
  // its tone and, when an agent is parked on it, its weight — anchoring on the
  // whole attribute rules out `cn-qin`/`cn-qkind`, which are unrelated inner
  // elements that happen to share the `cn-q` prefix.
  const rowWrapper = (title: string): string => {
    const titlePos = html.indexOf(title);
    assert.ok(titlePos !== -1, `row "${title}" must render`);
    const before = html.slice(0, titlePos);
    // Attribute order differs between the two tags (`<button type="button"
    // class="…">` vs `<div class="…">`), so match the whole opening tag and
    // check its attributes rather than assuming `class` comes first.
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

/**
 * The rail's two readings, and the one thing that keeps them from collapsing back
 * into each other: **hue is the kind, weight is the group**. The palette used to
 * spend both on the group — red blocking, amber yours — which meant every ask
 * that ever landed on the bench arrived in an alarm colour, a delivered goal's
 * close-out included.
 *
 * Totality is the typechecker's, so what is left to assert is what a `Record`
 * cannot say: that no two kinds are told apart by the word alone, and that the
 * glyphs carry no emoji presentation — a codepoint with one renders as a
 * full-colour sticker inside a 10px monospace tag on some platforms and as
 * lettering on others, which is a difference no test on this machine would show.
 */
test('every kind of ask draws in its own tone, under its own glyph', () => {
  const kinds = Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[];

  const symbols = kinds.map((k) => KIND_SYMBOL[k]);
  assert.equal(new Set(symbols).size, symbols.length, 'two kinds sharing a glyph is a glyph that says nothing');
  for (const sym of symbols) {
    assert.equal([...sym].length, 1, `"${sym}" must be a single character`);
    const cp = sym.codePointAt(0) ?? 0;
    assert.ok(cp < 0x10000, `"${sym}" must be a BMP glyph, not an emoji codepoint`);
    // U+FE0F would force emoji presentation; U+FE0E would force text. Neither
    // belongs here — the set is chosen from codepoints that have no emoji variant
    // at all, so the platform has nothing to choose between.
    assert.ok(!/[\uFE0E\uFE0F]/.test(sym), `"${sym}" must carry no variation selector`);
  }

  const rows = kinds.map((kind, i) => ({
    id: `row-${i}`,
    kind,
    // Alternated on purpose: the group must not be what decides the tone, so a
    // sweep that held it constant would pass on a rail that had quietly gone back
    // to colouring by group.
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

/**
 * The other half: the group is still said, and it is said on the row rather than
 * only in the sub-heading above it. Two rows of one kind, one parked and one not,
 * must differ — a rail that dropped the weight when it took the hue would have
 * lost the bit it sorts by, silently, since both rows still render.
 */
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

/**
 * The demo goal to open: the first ask that names one. Asserted rather than
 * defaulted to an arbitrary issue — a fixture set with no goal-scoped ask would
 * make every assertion below vacuous instead of failing.
 */
function goalRef(): string {
  const ref = view().needsYou.find((n) => n.goalRef !== null)?.goalRef;
  assert.ok(ref, 'the demo fixtures must carry at least one ask that names a goal');
  return ref;
}

function goalView(
  mutate: (state: CockpitView['state']) => void = () => {},
  ref: string = goalRef(),
  /** The reference footer's disclosures to open — `[]` is the page as it arrives. */
  goalOpen: readonly string[] = [],
): CockpitView {
  const state = buildDemoState().state;
  mutate(state);
  return buildViewModel({
    goalOpen,
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

/**
 * A pull request's page, opened over the goal the demo's threads hang on.
 *
 * `selectedPr` alone would draw it over the tab; the goal is set beside it because
 * that is how it is actually reached, and the crumb naming the goal is half of what
 * makes the page a rung of the ladder rather than a fourth destination.
 */
function prView(prNumber: number, ref: string = 'issue:412'): CockpitView {
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
  // The goal page is *not* also drawn: one situation area, one page, and the ladder
  // decides which. Its pull-request card is the giveaway — it heads "Pull requests",
  // which the pull request's own page never does.
  assert.ok(!html.includes('>Pull requests<'), 'the goal page underneath is replaced, not stacked with');
});

test('a thread is drawn with its state, its conversation and where it hangs', () => {
  const html = decode(render(prView(412)));
  for (const state of ['open', 'answered', 'resolved']) {
    assert.ok(html.includes(`cn-th-${state}`), `the demo's ${state} thread must be drawn as one`);
  }
  // The reply, and the mark that says who wrote it: on a single-operator
  // deployment the fleet posts under the operator's own credential, so the name
  // alone cannot say the fleet has already answered — which is the fact a reader
  // needs before reopening anything.
  assert.ok(html.includes('the cut alone would drop the tail it needs'), 'a reply is part of the thread');
  assert.ok(html.includes('cn-thmark'), 'and a reply the fleet wrote says so');
  assert.ok(html.includes('src/context/rank.ts'), 'a thread names the place it hangs');
});

/**
 * The provider's own page, which the masthead's `<Ref>` used to be. A ref onto
 * this pull request now opens *this* page, so the way out to the provider needs a
 * control of its own — the shape a goal's `Open ticket ↗` already has.
 */
test('the pull request page carries the way out to the provider', () => {
  const html = decode(render(prView(412)));
  assert.ok(html.includes('Open pull request ↗'), 'the page a ref lands on must still reach the provider');
});

test('a pull request the world has lost is said so, rather than falling through to the goal', () => {
  // The address bar naming something the screen does not show is a click that
  // reads as doing nothing — the same reason a missing goal gets its own screen.
  const html = decode(render(prView(9999)));
  assert.ok(html.includes('is not in the current world'), 'the page says what happened');
  assert.ok(!html.includes('Review threads'), 'and draws no page for a pull request it does not have');
});

/**
 * The record on the goal page (the work tab's history, moved to where it is read).
 *
 * Asserted on the *page* rather than on the component, because the whole change is
 * a placement: `WorkRecord` renders identically wherever it is mounted, and the
 * defect this guards against is it quietly ceasing to be mounted here — which
 * types, lints and every component test would go on passing through.
 *
 * The pre-fetch wording is what a static render shows, since effects do not run:
 * that is also the honest first paint in the browser, so pinning it costs nothing
 * and catches a card that renders an empty box while its route is in flight.
 */
test('a goal draws its own durable record, not only the live snapshot', () => {
  // Folded away as the page arrives, and *named* all the same: the heading is what
  // says the history is here to be had, and a card that drew nothing at all would
  // be indistinguishable from a page that had lost it.
  const shut = render(goalView());
  assert.ok(shut.includes('The record'), 'the goal page must carry the history the snapshot forgets');
  assert.ok(
    !shut.includes('Reading the record'),
    'folded away it fetches nothing — "on open, never polled" is the disclosure now, not the page',
  );

  const open = render(goalView(() => {}, goalRef(), ['record']));
  assert.ok(open.includes('Reading the record'), 'the card must say it is fetching rather than draw an empty box');
});

/**
 * "More work" is how an operator says what they want done next, in words — and
 * the verdict it writes is what puts the goal back in front of pickup once no PR
 * is open. Losing the control loses both, silently and with every type still
 * checking. The floor carried the verdict; this pins that the goal page carries
 * the way to write one.
 */
test('a goal can still be sent back for more work, not only marked done', () => {
  const html = render(goalView());
  assert.ok(html.includes('More work'), 'the goal page must offer the way to say what is left');

  // Offered *again* on a goal already sent back, unlike the verdict-only control
  // it replaced: a second thing the operator wants is a second instruction, and a
  // hidden button would be a goal they can no longer say anything about.
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
  assert.ok(standing.includes('More work'), 'and it still is once one stands');
  assert.ok(standing.includes('change the button to primary'), 'what was asked for is drawn, not just counted');
  assert.ok(standing.includes('Withdraw'), 'and there is a way to take it back');
});

/**
 * The goal-profile gate (#342) reaches the rail, and it draws through the same
 * band on both surfaces.
 *
 * It holds every dispatch for its goal and expires on nothing but the answer, so
 * a gate legible only on the goal's own page is a goal stopped for good with
 * nobody told — the page is not one an operator opens for a goal that looks like
 * it merely has not come up yet.
 */
test('an unanswered profile proposal reaches the rail, not only the goal page', () => {
  const ref = goalRef();
  const gated = (state: CockpitView['state']) => {
    const issue = state.world.issues.find((i) => `issue:${i.number}` === ref);
    assert.ok(issue, 'the fixture goal must be in the world');
    issue.appraisal = {
      verdict: 'workable',
      summary: 'Three subsystems and an auth guard between them.',
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

  // One band, not two: the page draws the gate through the rail's own component,
  // so a second copy here would be a second set of buttons to keep in step with
  // the write.
  assert.equal(html.split('Use “deep”').length - 1, 1, 'the gate is drawn once on the goal page');
});

/**
 * A row and the band it opens are one ask, and hue plus glyph is most of how an
 * operator recognises that they are. The band's own weight is deliberately *not*
 * carried over — it is a single ask already in front of them, with nothing to
 * rank it against — so tone and symbol are the whole of the agreement, and both
 * have to hold.
 */
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

/**
 * The shared card is embedded rather than reimplemented compactly, and this is
 * what that buys: the options an agent offered through `escalate` stay one click
 * on the goal page, and a proposal arrives with its verdict buttons instead of a
 * reply box that cannot be branched on. A second implementation would be a second
 * set of refusal rules to keep right — the reason `EscalationCard` has one.
 */
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

  // This question alone, turned into a decision — so the absence of a reply box
  // below is this card's, and not read off a second band on the same page.
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

/**
 * The rail's rows and the page are one reading, so while a goal is open the rail
 * must say which of its asks are the ones on screen. Dimming rather than
 * filtering: the rail is the fleet's whole queue, and a blocker dropped from it
 * is a blocker nobody answers.
 */
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
    // `class="cn-q…"` bounded by the closing quote or a space — `cn-qkind` and
    // `cn-qin` share the prefix and would otherwise match as row wrappers.
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

  // With no goal on screen there is nothing to be current *against*: a rail that
  // dimmed here would mute every row it draws.
  const overview = render(view({ needsYou: rows }));
  assert.ok(!overview.includes('cn-dim'), 'the rail mutes nothing while the overview is drawn');
  assert.ok(!overview.includes('aria-current'), 'no row is current while no goal is open');
});

test('the ask is drawn above the plan, which is the whole point of the page', () => {
  const v = goalView();
  if ((v.goalPage?.needs.length ?? 0) === 0) return; // fixtures carry no ask on this goal
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
  if (!first) return; // the fixture goal has no plan; the grouping tests cover this

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

  // The sentence alone left the operator told about a plan they could not read.
  assert.ok(decode(html).includes('Every part of this plan was retired'));
  assert.ok(decode(html).includes('split the store in two'));
  assert.ok(html.includes('cn-retired'));
});

/**
 * The waves are the shape of the work and nothing else. Everything a plan also is
 * — the diagnosis, the map, each part's acceptance, the decision that was made on
 * it — is the sheet's, and the goal page reached it only through the validation
 * card's aside about amending the checks. This pins the way in on the card that
 * draws the plan, and pins that it is keyed on a plan existing rather than drawn
 * as a dead control over a goal that has none.
 */
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

/**
 * The reference footer arrives shut, and its state is the address bar's.
 *
 * Both halves are the point. Shut, because neither surface is owed anything — the
 * ticket is read once at pickup and the record is what is left after the snapshot
 * forgets — and between them they used to put a screen and a half of prose in
 * front of everything still moving. Named while shut, because a section that
 * vanished would be a page that had lost it.
 *
 * And it is a `Place`, so a link to a goal's ticket body opens on it and the back
 * button steps out of a disclosure it stepped into. Held in a `useState` all of
 * that fails silently, which is why it is pinned here rather than left to reading.
 */
test('the reference footer arrives shut, and opens from the place', () => {
  const shut = render(goalView());
  assert.ok(shut.includes('The ticket'), 'the ticket is named even while it is folded away');
  assert.ok(!shut.includes('as it stood at pickup</span><div class="cn-tick"'), 'and its body is not drawn');

  const open = render(goalView(() => {}, goalRef(), ['ticket']));
  assert.ok(open.includes('cn-tick'), 'the place is what opens it');
});

test('a held goal is a way into the goal it names', () => {
  // One way into a goal, from every surface that lists one — the queue row, the
  // overview row and this. The intake hold is raised on the rail rather than on
  // the tickets tab, so the row that names it is a queue row, and its click opens
  // the goal like every other row's.
  const v = view();
  const row = v.needsYou.find((n) => n.kind === 'intake');
  assert.ok(row, 'the demo fixtures must carry a goal the appraisal refused');
  assert.equal(row.opens, 'goal', 'a held goal has a page, so the row opens it');
  assert.ok(decode(render(v)).includes(row.title), 'and the rail draws it');
});

/**
 * Every section in the strip has a render arm.
 *
 * The other half of registering a config section. `cockpitPlace.test.ts` proves
 * `?section=x` survives the URL; this proves the page has something to draw when it
 * arrives. A section in `TABS` with no arm draws the *previous* section's body under
 * its own heading, which reads as the wrong content rather than as a bug.
 *
 * Asserted over the source rather than a render because `ConfigPage` draws nothing
 * but "Loading…" until `api.getConfig()` resolves, and stubbing the api to reach the
 * strip would be testing the stub.
 */
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

/**
 * One colour control, used by two features that are otherwise unrelated.
 *
 * Asserted structurally because the sharing is the point and un-sharing it is a
 * one-line temptation: a caller that wants "just a swatch here" writes its own
 * `<input type="color">`, and then only one of the two picks up the next fix to the
 * alpha handling or the `onInput` behaviour. The tracker-state colours had exactly
 * that control before the theme work gave them a better one.
 */
test('every colour input in the cockpit is the shared field', () => {
  const owners: string[] = [];
  for (const path of readdirSync('web/src/components').filter((f) => f.endsWith('.tsx'))) {
    const source = readFileSync(join('web/src/components', path), 'utf8');
    if (source.includes('type="color"')) owners.push(path);
  }
  assert.deepEqual(owners, ['ColourField.tsx'], 'a second colour input has appeared beside the shared one');
});

/**
 * And the tracker-state colours really do draw it — the structural check above proves
 * no *other* colour input exists, which is a different claim from this one.
 *
 * Rendered from a fixture rather than in the browser because the demo backend answers
 * `/api/config` with no groups at all, on purpose: it refuses config writes rather than
 * faking them, so there is nothing for the Values tab to draw there.
 */
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
  // The state the map does not colour is offered, the one it does is not.
  assert.ok(html.includes('value="Done"'), 'an uncoloured state is offered in the datalist');
});

/**
 * A key another key requires, drawn while the requirement is raised by an edit
 * that has not been written yet.
 *
 * The whole point of the requirement living in the browser: the pool provider is
 * `fake` in the config this page was handed, and `git` only in what is staged. A
 * `required` computed on the server would answer for the running config and let
 * the operator write a file the next boot refuses — over a key whose row would
 * not have been drawn at all, since an unset optional is not.
 */
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
    /<button class="btn primary small" disabled="">Review &amp; write<\/button>/,
    'the write is refused while the requirement is unmet',
  );
  // Named rather than counted: the row is usually in a group the operator has
  // already navigated away from.
  assert.ok(html.includes('fleetId is needed while'), 'and the save bar says which key and why');
});

/** The same page with the requirement satisfied writes normally. */
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
  // The suggestion is an offer for an empty field, so a filled one does not draw it.
  assert.ok(!html.includes('cfg-suggest'), 'and the offer is gone');
});

test('the shared colour field keeps the alpha a picker cannot express', () => {
  const seen: string[] = [];
  const html = renderToStaticMarkup(
    createElement(ColourField, { value: '#00000099', label: 'Modal scrim', onChange: (v) => seen.push(v) }),
  );
  // The picker only ever sees six digits; the field still shows all eight.
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
  // The swatches read `var(--bg)` and friends, which resolve through the same
  // declaration block as the theme — so the attribute is what makes a card honest.
  for (const preset of PRESETS) {
    assert.ok(html.includes(`data-theme-swatch="${preset.id}"`), `${preset.id} has no preview card`);
  }
  assert.ok(html.includes('--panel-2'), 'a row names the property, not only its label');
  assert.ok(html.includes('The slightly recessed face inside a card'), 'and says what moving it changes');
  assert.ok(html.includes('Dark, unmodified'), 'the bar states where the theme stands');
  // Advanced is folded away on arrival, so the ninety-odd derived tokens are not
  // the first thing an operator meets.
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

  // The total holds a local run's money, so the card has to name it: the row above
  // says "Agents", and a figure that outruns the agents behind it reads as an error.
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

test('with no goal selected the overview draws its six cards', () => {
  const html = render(view());
  for (const title of ['Fleet', 'Goals in flight', 'Pull requests', 'Up next', 'World signals', 'Environments']) {
    assert.ok(html.includes(title), `the overview is missing ${title}`);
  }
});

/**
 * The one card on this page that draws nothing when it is empty.
 *
 * The deliberate exception to the rule the rack pins below: an environment surface
 * on a deployment that configured no health check is a row of question marks
 * announcing a feature as broken. Pinned in both directions, because either half
 * alone is a card that looks right on the fixtures and wrong on a real deployment.
 */
test('the environments card draws its readings, and nothing at all without them', () => {
  const v = view();
  const html = render(v);
  assert.ok(html.includes('Pipeline failing'), 'the check’s own words, drawn verbatim');
  assert.ok(html.includes('not well'), 'and what they add up to, in the operator’s words');

  const none = render({ ...v, state: { ...v.state, environmentHealth: [] } });
  assert.ok(!none.includes('Environments'), 'nothing configured, nothing drawn');
});

test('a queued item states why it is held, in the queue’s own words', () => {
  const v = view();
  const held = v.state.upcoming?.items.filter((i) => i.reason !== '');
  if (!held?.length) return;
  // Decoded: a queue reason quotes a part slug, and React escapes the quotes in
  // the text node — the assertion is about the sentence, not its encoding. Tags
  // stripped too: a `#341` in the reason is drawn as a link, so the sentence is
  // several text nodes on the page and one string only once the markup is gone.
  const text = decode(render(v).replace(/<[^>]*>/g, ''));
  for (const item of held) assert.ok(text.includes(item.reason), `the queue dropped: ${item.reason}`);
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
  // The row this PR is drawn in, not "some row on the page": the overview draws
  // several kinds of row and one of them being spent proves nothing.
  const row = html.split('<div class="cn-row').find((chunk) => chunk.includes(ignored.title));
  assert.ok(row, 'the unwatched PR is still listed — one that vanishes is the other bug');
  // The class list, not its order: a row carries the grammar's own class as well
  // as its tone, and which comes first is not what this pins.
  assert.ok(row.slice(0, row.indexOf('"')).includes('cn-spent'), 'the unwatched PR’s row carries the spent tone');
  // The state column still names it, in the server's own word — the tone is the
  // second reading, never a replacement for the first. It is the row grammar's
  // chip now rather than a chip of the card's own, which is the point of there
  // being a state column: the word is where every other card puts its state.
  assert.ok(row.includes('>unwatched</button>'), 'the state column says which arm it is');
});

test('a goal row is a way into its page', () => {
  const html = render(view());
  assert.ok(html.includes('cn-goal-row'));
});

/**
 * The backlog's four groups became the tickets tab's watch filter (#351), and its
 * intake group became an ask on the queue rail. What the group *argued* — that an
 * `unclear` appraisal is the one intake reading that stops dispatch, so it must be
 * pulled out rather than greyed inside the watched rows — is what these assert,
 * one surface further along: it is pulled out onto the rail, where the operator
 * reads what is waiting on them, rather than onto a page they open to groom the
 * backlog.
 *
 * The tab's rows arrive from its own route, which a static render does not fetch,
 * so the arrangement those groups used to cover is tested against `featureBlocks`
 * in `test/issueGroups.test.ts` instead.
 */
test('a goal the appraisal refused is raised on the rail, quoted whole, with its override under it', () => {
  const v = view();
  const row = v.needsYou.find((n) => n.kind === 'intake');
  assert.ok(row, 'the demo fixtures must carry a goal the appraisal refused');
  const appraisal = v.state.world.issues.find((i) => `issue:${i.number}` === row.goalRef)?.appraisal;
  assert.ok(appraisal);

  // The band the row opens, drawn in front rather than behind the rail: it is the
  // ask panel's body, and the same one the goal page draws.
  const decoded = decode(render({ ...v, consolePanel: { ask: row.id } }));
  assert.ok(decoded.includes('could not say this is workable'), 'the band names what is holding the work');
  assert.ok(decoded.includes(appraisal.summary), 'the appraiser’s own words are quoted, never reworded');
  assert.ok(decoded.includes('Override → workable'), 'and the one button that unblocks it sits under them');
});

test('a goal nothing is holding raises no intake row at all', () => {
  // A call-out is an exception being raised, and an exception nobody has is not a
  // heading, it is silence — the same rule the rail keeps for every other kind.
  const v = view();
  const issues = v.state.world.issues.map((i) => ({ ...i, appraisal: null }));
  const cleared = buildNeedsYou({ ...v.state, world: { ...v.state.world, issues } });
  assert.equal(cleared.filter((r) => r.kind === 'intake').length, 0, 'no goal is held, so nothing claims one is');
});

/**
 * Unrecorded work went to the tickets tab when the work tab was retired, because
 * `File a work item` / `Ignore` is a triage decision and this is the surface
 * triage happens on.
 *
 * Asserted structurally rather than on the markup: the call-out reads `/api/work`
 * on mount and nothing fetches in a static render, so what a render proves is only
 * that it draws nothing when it has nothing — which is the *other* half of this,
 * below. What matters here is that the tab mounts it at all, since a call-out
 * nothing renders is a triage list an operator can no longer reach from anywhere.
 */
test('the tickets tab is where unrecorded work is triaged', () => {
  const src = readFileSync(fileURLToPath(new URL('../web/src/components/TicketsPanel.tsx', import.meta.url)), 'utf8');
  assert.ok(/import\s+\{[^}]*UnrecordedWork/.test(src), 'the tickets tab must mount the unrecorded-work call-out');
  assert.ok(src.includes('<UnrecordedWork'), 'and render it, not merely import it');

  // Nothing outstanding draws nothing: this is a call-out above somebody else's
  // list, and a permanent "nothing to record" heading over the tickets table is a
  // row of chrome saying so on every visit. The overview's cards are the opposite
  // rule and for the opposite reason — those are gauges glanced at in a fixed spot.
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

/**
 * The picker's whole job is that you can see the choice before you make it: which
 * branch a goal would run, and what has happened on **that** branch. A row that
 * named only the goal is the thing this replaced — the ref was resolved server-side
 * at start time, so the first you knew of it was after the environment came up on
 * it.
 */
test('the local run panel names the ref each goal would run', () => {
  const v = view({ consolePanel: 'localRun' });
  const runnable = v.state.localRunTargets.filter((t) => t.runnable);
  assert.ok(runnable.length > 0, 'the demo fixtures must carry a goal with a branch of its own');
  const html = decode(render(v));
  for (const target of runnable) assert.ok(html.includes(target.target.ref), `no row names ${target.target.ref}`);

  // A ref with no pull request of its own says so. Silence reads as a row that
  // forgot to say, and one glance at another goal's PR number answers a question
  // nobody asked.
  const orphan = runnable.find((t) => t.target.pr === null);
  if (orphan) assert.ok(html.includes('no pull request of its own'));
});

/**
 * What the environment currently up has cost. It is the one spend figure an operator
 * sees while the money is still being spent, and it is on the panel rather than only
 * in the breakdown because that is where the decision to keep it running is made.
 */
test('the local run panel states what the run holding the environment has cost', () => {
  const v = view({ consolePanel: 'localRun' });
  const run = v.state.localRun;
  assert.ok(run?.costUsd != null, 'the demo fixture must carry a measured run');
  const html = decode(render(v));
  assert.ok(html.includes(`$${run.costUsd.toFixed(2)}`), 'the run’s own cost is not on the panel');

  // Unmeasured is not free: a PTY deployment reports no usage at all, and $0.00 there
  // would be the panel inventing a reading.
  const unmeasured = decode(
    render({ ...v, state: { ...v.state, localRun: { ...run, costUsd: null, numTurns: null } } }),
  );
  assert.ok(!unmeasured.includes('$0.00'), 'null is "never measured", not zero');
});

/**
 * Two empty pickers that look identical and are not: a filter holding every row
 * back, and nothing to hold back. Only the first has a control that would help, and
 * the count behind that control has to be taken from the **same** population the
 * rows are — counting hidden targets instead let the checkbox disappear at exactly
 * the moment somebody needed it, under a message telling them to tick it.
 */
test('the local run panel offers its filter when the filter is what is hiding the rows', () => {
  const base = view({ consolePanel: 'localRun' });
  const withState = (localRunTargets: CockpitView['state']['localRunTargets']): CockpitView => ({
    ...base,
    state: { ...base.state, localRunTargets },
  });

  const held = decode(render(withState(base.state.localRunTargets.map((t) => ({ ...t, runnable: false })))));
  assert.ok(held.includes('show every goal'), 'the control that would reveal them must be on screen');
  assert.ok(held.includes('would run the integration branch'), 'and the message must say what ticking it does');

  // Nothing to reveal: no control offered, and the panel says which situation it is
  // rather than leaving somebody hunting for a filter that would not help.
  const nothing = decode(render(withState([])));
  assert.ok(nothing.includes('nowhere to run yet') || nothing.includes('anywhere to run yet'));
  assert.ok(!nothing.includes('show every goal'), 'a filter that can reveal nothing must not be drawn');
});

/**
 * The readings, and the one control they earn. Ports and freshness are the first
 * things about the run that are observed rather than presumed, and each is
 * three-valued: a null is "not checked", never a zero, and a Refresh is drawn only
 * while there is something to pick up — absent otherwise, not disabled.
 */
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

/**
 * Typing into the session is offered only when there is a session to type into and
 * it is between turns. A restart that could not bring the run back leaves a live row
 * and nobody to tell; a turn in flight is one the message would queue behind.
 */
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

test('the knowledge page draws the retired claims too', () => {
  // The load-bearing half of the prune surface: a claim that vanished on being
  // retired would leave no way to tell a list you have finished with from one that
  // lost rows, and "retired" would read as "deleted" — which is exactly the
  // collision the two words were separated to avoid.
  //
  // Asserted on the list, which is the surface the rule is about: nothing there is
  // folded by default, and the retired tail is drawn open. The queue revises that
  // for itself and is asserted below on what the revision actually rests on.
  const v = view({ tab: 'knowledge', knowledgeView: 'list' });
  const retired = v.state.knowledge.find((f) => f.reach === 'retired');
  assert.ok(retired, 'the demo fixtures must carry a retired claim to draw');
  // The first plain run of the fixture's text: markdown renders its inline code
  // into its own element, so a longer slice would be split across nodes.
  assert.ok(decode(render(v)).includes(retired.claim.slice(0, 28)), 'a pruned claim stays visible');
});

test('the knowledge queue folds the settled tail, and the fold says what it holds', () => {
  // What "nothing is folded by default" was protecting, kept by the thing that
  // replaces it: the queue draws one claim and puts the tails behind folds, and a
  // fold that states its own size cannot let *retired* read as *deleted* — the tail
  // is named, its count is on the heading, and one click has it back.
  const v = view({ tab: 'knowledge' });
  const html = decode(render(v));
  const settled = v.state.knowledge.filter(
    (f) => f.reach === 'graduated' || f.reach === 'superseded' || f.reach === 'retired' || f.reach === 'rejected',
  );
  assert.ok(settled.length > 0, 'the demo fixtures must carry a settled tail to count');
  assert.ok(html.includes('Settled'), 'the fold has to be named on the page it is folding');
  assert.ok(html.includes(`· ${settled.length}`), 'and it has to say how many rows it holds');
  // The three headings that reach an agent carry no fold on the list and are not
  // folded here either — a page that can hide what the fleet is being told is not a
  // governance surface. They are what an empty queue draws.
  assert.ok(!html.includes('▸ Live notices'), 'what reaches an agent is never behind a fold');
});

/**
 * The demo carries no goal-less ask on purpose — every fixture pull request has a
 * ticket that owns it — so the orphan is built here: the state the harness does
 * reach when it works a ticketless PR, which is the case the panel exists for.
 */
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
  // The shared card, not a second wiring: its own controls are what answer the ask.
  assert.ok(html.includes('escalation-prompt'), 'the panel embeds the shared escalation card');
});

/**
 * The panel is the one surface with nothing drawn around the ask, so it has to
 * name the subject itself — and "no goal" has to read as a fact rather than as a
 * line that failed to load.
 */
test('the ask panel says what the ask is about, and says so when there is no goal', () => {
  const { v, row } = orphanAsk();
  const orphan = decode(render({ ...v, consolePanel: { ask: row.id } }));
  assert.match(orphan, /No linked goal/, 'an ask with no goal must say so in those words');
  assert.match(orphan, /#9999/, 'and still name the pull request it was raised on');

  // The same panel opened from a goal's band: the subject is that goal, and it is
  // a way back onto its page rather than a label.
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

  // What answering it looks like in the next snapshot: the row is gone from the
  // queue, so a panel still holding its id has nothing left to offer a verdict on.
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
  assert.ok(render(view()).includes('World signals'), 'the overview is the tab the console opens on');
  assert.ok(!render(view({ tab: 'tickets' })).includes('World signals'), 'a tab replaces the one before it');
  assert.ok(!render(view({ tab: 'insights' })).includes('World signals'));

  // A queue row selects a goal without moving the nav, so the goal has to win —
  // otherwise clicking an ask lands on a triage list, or on a reading.
  const v = goalView();
  for (const tab of ['tickets', 'insights'] as const) {
    assert.ok(render({ ...v, tab }).includes('cn-goal'), `a goal must outrank the ${tab} tab`);
  }
});

/**
 * The nav is the surfaces work happens **on**, and the work graph is not one.
 *
 * It hung off the bottom of the shell, then held the second nav slot, and now it
 * is a panel — because by the end the tab drew a disclosure triangle over an index
 * of pages that are one click away anyway: a goal's record reads on its goal page,
 * and the triage list that was its only acted-on part reads on the tickets tab.
 *
 * Both halves are asserted. Every label, so a tab added to `ConsoleTab` and
 * forgotten in the nav fails here rather than being a view nothing can reach — and
 * `Work` explicitly *not* among them, since the whole change is that the slot went
 * back. And the record reachable from the bar at every tab, since a panel nothing
 * opens is the graph unreachable rather than relocated.
 */
test('the work graph is a panel reached from the bar, not a nav destination', () => {
  const nav = render(view()).split('</nav>')[0] ?? '';
  for (const label of ['Overview', 'Tickets', 'Knowledge', 'Insights']) {
    assert.ok(nav.includes(`>${label}`), `the nav is missing ${label}`);
  }
  assert.ok(!nav.includes('>Work'), 'the record is not a nav destination — it is the Record reading');
  assert.ok(render(view()).includes('>Record<'), 'and the bar carries the way to it');

  const panel = render(view({ consolePanel: 'record' }));
  assert.ok(panel.includes('The record'), 'the panel names itself');
  assert.ok(!render(view()).includes('The record'), 'and nothing draws it unopened');

  // A goal outranks every tab, so a record that was one could not be read beside
  // the goal that sent you looking for it. A panel is drawn over whatever is there.
  assert.ok(render({ ...goalView(), consolePanel: 'record' as ConsolePanel }).includes('The record'));
});

/**
 * Insights is a destination, and the three readings it replaced are gone from the
 * bar.
 *
 * Both halves matter and they are one change. Spend, Yield and Output were three
 * readings of one subject — what the fleet cost, what it landed, how much of that
 * survived — and each had grown a version of the other two on the panel behind
 * it. Leaving any of them on the bar beside the page would be the cockpit stating
 * one subject twice, which is the rule the strip is built on.
 */
test('Insights is where the three cost readings went, and they did not stay behind', () => {
  const bar = render(view()).split('</div>')[0] ?? '';
  const full = render(view());
  for (const gone of ['>Spend<', '>Yield<', '>Output<']) {
    assert.ok(!full.includes(gone), `${gone} must not be on the bar beside the page that replaced it`);
  }
  assert.ok(!bar.includes('Yield'), 'the bar states a subject once');

  // The page itself draws under the nav rather than over the console: the rail is
  // where the ask that sends an operator here comes from, and a sheet that covers
  // it hides the row being answered.
  const page = render(view({ tab: 'insights' }));
  assert.ok(page.includes('insights-bar'), 'the Insights tab draws its window control');
  assert.ok(!page.includes('read-backdrop'), 'Insights is a destination, not a modal over the console');
  assert.ok(page.includes('cn-rail'), 'the queue rail stays in frame while a reading is open');
  assert.ok(!render(view()).includes('insights-bar'), 'and no other tab draws it');
});

test('the shell renders the console, and the drawer that the console only asks for', () => {
  const src = readFileSync(fileURLToPath(new URL('../web/src/App.tsx', import.meta.url)), 'utf8');
  assert.ok(src.includes('ConsoleRoot'), 'the shell must render the console');
  // The drawer is overlaid rather than placed, and which agent is open is cockpit
  // state — the subscription is tied to it. The console asks with
  // `actions.select(id)` and the shell answers; without this the three call sites
  // that open an agent do nothing at all.
  assert.ok(src.includes('AgentDrawer'), 'the shell must answer the console’s request for a drawer');
  // The graph moved into the console — its nav first, and since the tab was
  // retired, the record panel. Left here as well it would draw twice, once below
  // everything, which is the surface this replaced. Asserted on the import and the
  // element, not on the name: the shell's own comments cite the panel as the
  // precedent for what else hangs off the shell, and a substring test made writing
  // down the reason a build failure.
  assert.ok(!/import\s+\{[^}]*RecordPanel/.test(src), 'the shell must not import the work graph');
  assert.ok(!src.includes('<RecordPanel'), 'the work graph is a console panel, not a strip under the shell');
});

/**
 * The way to the tracker is always drawn, and it never leads to the wrong thing.
 *
 * Two faults, and both were silent. The control was drawn only when a URL
 * resolved, so on a goal whose ticket could not be addressed it simply was not
 * there — indistinguishable from the cockpit having forgotten it, and absent
 * exactly where finding the ticket by hand is hardest. And it resolved through
 * `#<n>` alone, a key `buildRefUrls` writes for pull requests *first*: on a tracker
 * carrying both issue 412 and PR 412, "Open ticket" opened the pull request.
 */
test('the way to the tracker is always drawn, and prefers the unambiguous key', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const n = page.issue.number;
  const noUrl = { ...page, issue: { ...page.issue, url: undefined } };

  // `#<n>` is shared with pull requests and the pull requests are keyed first, so
  // the colon form is the only one that certainly names this goal.
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
  // Read off the control itself rather than off the page: `#<n>` is a ref other
  // surfaces here legitimately draw, so a whole-page search would pass on their
  // links and never see this one.
  const opener = /<a[^>]*href="([^"]*)"[^>]*>Open ticket/.exec(both);
  assert.ok(opener, 'the control is drawn as a link when there is somewhere to go');
  assert.equal(opener[1], 'https://tracker/browse/right', 'the goal’s own ref wins over the number a PR shares');

  // Nothing resolves at all: still drawn, still named, and no longer a link.
  const nowhere = render({ ...v, state: { ...v.state, refUrls: {} }, goalPage: noUrl });
  assert.ok(nowhere.includes('Open ticket'), 'the row’s shape must not depend on what a provider resolved');
  assert.ok(nowhere.includes('aria-disabled="true"'), 'and it says it is unavailable rather than pretending');
  assert.ok(
    !/<a[^>]*>Open ticket/.test(nowhere),
    'a link that leads nowhere is the dead end refs exist to prevent, so it stops being one',
  );
});

/**
 * The Environments chip on the top bar — the fold, which is where its whole
 * judgement lives: which reading is worst, what to call it, and how many share
 * that word.
 */
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
  // A bare number would leave an operator opening the card to find out which of
  // three quite different things it meant.
  assert.equal(red.value, '1 red');
  assert.equal(red.tone, 'ill');
  assert.equal(red.quiet, false);
  assert.match(red.title, /testUk is not well/);

  // The count is of the worst word only: `2 red` and `1 orange` must never add up
  // into one figure that describes neither.
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
  // An unstated severity is not a reason to draw an outage quietly — the card's
  // rule for the tone, read here as an ordering.
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

test('the chip is absent, not zeroed, where no environment declares a check', () => {
  // The card's own exception: a reading on a deployment that configured none
  // announces a feature as broken.
  const v = view();
  const drawn = render({ ...v, state: { ...v.state, environmentHealth: [] } });
  assert.ok(!/>Env</.test(drawn), 'no environment health, no gauge');

  const withOne = render({
    ...v,
    state: { ...v.state, environmentHealth: [envRead({ environment: 'testUk', state: 'unhealthy', tier: 'red' })] },
  });
  assert.ok(/>Env</.test(withOne), 'and it is drawn as soon as one environment answers');
  assert.ok(withOne.includes('cn-env-ill'), 'wearing the tint its worst reading earns');
});
