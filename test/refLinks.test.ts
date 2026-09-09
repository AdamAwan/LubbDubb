import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { Ref, RefLinks, TicketLink, refLabel } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function view(over: Partial<CockpitView> = {}, selectedGoal: string | null = null): CockpitView {
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
      selectedGoal,
      consolePanel: null,
      tab: 'overview',
    }),
    ...over,
  };
}

const render = (v: CockpitView) =>
  renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (prNumber: number) => hasPrPage(v.state, prNumber),
      children: createElement(ConsoleRoot, { view: v, actions }),
    }),
  );

function ref(to: string, world: { refUrls?: Record<string, string>; goals?: string[]; prs?: number[] } = {}): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: world.refUrls ?? {},
      openGoal: () => undefined,
      hasGoal: (r: string) => (world.goals ?? []).includes(r),
      openPr: () => undefined,
      hasPr: (n: number) => (world.prs ?? []).includes(n),
      children: createElement(Ref, { to }),
    }),
  );
}

test('a goal and a pull request each carry both their doors', () => {
  const goal = ref('issue:212', { goals: ['issue:212'], refUrls: { 'issue:212': 'https://tracker/212' } });
  assert.match(goal, /<span class="ref-pair">/, 'the two doors are one token, not two tokens sharing a number');
  assert.match(goal, /<button[^>]*class="ref-goal"[^>]*>#212</, 'the number opens the goal’s page in the cockpit');
  assert.match(
    goal,
    /<a class="ref-arm"[^>]*href="https:\/\/tracker\/212"/,
    'and the arm opens the story on the tracker, which the page can only summarise',
  );

  const pr = ref('pr:412', { prs: [412], refUrls: { 'pr:412': 'https://tracker/pull/412' } });
  assert.match(pr, /<span class="ref-pair">/);
  assert.match(pr, /<button[^>]*class="ref-goal"[^>]*>PR 412</, 'and it says which family it is');
  assert.match(pr, /<a class="ref-arm"[^>]*href="https:\/\/tracker\/pull\/412"/);
});

test('a reference the provider gave no address keeps its page and draws no arm', () => {
  const goal = ref('issue:212', { goals: ['issue:212'] });
  assert.match(goal, /<button[^>]*class="ref-goal"[^>]*>#212</);
  assert.doesNotMatch(goal, /ref-pair|ref-arm|<a /, 'there is no second destination to offer');
});

test('a goal’s arm prefers the unambiguous key over the shared one', () => {
  const html = ref('issue:412', {
    goals: ['issue:412'],
    refUrls: { '#412': 'https://tracker/pull/412', 'issue:412': 'https://tracker/412' },
  });
  assert.match(html, /href="https:\/\/tracker\/412"/);
  assert.doesNotMatch(html, /tracker\/pull/, 'the shared key is the pull request’s address, not the ticket’s');
});

test('a pull request the world does not carry links to the provider instead of to a blank page', () => {
  const html = ref('pr:412', { refUrls: { '#412': 'https://tracker/pull/412' } });
  assert.doesNotMatch(html, /ref-goal/, 'there is no page to open');
  assert.match(html, /<a[^>]*href="https:\/\/tracker\/pull\/412"/);
});

test('a part’s ref is the goal it is under — the part itself has no page', () => {
  const html = ref('issue:212:part:writes', { goals: ['issue:212'] });
  assert.match(html, /class="ref-goal"/);
  assert.match(html, />#212</, 'the slug is machinery; the row already names the part');
});

test('a goal the world does not carry links to the tracker instead of to a blank page', () => {
  const html = ref('issue:999', { refUrls: { '#999': 'https://tracker/999' } });
  assert.doesNotMatch(html, /ref-goal/, 'there is no page to open');
  assert.match(html, /<a[^>]*href="https:\/\/tracker\/999"/);
});

test('a ref the provider could not resolve is plain text, never a link to nowhere', () => {
  assert.equal(ref('pr:412'), 'PR 412', 'the fake provider resolves nothing, and the world carries no such PR');
  assert.equal(ref('issue:999'), '#999');
  assert.equal(ref('feature/context-budget'), 'feature/context-budget', 'a branch is already its own name');
});

test('one function shortens a ref, and it answers for every family the cockpit draws', () => {
  assert.equal(refLabel('issue:212'), '#212');
  assert.equal(refLabel('issue:212:part:writes'), '#212');
  assert.equal(refLabel('pr:412'), 'PR 412', 'the marks say where a ref goes; only the name says what it is');
  assert.equal(refLabel('job:abc'), 'job:abc');
  assert.equal(refLabel('issue/12'), 'issue/12');
});

test('a fleet row is a way to the goal it is working and to the pull request it is on', () => {
  const v = view();
  const html = render(v);
  const ci = v.state.tasks.find((t) => t.originRef?.startsWith('pr:'));
  assert.ok(ci?.originRef, 'the demo fixtures must carry an agent dispatched at a pull request');
  const prNumber = ci.originRef.slice('pr:'.length);

  const fleet = html.slice(html.indexOf('>Fleet'), html.indexOf('Goals in flight'));
  assert.ok(fleet.includes(`>PR ${prNumber}<`), 'the row names the pull request it is on, and names it as a way there');
  assert.match(fleet, /<span class="cn-refs">/, 'the refs sit beside the row’s control, never inside it');

  const goal = ci.originRef && v.state.world.issues.find((i) => i.linkedPrNumber === Number(prNumber));
  assert.ok(goal, 'the demo fixtures must carry a goal that pull request delivers');
  assert.ok(fleet.includes(`>#${goal.number}<`), 'and the goal it is delivering');
});

test('no reference is drawn inside a button', () => {
  const html = render(view());
  for (const [, inner] of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    assert.doesNotMatch(inner ?? '', /<a\b|ref-goal/, 'a link inside a control is a second destination for one click');
  }
});

test('the pull request rack is a way to the goal each PR delivers', () => {
  const v = view();
  const html = render(v);
  const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Environments'));

  const pr = v.state.world.pullRequests[0];
  assert.ok(pr, 'the demo fixtures must carry an open pull request');
  const goal = v.state.world.issues.find((i) => i.linkedPrNumber === pr.number);
  assert.ok(goal, 'the demo fixtures must carry a goal one of those pull requests delivers');
  assert.ok(rack.includes(`>#${goal.number}<`), 'the rack names the goal, and names it as a way onto its page');
});

test('the pull request rack is a way onto each pull request’s own page', () => {
  const v = view();
  const html = render(v);
  const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Environments'));

  const pr = v.state.world.pullRequests[0];
  assert.ok(pr, 'the demo fixtures must carry an open pull request');
  const named = rack.indexOf(`>${pr.title}<`);
  assert.notEqual(named, -1, 'the rack must name the pull request');
  assert.match(
    rack.slice(rack.lastIndexOf('<button', named), named),
    /class="cn-grow"/,
    'the row’s name is the control that opens the pull request’s page',
  );
  assert.match(rack, new RegExp(`<button[^>]*class="ref-goal"[^>]*>PR ${pr.number}<`), 'and so does its ref');
  assert.match(
    rack,
    /<span class="ref-pair"><button[^>]*class="ref-goal"[^>]*>PR \d+<\/button><a class="ref-arm"/,
    'the provider is the same token\u2019s second door, not a second token carrying the same number',
  );
  assert.doesNotMatch(
    rack,
    new RegExp(`>PR ${pr.number}<[\\s\\S]{0,400}?>PR ${pr.number}<`),
    'one pull request is named once on its row \u2014 the repeat is what made the rack unreadable',
  );
});

test('a queued dispatch is a way to what it is queued against', () => {
  const v = view();
  const items = v.state.upcoming?.items ?? [];
  const queued = items.find((i) => i.origin.startsWith('issue:'));
  if (!queued) return;
  const html = render(v);
  const upNext = html.slice(html.indexOf('Up next'), html.indexOf('Goals in flight'));
  assert.ok(upNext.includes(`>${refLabel(queued.origin)}<`), 'the origin is a ref, so it is drawn as one');
});

test('a part row links the pull request that carries it', () => {
  const v = view();
  const withParts = v.state.planParts?.find((p) => p.prNumber !== null);
  assert.ok(withParts, 'the demo fixtures must carry a part with a pull request open on it');
  const plan = v.state.plans?.find((p) => p.id === withParts.planId);
  assert.ok(plan, 'that part must belong to a plan');

  const html = render(view({}, plan.originRef));
  assert.ok(
    html.includes(`>PR #${withParts.prNumber}<`),
    'the plan wave named the PR in text and offered no way to it',
  );
});

test('a reference is drawn as a token at rest, and shows a ring when it takes focus', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/styles.css', import.meta.url)), 'utf8');
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    assert.notEqual(at, -1, `${selector} must still be a rule in styles.css`);
    return css.slice(at, css.indexOf('}', at));
  };

  assert.match(
    css,
    /\.ref-goal\.ref-goal,\s*\.ref-out\.ref-out \{[^}]*border: 1px solid var\(--link-line\)/,
    'a standalone reference rests inside a box',
  );
  assert.match(
    rule('.ref-goal.ref-goal'),
    /background: var\(--link-fill\)/,
    'the cockpit’s own destination is the filled one',
  );
  assert.match(
    css,
    /\n\.ref-out\.ref-out \{[^}]*border-style: dashed/,
    'a reference that leaves is unfilled and dashed',
  );

  assert.match(rule('.ext-ref.ext-ref::before'), /content: '↗'/, 'a reference that leaves says so in prose too');

  for (const single of [
    /\n\.ext-ref \{/,
    /\n\.ref-goal \{/,
    /\n\.ref-out \{/,
    /\n\.ref-goal,/,
    /\n\.ref-pair \{/,
    /\n\.ref-arm \{/,
  ]) {
    assert.doesNotMatch(css, single, 'a single-class reference selector loses to the console’s own reset');
  }

  for (const token of ['--link-line:', '--link-fill:', '--link-ink:']) {
    assert.equal(css.split(token).length - 1, 2, `${token} is one token, restated once for #print-sheet`);
  }
  assert.match(
    css,
    /\.ext-ref\.ext-ref:focus-visible,\s*\.ref-arm\.ref-arm:focus-visible,\s*\.ref-goal\.ref-goal:focus-visible \{[^}]*outline: 1px solid var\(--blue\)/,
    '`.ref-goal` is a reset <button> — without this, tab moves the ring nowhere visible, and the arm is the next stop along',
  );

  assert.match(rule('.ref-pair.ref-pair > .ref-goal.ref-goal'), /border-right: 0/, 'the pair is one shape at rest');
  assert.match(rule('.ref-arm.ref-arm'), /border-left-style: dashed/, 'and the joint says the arm leaves');
});

test('a pair drawn in a group narrower than it wants gives way from its number, never from its arm', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/styles.css', import.meta.url)), 'utf8');
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    assert.notEqual(at, -1, `${selector} must still be a rule in styles.css`);
    return css.slice(at, css.indexOf('}', at));
  };

  assert.match(rule('.ref-arm.ref-arm'), /flex: none/, 'the door to the provider is not what a clip takes');
  const token = rule('.ref-pair.ref-pair > .ref-goal.ref-goal');
  assert.match(rule('.ref-pair.ref-pair'), /min-width: 0/, 'and the pair can shrink at all');
  assert.match(token, /min-width: 0/);
  assert.match(token, /text-overflow: ellipsis/, 'so what a narrow column costs is a digit');

  const console_ = readFileSync(fileURLToPath(new URL('../web/src/console/console.css', import.meta.url)), 'utf8');
  const slot = console_.indexOf('\n.cn-frow .cn-refs {');
  assert.notEqual(slot, -1);
  assert.match(
    console_.slice(slot, console_.indexOf('}', slot)),
    /min-width: min-content/,
    'the rail is a ceiling a narrow card takes back, so the group needs a floor its arms fit in',
  );

  const width = /--cn-w-refs: (\d+)px/.exec(console_);
  assert.notEqual(width, null, 'the refs rail must still declare a width');
  assert.ok(
    Number(width?.[1]) >= 176,
    'the rail is sized for two four-digit pairs — the rack and the fleet card both draw two arms',
  );
});

test('the references slot is a column, drawn on rows that have nothing to put in it', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/console/console.css', import.meta.url)), 'utf8');
  const at = css.indexOf('\n.cn-refs {');
  const body = css.slice(at, css.indexOf('}', at));
  assert.match(body, /border-left: 1px solid var\(--cn-line\)/, 'the slot is ruled off the row’s own words');
  assert.match(body, /min-width:/, 'a slot with no width is not a column');
  assert.match(css, /\.cn-refs:empty \{[^}]*border-left-color: transparent/, 'an empty slot is space, not a tick');

  const html = render(view());
  const card = html.slice(html.indexOf('>Fleet'), html.indexOf('Goals in flight'));
  const fleet = card.slice(card.search(/<div class="cn-row[ "]/));
  const rows = fleet.match(/<div class="cn-row[ "]/g) ?? [];
  assert.ok(rows.length > 0, 'the demo fixtures must carry fleet rows');
  assert.equal(
    (fleet.match(/class="cn-refs"/g) ?? []).length,
    rows.length,
    'every row in a work list draws the slot, whether or not it has references for it',
  );
});

test('a surface off its own route merges that route’s refUrls over the shell’s', () => {
  const root = fileURLToPath(new URL('../web/src/components/', import.meta.url));
  for (const [file, map] of [
    ['FeatureBoard.tsx', 'board.refUrls'],
    ['TicketsBoard.tsx', 'refUrls'],
    ['AllowanceTab.tsx', 'refUrls'],
    ['RecordPanel.tsx', 'subtree.refUrls'],
  ] as const) {
    const src = readFileSync(join(root, file), 'utf8');
    assert.ok(
      new RegExp(`<RefLinksExtended refUrls=\\{${map.replace('.', '\\.')}\\}`).test(src),
      `${file} draws refs against the shell's map alone — every ref its own route resolved renders as plain text`,
    );
  }
});

test('nothing outside refs.tsx strips a ref down to a number', () => {
  const root = fileURLToPath(new URL('../web/src/', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  const offenders = walk(root)
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !file.endsWith('refs.tsx') && !file.includes(`${join('demo', '')}`))
    .filter((file) => /replace\(\s*\/\^?(issue|pr):/.test(readFileSync(file, 'utf8')));

  assert.deepEqual(offenders, [], 'shorten a ref through refLabel, and draw it through <Ref>');
});

function ticket(number: number, world: Record<string, string>, url?: string): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: world,
      openGoal: () => undefined,
      hasGoal: () => false,
      openPr: () => undefined,
      hasPr: () => false,
      children: createElement(TicketLink, { number, url, className: 'cn-tgl', children: 'Open ticket ↗' }),
    }),
  );
}

test('a ticket is reached by the most trustworthy key that resolves it', () => {
  assert.match(
    ticket(412, { 'issue:412': 'https://tracker/derived', '#412': 'https://tracker/pull/412' }, 'https://tracker/412'),
    /href="https:\/\/tracker\/412"/,
  );

  assert.match(
    ticket(412, { 'issue:412': 'https://tracker/412', '#412': 'https://tracker/pull/412' }),
    /href="https:\/\/tracker\/412"/,
    'issue:<n> is unambiguous, and nothing else ever writes it',
  );

  assert.match(ticket(412, { 'issue:412': 'https://tracker/412' }), /href="https:\/\/tracker\/412"/);
  assert.match(
    ticket(412, { '#412': 'https://tracker/412' }),
    /href="https:\/\/tracker\/412"/,
    'and #<n> still answers',
  );
});

test('a ticket with no address is drawn inert, never as a link to nowhere', () => {
  const html = ticket(412, {});
  assert.match(html, /^<span /, 'a link that leads nowhere is the dead end refs exist to prevent');
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /Open ticket/);
  assert.match(html, /title="No address for this ticket/);
});
