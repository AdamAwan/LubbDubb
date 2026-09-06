import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PetActionKind, PetState, PetView } from '../web/src/types.js';

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
  assert.ok(!html.includes('pet-origin-ref'), 'the ref is printed twice');
});

test('the whole sentence is reachable from the card however long the label is', () => {
  const label = 'x'.repeat(90);
  const html = draw([pet({ originLabel: label })]);
  assert.match(html, new RegExp(`title="Found when you answered “${label}”"`));
});
