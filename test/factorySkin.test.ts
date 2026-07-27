import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { QueueItem } from '../web/src/types.js';

// Same reason as `cockpitSkins.test.ts`: Vite compiles the cockpit's JSX with the
// automatic runtime and `tsx` with the classic one, so the global goes in before
// the skin modules are pulled in.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { resolveSkin } = await import('../web/src/skins/registry.js');
const { beltTag, botState, clip, iconForOrigin } = await import('../web/src/skins/factory/vocabulary.js');

const INERT = new Proxy({} as CockpitActions, { get: () => () => Promise.resolve() });

function render(mutate?: (s: ReturnType<typeof buildDemoState>['state']) => void): string {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { state } = buildDemoState();
    mutate?.(state);
    const view = buildViewModel({
      state,
      now,
      connected: true,
      demo: true,
      selected: null,
      liveOutput: new Map(),
      tails: new Map(),
      lastPulseAt: now,
    });
    return renderToStaticMarkup(createElement(resolveSkin('factory').Root, { view, actions: INERT }));
  } finally {
    Date.now = realNow;
  }
}

/**
 * The vocabulary is stated once so the belt and the bay can't disagree about
 * what a part looks like. These are the cases where a naive prefix check gets it
 * wrong: a plan and a part are both `issue:`-prefixed, and a job is not.
 */
test('every origin shape maps to one machine', () => {
  assert.equal(iconForOrigin('pr:42:ci'), 'gear');
  assert.equal(iconForOrigin('issue:12:plan'), 'blueprint');
  assert.equal(iconForOrigin('issue:12:part:api'), 'assembler');
  assert.equal(iconForOrigin('issue:12'), 'flask');
  assert.equal(iconForOrigin('story:st-9:work'), 'flask');
  assert.equal(iconForOrigin('job:7'), 'chest');
  assert.equal(iconForOrigin(null), 'chest');
});

/** Every `QueueItem.status` has a crate label; a new one must not render blank. */
test('every queue status has a belt tag', () => {
  const statuses: QueueItem['status'][] = ['dispatching', 'waiting', 'cooldown', 'capped', 'unapproved'];
  for (const status of statuses) {
    const tag = beltTag({ status } as QueueItem);
    assert.ok(tag.length > 0, `${status} rendered no tag`);
  }
});

/** Red means one thing on this floor: parked on a question only you can answer. */
test('only a waiting agent reads as jammed', () => {
  assert.equal(botState({ status: 'waiting' } as never), 'idle');
  assert.equal(botState({ status: 'running' } as never), 'working');
  assert.equal(botState({ status: 'starting' } as never), 'working');
  assert.equal(botState({ status: 'done' } as never), 'spent');
  assert.equal(botState({ status: 'failed' } as never), 'spent');
});

test('clip leaves short text alone and marks what it cut', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('a much longer string', 10), 'a much lo…');
});

/**
 * The belt is the harness running. A paused or held cockpit must stop it — a belt
 * still moving while no cycle will run is the one genuinely misleading thing this
 * layout could draw, so it is asserted rather than left to the CSS being right.
 */
test('the belt stops when the harness will not pulse', () => {
  assert.ok(!/fx-belt stopped/.test(render()), 'a running harness should not stop the belt');
  assert.ok(/fx-belt stopped/.test(render((s) => (s.control.paused = true))), 'paused must stop the belt');
  assert.ok(
    /fx-belt stopped/.test(
      render((s) => {
        s.recovery = [
          {
            agentId: 'a',
            taskId: 't',
            title: 'x',
            kind: 'code',
            originRef: null,
            branch: null,
            cwd: '/tmp',
            died: 'crashed',
            waitingReason: null,
            note: null,
            startedAt: new Date().toISOString(),
            detectedAt: null,
            restorable: false,
            restoreBlocked: 'no session id',
          },
        ];
      }),
    ),
    'a recovery hold must stop the belt',
  );
});

/**
 * The gate *is* the headroom cut: it sits after the dispatching prefix, so an
 * item drawn to its left is one the harness said it is starting this cycle. If
 * the two ever came apart the picture would be confidently wrong, which is worse
 * than no picture.
 */
test('the gate sits after the dispatching prefix', () => {
  const item = (origin: string, status: QueueItem['status']): QueueItem => ({
    origin,
    rule: 'issue-pickup',
    title: origin,
    kind: 'code',
    branch: null,
    status,
    reason: 'because',
  });
  const gateLeft = (markup: string) => {
    const m = /class="fx-gate" style="left:(\d+)px"/.exec(markup);
    assert.ok(m, 'no gate rendered');
    return Number(m[1]);
  };

  const none = render((s) => {
    s.upcoming = { cycleId: 'c', at: new Date().toISOString(), items: [item('issue:1', 'waiting')] };
  });
  const two = render((s) => {
    s.upcoming = {
      cycleId: 'c',
      at: new Date().toISOString(),
      items: [item('issue:1', 'dispatching'), item('issue:2', 'dispatching'), item('issue:3', 'waiting')],
    };
  });

  assert.ok(gateLeft(two) > gateLeft(none), 'the gate must move right as more items dispatch');
  // Two crates of pitch 140 between them, exactly.
  assert.equal(gateLeft(two) - gateLeft(none), 280);
});

/** The queue reaches the belt at all — the panel this skin exists to replace. */
test('the belt carries the dispatcher plan', () => {
  const markup = render();
  assert.match(markup, /issue:208/, 'the top candidate is missing from the belt');
  assert.match(markup, /Plan at cap/, 'a capped item must say so rather than look merely queued');
});
