import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { PET_CATALOGUE } from '../src/pets/compendium.js';
import { PET_RULES } from '../src/pets/rules.js';
import { petStage } from '../src/pets/catalogue.js';
import { hourWindow } from '../web/src/components/PetsPage.js';
import type { PetCatalogue, PetRarity } from '../src/wire.js';

/**
 * The catalogue behind the Pets page.
 *
 * What is worth asserting here is not the numbers themselves — those are the
 * tables, and a test restating them would only be a third copy — but that the
 * catalogue is a *reading of* the tables rather than a second set of them. Every
 * test below is a property that stops being true the moment somebody computes one
 * of these figures a second way. → `docs/spec/22-pets.md#the-pets-page`
 */

const RANK: Record<PetRarity, number> = { common: 0, uncommon: 1, rare: 2, mythic: 3 };

test('every drop lands somewhere: the shares are a distribution', () => {
  const total = PET_CATALOGUE.species.reduce((sum, entry) => sum + entry.share, 0);
  // Within floating-point noise of exactly one. A share table that summed to less
  // would mean some hatch draws nothing, and one that summed to more would mean the
  // walk double-counts a pool — neither shows on a page, which reads perfectly
  // either way.
  assert.ok(Math.abs(total - 1) < 1e-9, `shares sum to ${total}`);
  for (const entry of PET_CATALOGUE.species) {
    assert.ok(entry.share > 0, `${entry.species} is in the catalogue but can never be drawn`);
    assert.ok(entry.kinds.length > 0, `${entry.species} lists no action that draws it`);
  }
});

test('a roll steps down or stays, never up', () => {
  for (const row of PET_CATALOGUE.sources) {
    assert.ok(
      RANK[row.landed] <= RANK[row.rolled],
      `${row.kind} rolled ${row.rolled} and landed ${row.landed}, which is a ceiling reached from below`,
    );
    assert.ok(row.members.length > 0, `${row.kind}/${row.rolled} landed on a tier it cannot fill`);
  }
});

test('a species is only listed under an action that can actually draw it', () => {
  for (const entry of PET_CATALOGUE.species) {
    for (const kind of entry.kinds) {
      const drawn = PET_CATALOGUE.sources.some((row) => row.kind === kind && row.members.includes(entry.species));
      assert.ok(drawn, `${entry.species} claims ${kind} draws it, but no tier of ${kind} lands on it`);
    }
  }
});

/**
 * The invariant the wire type exists for. `PetView.beatsToNextStage` and the page's
 * `adultAt` are two readings of one arithmetic, and the failure they guard against
 * is a card advertising a price the harness does not charge — which looks entirely
 * correct on screen.
 */
test('the stage thresholds are the ones a pet is actually graded against', () => {
  for (const entry of PET_CATALOGUE.species) {
    assert.equal(petStage(entry.species, entry.juvenileAt - 1), 'hatchling', `${entry.species} below juvenile`);
    assert.equal(petStage(entry.species, entry.juvenileAt), 'juvenile', `${entry.species} at juvenile`);
    assert.equal(petStage(entry.species, entry.adultAt - 1), 'juvenile', `${entry.species} below adult`);
    assert.equal(petStage(entry.species, entry.adultAt), 'adult', `${entry.species} at adult`);
    assert.equal(entry.blend, Math.round(PET_RULES.blendYield * entry.growth), `${entry.species} blend value`);
  }
});

/**
 * The gate is shipped as the hours rather than as a `nightOnly` flag precisely so
 * that nothing outside `src/pets/catalogue.ts` names which species is the nocturnal
 * one. This asserts the shape, not the species.
 */
test('an hour-gated species ships its hours and every other ships none', () => {
  const gated = PET_CATALOGUE.species.filter((entry) => entry.hours !== null);
  assert.ok(gated.length > 0, 'the catalogue has at least one gated species to describe');
  for (const entry of PET_CATALOGUE.species) {
    if (entry.hours === null) continue;
    assert.ok(
      entry.hours.length > 0 && entry.hours.length < 24,
      `${entry.species} is gated on nothing or on everything`,
    );
    assert.deepEqual(
      entry.hours,
      [...entry.hours].sort((a, b) => a - b),
      'hours arrive sorted',
    );
    assert.ok(
      entry.hours.every((hour) => Number.isInteger(hour) && hour >= 0 && hour < 24),
      `${entry.species} names an hour the clock does not have`,
    );
  }
});

/**
 * A window that wraps midnight is the only kind the catalogue currently has, and
 * the naive reading of a sorted list gets it exactly backwards — `[0,1,2,3,4,22,23]`
 * reads as 00:00–24:00 unless the gap is found first.
 */
test('the hour window is read as one run, wrapping midnight', () => {
  assert.deepEqual(hourWindow([22, 23, 0, 1, 2, 3, 4]), { from: 22, to: 5 });
  assert.deepEqual(hourWindow([9, 10, 11]), { from: 9, to: 12 });
  assert.deepEqual(hourWindow([23]), { from: 23, to: 0 });
  // Two windows have no single label, so the chip says so rather than picking one.
  assert.equal(hourWindow([1, 2, 14, 15]), null);
  assert.equal(hourWindow([]), null);
  // Every hour is not a window at all — that species is simply not gated.
  assert.equal(hourWindow([...Array(24).keys()]), null);
});

test('GET /api/pets/catalogue serves it whole', async () => {
  const system = buildSystem(
    // Auth off, so the assertion is about the payload rather than about a bearer;
    // `test/cockpitAuth.test.ts` owns the guard itself.
    loadConfig({ dbPath: ':memory:', heartbeatIntervalMs: 999_999, auth: { enabled: false } as never }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() },
  );
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/pets/catalogue' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as PetCatalogue;
    assert.equal(body.species.length, PET_CATALOGUE.species.length);
    assert.equal(body.sources.length, PET_CATALOGUE.sources.length);
    assert.deepEqual(body.rarities, PET_CATALOGUE.rarities);
    // The route serves the rules unaltered: the page's whole claim is that these
    // are the numbers the harness runs on, and a route that reshaped them would
    // make it a claim about the route instead.
    assert.deepEqual(body.rules, PET_RULES);
  } finally {
    await app.close();
  }
});
