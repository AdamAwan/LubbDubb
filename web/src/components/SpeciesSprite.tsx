import { useEffect, useRef } from 'react';
import type { PetRarity, PetSpecies, PetStage } from '../types.js';
import { paletteFor } from '../pets/palette.js';
import { spriteFor } from '../pets/sprites.js';

/**
 * One creature drawn on a canvas, and the only implementation of that.
 *
 * Split out of {@link PetSprite} for the Pets page, which draws forms **nobody
 * owns**: a species you have not found has no `PetView` to hand, and the three
 * stages of one you have are three drawings of a record that is only ever at one
 * of them. Both callers therefore name what to draw rather than passing a pet, and
 * a second copy of the canvas loop — the obvious alternative — is how one view of
 * these bytes comes to disagree with the other.
 *
 * Canvas rather than a grid of `<div>`s: an adult is 14×14, which is 196 nodes per
 * pet and four of them redrawn on every change to the queue above.
 *
 * `blank` fills every lit pixel with one grey instead of the palette, which is what
 * the Pets page withholds an unfound species with. A blur was the other option and
 * is worse: blurred pixel art reads as a rendering fault rather than as a state,
 * and a silhouette stays recognisable enough to be worth going and finding.
 */
export function SpeciesSprite({
  species,
  rarity,
  stage,
  seed,
  size,
  blank = false,
}: {
  species: PetSpecies;
  rarity: PetRarity;
  stage: PetStage;
  /** The action key the colours are derived from. Ignored when `blank`. */
  seed: string;
  size: number;
  blank?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const grid = spriteFor(species, rarity, stage);
  const palette = paletteFor(seed);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const width = Math.max(...grid.map((row) => row.length));
    const height = grid.length;
    // Whole pixels only. A fractional scale turns a hand-placed grid into a smear
    // of half-lit edges, which is the one thing this direction was chosen for not
    // doing.
    const px = Math.max(1, Math.floor(size / Math.max(width, height)));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = width * px * dpr;
    el.height = height * px * dpr;
    el.style.width = `${width * px}px`;
    el.style.height = `${height * px}px`;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width * px, height * px);
    const ink: Record<string, string | undefined> = {
      o: palette.outline,
      O: palette.body,
      h: palette.highlight,
      e: palette.eye,
      m: palette.marking,
    };
    for (let y = 0; y < height; y++) {
      // Padded here rather than counted in the source: a grid that is ragged in
      // `sprites.ts` still comes out square, so nobody aligns dots by eye.
      const row = grid[y]!.padEnd(width, '.');
      for (let x = 0; x < width; x++) {
        const colour = ink[row[x]!];
        if (colour === undefined) continue;
        ctx.fillStyle = blank ? SILHOUETTE : colour;
        ctx.fillRect(x * px, y * px, px, px);
      }
    }
  }, [grid, palette, size, blank]);

  return <canvas ref={canvas} aria-hidden="true" />;
}

/**
 * The one grey an unfound species is drawn in.
 *
 * A literal in a `.tsx` rather than a token, for the same reason `paletteFor`'s
 * five are: a canvas takes a colour, not a custom property, so a token here would
 * have to be read back out of the computed style at draw time — and then re-read
 * on every theme change, which nothing else in the cockpit has to do. It is picked
 * to clear both grounds rather than to suit either, which is what makes leaving it
 * out of the theme honest rather than merely convenient.
 */
const SILHOUETTE = '#7c838e';
