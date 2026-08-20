import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PetActionKind, PetState, PetView } from '../web/src/types.js';

/**
 * The origin line, as the card draws it.
 *
 * The panel's one job is to say what the operator was doing when a pet dropped,
 * and the thing that goes wrong here is silent: a kind whose phrase was never
 * given a label reads as a sentence with a row id wedged into it, and a null
 * label — a source row somebody pruned — draws a blank where the ref used to be.
 * Both render perfectly. → `docs/spec/22-pets.md#what-the-origin-line-says`
 */

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the panel's module loads so the test exercises the same source.
(globalThis as { React?: typeof React }).React = React;

const { PetsPanel } = await import('../web/src/components/PetsPanel.js');

const KINDS: readonly PetActionKind[] = ['escalation', 'human-task', 'plan', 'landing', 'job', 'finding', 'upgrade'];

function pet(over: Partial<PetView> = {}): PetView {
  return {
    id: 'pet_1',
    species: 'pip',
    seed: 'escalation:esc_Jdt9l826iQ',
    name: null,
    fed: 0,
    originKind: 'escalation',
    originRef: 'esc_Jdt9l826iQ',
    originLabel: 'Rebase or merge the stack?',
    hatchedAt: new Date(1_700_000_000_000).toISOString(),
    openedAt: new Date(1_700_000_000_000).toISOString(),
    placed: false,
    dissolvedAt: null,
    builtSha: null,
    builtClean: false,
    chain: null,
    rarity: 'common',
    display: 'pip',
    stage: 'hatchling',
    beatsToNextStage: 500,
    flaw: null,
    provenance: 'unknown',
    ...over,
  };
}

function draw(pets: PetView[]): string {
  const state: PetState = {
    pets,
    wallet: { earned: 0, spent: 0, balance: 0 },
    slots: 4,
    startedAt: null,
  };
  return renderToStaticMarkup(
    createElement(PetsPanel, {
      pets: state,
      now: 1_700_000_000_000,
      onFeed: async () => undefined,
      onRename: async () => undefined,
      onPlace: async () => undefined,
      onBlend: async () => undefined,
      onHatch: () => undefined,
    }),
  );
}

test('every origin kind reads as a sentence with the label in it', () => {
  for (const kind of KINDS) {
    const label = kind === 'upgrade' ? 'a1b2c3d' : `what ${kind} was about`;
    const html = draw([pet({ originKind: kind, originLabel: label })]);
    const said = /class="pet-origin-said"[^>]*>([^<]*)</.exec(html)?.[1];
    assert.ok(said !== undefined, `${kind}: no origin line drawn`);
    assert.ok(said.includes(label), `${kind}: the line does not name the label — ${said}`);
    // The sentence is about the operator, not about the table: nothing in it is
    // the row id once there is something better to say.
    assert.ok(!said.includes('esc_Jdt9l826iQ'), `${kind}: the line still prints the ref — ${said}`);
    assert.ok(said.startsWith('Found when'), `${kind}: not a sentence — ${said}`);
  }
});

test('the raw ref stays on the card beside the label', () => {
  const html = draw([pet()]);
  assert.match(html, /class="pet-origin-ref">esc_Jdt9l826iQ</);
});

test('a pet whose source row is gone draws the line the panel drew before labels', () => {
  const html = draw([pet({ originLabel: null })]);
  const said = /class="pet-origin-said"[^>]*>([^<]*)</.exec(html)?.[1];
  assert.equal(said, 'Found when you answered esc_Jdt9l826iQ');
  // ...and only once. The ref *is* the sentence here, so the mono detail beside
  // the timestamp would be the same string twice.
  assert.ok(!html.includes('pet-origin-ref'), 'the ref is printed twice');
});

test('the whole sentence is reachable from the card however long the label is', () => {
  const label = 'x'.repeat(90);
  const html = draw([pet({ originLabel: label })]);
  // Clamped in CSS, so the text is all in the markup — and the hover title is
  // what makes the clamped tail readable rather than lost.
  assert.match(html, new RegExp(`title="Found when you answered “${label}”"`));
});
