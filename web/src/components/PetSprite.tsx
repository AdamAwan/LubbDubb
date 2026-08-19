import { useEffect, useRef } from 'react';
import type { PetView } from '../types.js';
import { paletteFor } from '../pets/palette.js';
import { spriteFor } from '../pets/sprites.js';

/**
 * One creature, drawn on a canvas at an integer scale with smoothing off.
 *
 * Canvas rather than a grid of `<div>`s: an adult is 14×14, which is 196 nodes
 * per pet and four of them redrawn on every change to the queue above.
 *
 * `beatMs` is the period of the idle bob, and **zero means still**. The caller
 * derives it from how busy the fleet is, which is what makes the corner of the
 * rail worth putting a creature in at all: a vivarium that quickens under load
 * and sleeps while dispatch is paused is a fleet status you can read from across
 * the room without parsing anything.
 *
 * The bob is CSS on the wrapper rather than a redraw, so however many pets are on
 * screen they animate on one clock and cost one composite.
 */
export function PetSprite({ pet, size, beatMs }: { pet: PetView; size: number; beatMs: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const grid = spriteFor(pet.species, pet.rarity, pet.stage);
  const palette = paletteFor(pet.seed);

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
        ctx.fillStyle = colour;
        ctx.fillRect(x * px, y * px, px, px);
      }
    }
  }, [grid, palette, size]);

  return (
    <span
      className={beatMs > 0 ? 'pet-sprite is-beating' : 'pet-sprite'}
      style={beatMs > 0 ? { animationDuration: `${beatMs}ms` } : undefined}
      title={`${pet.name ?? pet.display} · ${pet.stage}`}
    >
      <canvas ref={canvas} aria-hidden="true" />
    </span>
  );
}
