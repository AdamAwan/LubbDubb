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

// The classic runtime, as `console.test.ts` sets it up and for its reason.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { Ref, RefLinks, refLabel } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function view(over: Partial<CockpitView> = {}, selectedGoal: string | null = null): CockpitView {
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
      spendOpen: false,
      reliabilityOpen: false,
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
      children: createElement(ConsoleRoot, { view: v, actions }),
    }),
  );

/** One `<Ref>` on its own, against a stated world rather than the fixtures'. */
function ref(to: string, world: { refUrls?: Record<string, string>; goals?: string[] } = {}): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: world.refUrls ?? {},
      openGoal: () => undefined,
      hasGoal: (r: string) => (world.goals ?? []).includes(r),
      children: createElement(Ref, { to }),
    }),
  );
}

test('a goal is a way onto its page, and a pull request is a way out to the provider', () => {
  const goal = ref('issue:212', { goals: ['issue:212'], refUrls: { '#212': 'https://tracker/212' } });
  assert.match(goal, /<button[^>]*class="ref-goal"/, 'a goal the world carries opens in the cockpit');
  assert.match(goal, />#212</);
  assert.doesNotMatch(goal, /<a /, 'the page is the destination, not the ticket — the page carries "Open ticket ↗"');

  const pr = ref('pr:412', { refUrls: { '#412': 'https://tracker/pull/412' } });
  assert.match(pr, /<a[^>]*href="https:\/\/tracker\/pull\/412"/, 'there is no PR page in the cockpit');
  assert.match(pr, />#412</);
});

test('a part’s ref is the goal it is under — the part itself has no page', () => {
  const html = ref('issue:212:part:writes', { goals: ['issue:212'] });
  assert.match(html, /class="ref-goal"/);
  assert.match(html, />#212</, 'the slug is machinery; the row already names the part');
});

/**
 * The one case that must not be a cockpit link. `buildGoalPage` returns null for a
 * ref the snapshot does not carry, and the console then draws the tab behind it —
 * so a link onto one is a click that appears to do nothing at all.
 */
test('a goal the world does not carry links to the tracker instead of to a blank page', () => {
  const html = ref('issue:999', { refUrls: { '#999': 'https://tracker/999' } });
  assert.doesNotMatch(html, /ref-goal/, 'there is no page to open');
  assert.match(html, /<a[^>]*href="https:\/\/tracker\/999"/);
});

test('a ref the provider could not resolve is plain text, never a link to nowhere', () => {
  assert.equal(ref('pr:412'), '#412', 'the fake provider resolves nothing');
  assert.equal(ref('issue:999'), '#999');
  assert.equal(ref('feature/context-budget'), 'feature/context-budget', 'a branch is already its own name');
});

test('one function shortens a ref, and it answers for every family the cockpit draws', () => {
  assert.equal(refLabel('issue:212'), '#212');
  assert.equal(refLabel('issue:212:part:writes'), '#212');
  assert.equal(refLabel('pr:412'), '#412');
  // Not a family we recognise: returned whole rather than shortened into a number
  // that would name a different thing.
  assert.equal(refLabel('job:abc'), 'job:abc');
  assert.equal(refLabel('issue/12'), 'issue/12');
});

/**
 * The complaint this all comes from: the fleet card said what each agent was on
 * and offered a way to none of it. A row names two things — the pull request it
 * was dispatched at and the goal that pull request delivers — and both are ways
 * there now.
 */
test('a fleet row is a way to the goal it is working and to the pull request it is on', () => {
  const v = view();
  const html = render(v);
  const ci = v.state.tasks.find((t) => t.originRef?.startsWith('pr:'));
  assert.ok(ci?.originRef, 'the demo fixtures must carry an agent dispatched at a pull request');
  const prNumber = ci.originRef.slice('pr:'.length);

  const fleet = html.slice(html.indexOf('>Fleet'), html.indexOf('Goals in flight'));
  assert.ok(
    fleet.includes(`>PR #${prNumber}<`),
    'the row names the pull request it is on, and names it as a way there',
  );
  assert.match(fleet, /<span class="cn-refs">/, 'the refs sit beside the row’s control, never inside it');

  // The goal behind that pull request, resolved the server's own way. Without it
  // the row named a PR and left "which goal is this?" to be answered elsewhere.
  const goal = ci.originRef && v.state.world.issues.find((i) => i.linkedPrNumber === Number(prNumber));
  assert.ok(goal, 'the demo fixtures must carry a goal that pull request delivers');
  assert.ok(fleet.includes(`>#${goal.number}<`), 'and the goal it is delivering');
});

/**
 * A control cannot contain a link — one click cannot have two destinations — so a
 * row that carries refs draws its name as the button and the refs beside it. This
 * is the rule the whole `cn-refs` shape exists for, and the one a new surface is
 * most likely to break, since nesting them reads fine and renders fine.
 */
test('no reference is drawn inside a button', () => {
  const html = render(view());
  for (const [, inner] of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    assert.doesNotMatch(inner ?? '', /<a\b|ref-goal/, 'a link inside a control is a second destination for one click');
  }
});

test('the pull request rack is a way to the goal each PR delivers', () => {
  const v = view();
  const html = render(v);
  const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Up next'));

  const pr = v.state.world.pullRequests[0];
  assert.ok(pr, 'the demo fixtures must carry an open pull request');
  const goal = v.state.world.issues.find((i) => i.linkedPrNumber === pr.number);
  assert.ok(goal, 'the demo fixtures must carry a goal one of those pull requests delivers');
  assert.ok(rack.includes(`>#${goal.number}<`), 'the rack names the goal, and names it as a way onto its page');
});

test('a queued dispatch is a way to what it is queued against', () => {
  const v = view();
  const items = v.state.upcoming?.items ?? [];
  const queued = items.find((i) => i.origin.startsWith('issue:'));
  if (!queued) return; // nothing goal-scoped in the queue this snapshot
  const html = render(v);
  const upNext = html.slice(html.indexOf('Up next'), html.indexOf('World signals'));
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

/**
 * `refLabel` is the only place a ref becomes a bare number, and this is what keeps
 * it that way. Three surfaces had written the strip themselves, and the fourth
 * that wrote it — the fleet card — printed the label without a link on it, which
 * is exactly the bug: shortening a ref by hand is how a surface ends up *naming*
 * something instead of pointing at it.
 */
/**
 * The affordance, which no render test can see. It was a 1px underline — dotted
 * for a ref that leaves, solid for one that stays — which on a row that already
 * carries lamps, chips and hairline rules read as ruling rather than as a way
 * somewhere. The vocabulary is three marks now: a box for a thing you can go to, a
 * fill for a destination inside the cockpit, an arrow for one that leaves. Read the
 * stylesheet, because that is where all three live.
 */
test('a reference is drawn as a token at rest, and shows a ring when it takes focus', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/styles.css', import.meta.url)), 'utf8');
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    assert.notEqual(at, -1, `${selector} must still be a rule in styles.css`);
    return css.slice(at, css.indexOf('}', at));
  };

  // The box, and the fill that separates the two destinations. Shape rather than
  // hue, so the distinction survives the print sheet and an operator who cannot
  // separate the colours.
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

  // The arrow, which is the whole treatment for a reference inside a sentence: a
  // boxed token per mention turns prose lumpy, and prose refs all leave anyway.
  assert.match(rule('.ext-ref.ext-ref::before'), /content: '↗'/, 'a reference that leaves says so in prose too');

  // Every selector doubles its class, and this is why: `console.css` resets its own
  // markup with `.cn button` / `.cn a`, which outranks a single class and is where
  // most references are drawn. Under one class the reset stripped the box off a
  // goal token and the colour off every reference in the console — a treatment
  // correct in the stylesheet, green in this test, and on screen nowhere.
  for (const single of [/\n\.ext-ref \{/, /\n\.ref-goal \{/, /\n\.ref-out \{/, /\n\.ref-goal,/]) {
    assert.doesNotMatch(css, single, 'a single-class reference selector loses to the console’s own reset');
  }

  for (const token of ['--link-line:', '--link-fill:', '--link-ink:']) {
    assert.equal(css.split(token).length - 1, 2, `${token} is one token, restated once for #print-sheet`);
  }
  assert.match(
    css,
    /\.ext-ref\.ext-ref:focus-visible,\s*\.ref-goal\.ref-goal:focus-visible \{[^}]*outline: 1px solid var\(--blue\)/,
    '`.ref-goal` is a reset <button> — without this, tab moves the ring nowhere visible',
  );
});

/**
 * The second half of the treatment, and the half a token style cannot do: a
 * reference is findable by *position*, not only by looking like one. `cn-refs` is a
 * ruled slot, and it is drawn on every row of a list — empty where a row names
 * nothing — because a rule that comes and goes reads as ragged rather than as a
 * column.
 */
test('the references slot is a column, drawn on rows that have nothing to put in it', () => {
  const css = readFileSync(fileURLToPath(new URL('../web/src/console/console.css', import.meta.url)), 'utf8');
  const at = css.indexOf('\n.cn-refs {');
  const body = css.slice(at, css.indexOf('}', at));
  assert.match(body, /border-left: 1px solid var\(--cn-line\)/, 'the slot is ruled off the row’s own words');
  assert.match(body, /min-width:/, 'a slot with no width is not a column');
  assert.match(css, /\.cn-refs:empty \{[^}]*border-left-color: transparent/, 'an empty slot is space, not a tick');

  // The fleet row is the one that had a conditional group. A dispatch with no
  // origin must still draw the slot.
  const html = render(view());
  const fleet = html.slice(html.indexOf('>Fleet'), html.indexOf('Goals in flight'));
  const rows = fleet.match(/<div class="cn-row[ "]/g) ?? [];
  assert.ok(rows.length > 0, 'the demo fixtures must carry fleet rows');
  assert.equal(
    (fleet.match(/class="cn-refs"/g) ?? []).length,
    rows.length,
    'every row in a work list draws the slot, whether or not it has references for it',
  );
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
    // The definition itself, and the demo backend, which is a fake *harness*
    // writing the refs a provider would — not a surface drawing one.
    .filter((file) => !file.endsWith('refs.tsx') && !file.includes(`${join('demo', '')}`))
    .filter((file) => /replace\(\s*\/\^?(issue|pr):/.test(readFileSync(file, 'utf8')));

  assert.deepEqual(offenders, [], 'shorten a ref through refLabel, and draw it through <Ref>');
});
