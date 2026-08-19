import { useEffect, useMemo, useRef } from 'react';
import type { PetRarity, PetSpecies, PetStage } from '../types.js';
import { inkFor, paletteFor } from '../pets/palette.js';
import { crackFor, dressSprite, SPRITE_PAD, spriteFor } from '../pets/sprites.js';

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
 *
 * `rocks` breaks the shell of an `egg`, and belongs here for the reason the rest of
 * the loop does: the crack is drawn over the same grid, in the same ink, and a
 * second canvas that only knew about shells is exactly the two-views-of-one-bytes
 * split this component exists to prevent.
 *
 * What is drawn is the **dressed** grid — the rim light, and whatever the rarity
 * ladder adds above it — which is why the scale is taken from the undressed one:
 * every dressed grid is `SPRITE_PAD` larger on each side, and sizing from it
 * would shrink every creature by a fifth to make room for a margin. The crack
 * overlay is offset by the same constant, for the same reason.
 * → `docs/spec/22-pets.md#the-rarity-ladder`
 */
export function SpeciesSprite({
  species,
  rarity,
  stage,
  seed,
  size,
  blank = false,
  rocks = 0,
  phase = 0,
}: {
  species: PetSpecies;
  rarity: PetRarity;
  /** The form to draw. `'egg'` is the one that comes before a stage. */
  stage: PetStage | 'egg';
  /** The action key the colours are derived from. Ignored when `blank`. */
  seed: string;
  size: number;
  blank?: boolean;
  /** How many times an egg has rocked, which is how broken its shell is. */
  rocks?: number;
  /**
   * Where a mythic's sparkle is in its cycle. A number rather than a clock, so
   * the drawing stays reproducible; **still at 0**, which is what every surface
   * that does not animate passes. → {@link dressSprite}
   */
  phase?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const plain = spriteFor(species, rarity, stage);
  // Memoised because it is no longer a module constant: a dressed grid is computed,
  // so without this every re-render of the panel above redraws every canvas under
  // it. The inputs are exactly what the drawing depends on.
  const grid = useMemo(() => dressSprite(plain, rarity, seed, phase), [plain, rarity, seed, phase]);
  const crack = stage === 'egg' ? crackFor(rocks) : null;
  const palette = paletteFor(seed);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const width = Math.max(...grid.map((row) => row.length));
    const height = grid.length;
    // Whole pixels only. A fractional scale turns a hand-placed grid into a smear
    // of half-lit edges, which is the one thing this direction was chosen for not
    // doing.
    const px = Math.max(1, Math.floor(size / Math.max(...plain.map((row) => row.length), plain.length)));
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
    const ink = inkFor(palette);
    for (let y = 0; y < height; y++) {
      // Padded here rather than counted in the source: a grid that is ragged in
      // `sprites.ts` still comes out square, so nobody aligns dots by eye.
      const row = grid[y]!.padEnd(width, '.');
      for (let x = 0; x < width; x++) {
        const cell = row[x]!;
        const colour = ink[cell];
        if (colour === undefined) continue;
        // A withheld species keeps its tier's devices — that is price, which this
        // page publishes — but they stay lighter than the body, or a glow drawn in
        // the one flat grey reads as more animal rather than as light.
        ctx.fillStyle = blank ? (OUTSIDE.has(cell) ? SILHOUETTE_FAINT : SILHOUETTE) : colour;
        ctx.fillRect(x * px, y * px, px, px);
      }
    }
    if (crack === null) return;
    // Over the shell rather than baked into it: one egg grid per tier serves every
    // stage of breaking, so the two cannot disagree about which shell is cracking.
    // `k` clears rather than paints — a hole in a shell is the canvas showing
    // through, and painting the ground into it would be a colour no theme can reach.
    for (let y = 0; y < crack.length; y++) {
      const row = crack[y]!;
      for (let x = 0; x < row.length; x++) {
        // Offset by the dressing's margin: the overlay is drawn in the shell's own
        // coordinates, and the grid under it is no longer at the canvas origin.
        const cx = (x + SPRITE_PAD) * px;
        const cy = (y + SPRITE_PAD) * px;
        if (row[x] === 'c') {
          ctx.fillStyle = blank ? SILHOUETTE : palette.outline;
          ctx.fillRect(cx, cy, px, px);
        } else if (row[x] === 'k') {
          ctx.clearRect(cx, cy, px, px);
        }
      }
    }
  }, [grid, plain, crack, palette, size, blank]);

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

/** The same grey, for the devices that sit outside the outline. → {@link OUTSIDE} */
const SILHOUETTE_FAINT = '#7c838e66';

/** The characters the rarity ladder draws past the animal's own edge. */
const OUTSIDE = new Set(['g', 's', 'A', 'a']);
