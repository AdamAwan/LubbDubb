import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { packStandingOf } from '../src/reviewPacks/standing.js';
import type { ReviewPackHead } from '../src/store/reviewPacks.js';

(globalThis as { React?: typeof React }).React = React;

const { PackMark } = await import('../web/src/components/PackMark.js');

/**
 * Whether a pull request has a review pack, as the rack draws it.
 *
 * The mark answers the one question a rack of twenty rows can afford to ask —
 * *is there something written here worth going to read* — and the fold under it
 * is the whole of the reading. What is asserted here is that it never claims more
 * than the rows support: a pack against a head nobody reported is not current, and
 * a pull request with no pack draws nothing at all.
 * → `docs/spec/31-review-packs.md#on-the-row`
 */

const head = (headSha: string): ReviewPackHead => ({ prNumber: 412, headSha, writtenAt: '2026-09-03T09:00:00.000Z' });

test('a pack is current only against the head it was written for', () => {
  assert.equal(packStandingOf(head('abc1234'), 'abc1234', false), 'current');
  assert.equal(packStandingOf(head('abc1234'), 'def5678', false), 'stale');
});

/**
 * The three-valued rule: the case that is about the **provider** — a pull request
 * reported with no head — must not be drawn as the case that is about the pack.
 */
test('a pack with no head to compare against says so rather than claiming to be current', () => {
  assert.equal(packStandingOf(head('abc1234'), undefined, false), 'unplaced');
});

test('an author on the pull request is a pack on its way, and nothing else is a mark', () => {
  assert.equal(packStandingOf(undefined, 'abc1234', true), 'writing');
  assert.equal(packStandingOf(undefined, 'abc1234', false), undefined);
});

test('no pack and nobody writing one draws nothing', () => {
  assert.equal(renderToStaticMarkup(createElement(PackMark, { pack: undefined })), '');
});

test('each arm draws its own tone, and only the stale one is badged', () => {
  const draw = (pack: 'current' | 'stale' | 'unplaced' | 'writing'): string =>
    renderToStaticMarkup(createElement(PackMark, { pack }));
  assert.match(draw('current'), /class="pk pk-current t-blue"/);
  assert.match(draw('writing'), /class="pk pk-writing t-accent"/);
  assert.ok(!draw('current').includes('pk-badge'), 'a current pack is badged as though it were behind');
  assert.match(draw('stale'), /pk-badge/);
  assert.match(draw('unplaced'), /aria-label="Review pack: A review pack — and no head to place it against"/);
});

test('the mark is a button only where it opens something', () => {
  assert.match(renderToStaticMarkup(createElement(PackMark, { pack: 'current', onOpen: () => {} })), /^<button/);
  assert.match(renderToStaticMarkup(createElement(PackMark, { pack: 'current' })), /^<span/);
});
