import { useEffect, useMemo, useRef } from 'react';
import type { PetRarity, PetSpecies, PetStage } from '../types.js';
import { inkFor, paletteFor } from '../pets/palette.js';
import { crackFor, dressSprite, SPRITE_PAD, spriteFor } from '../pets/sprites.js';

// → docs/spec/17-cockpit.md

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
  stage: PetStage | 'egg';
  seed: string;
  size: number;
  blank?: boolean;
  rocks?: number;
  phase?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const plain = spriteFor(species, rarity, stage);
  const grid = useMemo(() => dressSprite(plain, rarity, seed, phase), [plain, rarity, seed, phase]);
  const crack = stage === 'egg' ? crackFor(rocks) : null;
  const palette = paletteFor(seed);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const width = Math.max(...grid.map((row) => row.length));
    const height = grid.length;
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
      const row = grid[y]!.padEnd(width, '.');
      for (let x = 0; x < width; x++) {
        const cell = row[x]!;
        const colour = ink[cell];
        if (colour === undefined) continue;
        ctx.fillStyle = blank ? (OUTSIDE.has(cell) ? SILHOUETTE_FAINT : SILHOUETTE) : colour;
        ctx.fillRect(x * px, y * px, px, px);
      }
    }
    if (crack === null) return;
    for (let y = 0; y < crack.length; y++) {
      const row = crack[y]!;
      for (let x = 0; x < row.length; x++) {
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

const SILHOUETTE = '#7c838e';

const SILHOUETTE_FAINT = '#7c838e66';

const OUTSIDE = new Set(['g', 's', 'A', 'a']);
