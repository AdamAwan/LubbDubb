import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isStateColour, stateColour, stateColourKey } from '../web/src/stateColour.js';

/**
 * Issue #405. A tracker with a rich workflow reports a dozen state words and the
 * cockpit drew every one of them the same grey, so the column said nothing at a
 * glance. The colours are the operator's — the harness reads none of them — which
 * is why the only server-side claim worth asserting is that the map reaches the
 * cockpit whole.
 */

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the global goes in before the component's module loads,
// as `console.test.ts` does it.
(globalThis as { React?: typeof React }).React = React;

const { ConfigValues } = await import('../web/src/components/ConfigValues.js');

const colours = { 'In Review': '#e0a020', Worthyable: '#7fb3ff', Closed: '#666b73' };

test('a state finds its colour whatever the tracker punctuates it with', () => {
  assert.equal(stateColour(colours, 'In Review'), '#e0a020');
  assert.equal(stateColour(colours, 'in review'), '#e0a020');
  assert.equal(stateColour(colours, 'in-review'), '#e0a020');
  assert.equal(stateColour(colours, 'InReview'), '#e0a020');
  assert.equal(stateColour(colours, 'worthyable'), '#7fb3ff');
});

test('a state nobody coloured draws as it always did', () => {
  assert.equal(stateColour(colours, 'New'), null);
  assert.equal(stateColour({}, 'Doing'), null);
});

test('a state word is never a prefix match', () => {
  assert.equal(stateColour(colours, 'Review'), null);
  assert.equal(stateColour(colours, 'In Review Again'), null);
});

test('half a colour never reaches a style attribute', () => {
  assert.equal(stateColour({ Doing: '#abc' }, 'Doing'), null);
  assert.equal(stateColour({ Doing: 'green' }, 'Doing'), null);
  assert.equal(stateColour({ Doing: '' }, 'Doing'), null);
  assert.equal(stateColour({ Doing: '#12345g' }, 'Doing'), null);
  assert.equal(stateColour({ Doing: 42 } as unknown as Record<string, string>, 'Doing'), null);
});

test('the picker writes the one form that is read back', () => {
  assert.ok(isStateColour('#0a0B0c'));
  assert.ok(!isStateColour('#0a0b0'));
  assert.ok(!isStateColour('rgb(1,2,3)'));
  assert.equal(stateColourKey(' In-Review '), 'inreview');
});

test('the operator’s colours reach the cockpit, and an unset map is empty rather than absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-colour-'));
  const build = (over: Record<string, unknown>) =>
    buildSystem(
      loadConfig({
        auth: { enabled: false } as never,
        dbPath: ':memory:',
        agentMode: 'raw',
        deskRoot: join(dir, 'desk'),
        worktreeRoot: join(dir, 'wt'),
        heartbeatIntervalMs: 999_999,
        ...over,
      }),
      { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
    );

  const colours = { 'In Review': '#e0a020', Worthyable: '#7fb3ff' };
  const set = build({ issueStateColours: colours });
  assert.deepEqual((await buildStateSnapshot(set)).config.stateColours, colours);
  set.store.close();

  const unset = build({});
  assert.deepEqual(
    (await buildStateSnapshot(unset)).config.stateColours,
    {},
    'a deployment that coloured nothing still ships a map, so the cockpit reads one shape',
  );
  unset.store.close();
});

test('a colourMap field draws a swatch per state over the states the tracker reports', () => {
  const entry = {
    path: 'issueStateColours',
    value: { Worthyable: '#7fb3ff' },
    isDefault: false,
    type: 'colourMap' as const,
    access: 'plain' as const,
    live: true,
    env: null,
    why: 'why',
  };
  const html = renderToStaticMarkup(
    createElement(ConfigValues, {
      payload: {
        groups: [{ title: 'Integrations', entries: [entry] }],
        file: 'lubbdubb.config.json',
        projectFile: null,
        text: '{}',
        revision: 'r',
        pending: [],
        canRestart: false,
      },
      staged: { set: {}, clear: [] },
      saved: null,
      group: 'Integrations',
      control: { cap: 3, paused: false },
      states: ['Doing', 'Worthyable'],
      onGroup: () => {},
      onStage: () => {},
      onReview: () => {},
      onReloaded: () => {},
    }),
  );

  assert.match(html, /type="color"[^>]*value="#7fb3ff"/, 'the colour is picked, not typed as JSON');
  assert.match(html, /aria-label="Colour for Worthyable"/, 'the swatch says which state it is for');
  assert.match(html, /<option value="Doing">/, 'a state the tracker reports and nobody coloured is offered');
  assert.ok(!html.includes('<option value="Worthyable">'), 'a state already coloured is not offered again');
  assert.match(html, /color:#7fb3ff/, 'the row previews itself in the chip the value lands on');
  assert.ok(!html.includes('<textarea'), 'a drawable map is never handed back as JSON');
});
