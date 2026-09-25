import type { PetRarity, PetSpecies, PetStage } from '../types.js';
import { ADULTS } from './adultSprites.js';
import { JUVENILES } from './juvenileSprites.js';

// → docs/spec/22-pets.md

const HATCHLINGS: Record<PetRarity, readonly string[]> = {
  common: ['..oooo..', '.oOOOOo.', 'oOhOOhOo', 'oOeOOeOo', 'oOOOOOOo', 'oOOmmOOo', '.oOOOOo.', '..oooo..'],
  uncommon: ['..o..o..', '..oooo..', '.oOhhOo.', 'oOOOOOOo', 'oOeOOeOo', 'oOOOOOOo', '.oOmmOo.', '..oooo..'],
  rare: ['...oo...', '..oOOo..', '.oOhhOo.', 'oOOOOOOo', 'oOeOOeOo', 'oOmOOmOo', '.oOOOOo.', '..oooo..'],
  mythic: ['.o.oo.o.', '.oooooo.', 'oOhOOhOo', 'oOOOOOOo', 'oOeOOeOo', 'oOmmmmOo', 'oOOOOOOo', '.oooooo.'],
};

const EGGS: Record<PetRarity, readonly string[]> = {
  common: [
    '...oooo...',
    '..oOOOOo..',
    '.oOhhOOOo.',
    '.oOhOOOOo.',
    'oOOOOOOOOo',
    'oOOOOOOOOo',
    'oOOOOmOOOo',
    'oOOOOOOOOo',
    'oOOOOOOOOo',
    'oOOOOOOOOo',
    '.oOOOOOOo.',
    '..oooooo..',
  ],
  uncommon: [
    '...oooo...',
    '..oOOOOo..',
    '.oOhhOOOo.',
    '.oOhOOOOo.',
    'oOOOOOOOOo',
    'oOmmmmmmOo',
    'oOOOOOOOOo',
    'oOOOOOOOOo',
    'oOmmmmmmOo',
    'oOOOOOOOOo',
    '.oOOOOOOo.',
    '..oooooo..',
  ],
  rare: [
    '...oooo...',
    '..oOOOOo..',
    '.oOhhOOOo.',
    '.oOhOOmOo.',
    'oOOOmmOOOo',
    'oOOmOOOOOo',
    'oOmOOOmmOo',
    'oOOOOmOOOo',
    'oOOmmOOOOo',
    'oOOOOOOmOo',
    '.oOOOOOOo.',
    '..oooooo..',
  ],
  mythic: [
    '...oooo...',
    '..oOmmOo..',
    '.oOhmmOOo.',
    '.oOhmmOOo.',
    'oOOmmmOOOo',
    'oOmmOmmmOo',
    'oOmmmOmmOo',
    'oOOmmmmOOo',
    'oOmmOmmmOo',
    'oOOmmmOOOo',
    '.oOmmmOOo.',
    '..oooooo..',
  ],
};

const CRACKS: readonly (readonly string[])[] = [
  [
    '..........',
    '..........',
    '..........',
    '..........',
    '.....c....',
    '....c.....',
    '.....c....',
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
  ],
  [
    '..........',
    '..........',
    '...c......',
    '...c......',
    '..c.c.....',
    '...c......',
    '....c.....',
    '...c......',
    '..c.......',
    '..........',
    '..........',
    '..........',
  ],
  [
    '..........',
    '..........',
    '...c......',
    '...c......',
    '..c.c.....',
    '.ckckckck.',
    '..cc.cc...',
    '...c......',
    '..c.......',
    '..........',
    '..........',
    '..........',
  ],
];

export function crackFor(rocks: number): readonly string[] | null {
  if (rocks <= 0) return null;
  return CRACKS[Math.min(rocks, CRACKS.length) - 1]!;
}

export function spriteFor(species: PetSpecies, rarity: PetRarity, stage: PetStage | 'egg'): readonly string[] {
  if (stage === 'egg') return EGGS[rarity]!;
  if (stage === 'hatchling') return HATCHLINGS[rarity]!;
  return stage === 'juvenile' ? JUVENILES[species]! : ADULTS[species]!;
}

export const SPRITE_PAD = 2;

function padded(grid: readonly string[], cells: number): readonly string[] {
  const width = Math.max(...grid.map((row) => row.length));
  const margin = '.'.repeat(cells);
  const blank = '.'.repeat(width + cells * 2);
  return [
    ...Array.from({ length: cells }, () => blank),
    ...grid.map((row) => `${margin}${row.padEnd(width, '.')}${margin}`),
    ...Array.from({ length: cells }, () => blank),
  ];
}

const LIT = new WeakMap<readonly string[], readonly string[]>();

function rimLight(grid: readonly string[]): readonly string[] {
  const cached = LIT.get(grid);
  if (cached !== undefined) return cached;
  const width = Math.max(...grid.map((row) => row.length));
  const rows = grid.map((row) => row.padEnd(width, '.').replace(/h/g, 'O'));
  const at = (y: number, x: number): string => rows[y]?.[x] ?? '.';
  const open = (cell: string): boolean => cell === '.' || cell === 'o';
  const out = rows.map((row, y) =>
    [...row]
      .map((cell, x) => {
        if (cell !== 'O') return cell;
        const score =
          (open(at(y - 1, x)) ? 1 : 0) +
          (open(at(y, x - 1)) ? 1 : 0) -
          (open(at(y + 1, x)) ? 1 : 0) -
          (open(at(y, x + 1)) ? 1 : 0);
        if (score > 0) return 'h';
        if (score < 0) return 'd';
        return 'O';
      })
      .join(''),
  );
  LIT.set(grid, out);
  return out;
}

function glinted(grid: readonly string[]): readonly string[] {
  const rows = padded(grid, SPRITE_PAD).map((row) => [...row]);
  let top = Infinity;
  let left = Infinity;
  let bottom = -1;
  let right = -1;
  rows.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell === '.') return;
      top = Math.min(top, y);
      left = Math.min(left, x);
      bottom = Math.max(bottom, y);
      right = Math.max(right, x);
    }),
  );
  if (bottom < 0) return rows.map((row) => row.join(''));
  for (const [y, x] of [
    [top - 1, left - 1],
    [top - 1, right + 1],
    [bottom + 1, left - 1],
    [bottom + 1, right + 1],
  ] as const) {
    if (rows[y]?.[x] === '.') rows[y]![x] = 's';
  }
  return rows.map((row) => row.join(''));
}

function glowing(grid: readonly string[]): readonly string[] {
  const rows = padded(grid, 1);
  const at = (y: number, x: number): string => rows[y]?.[x] ?? '.';
  const solid = (cell: string): boolean => cell !== '.' && cell !== 'g';
  return rows.map((row, y) =>
    [...row]
      .map((cell, x) => {
        if (cell !== '.' || (x + y) % 2 !== 0) return cell;
        const touching = solid(at(y - 1, x)) || solid(at(y + 1, x)) || solid(at(y, x - 1)) || solid(at(y, x + 1));
        return touching ? 'g' : cell;
      })
      .join(''),
  );
}

function sparkled(grid: readonly string[], seed: string, phase: number): readonly string[] {
  const rows = padded(grid, 1).map((row) => [...row]);
  const height = rows.length;
  const width = rows[0]!.length;
  const hash = hash32(`${seed}:spark`);
  const centreY = (height - 1) / 2;
  const centreX = (width - 1) / 2;
  const free = (y: number, x: number): boolean => rows[y]?.[x] === '.' || rows[y]?.[x] === 'g';
  for (let i = 0; i < 4; i++) {
    const beat = (phase + i * 3) % 8;
    if (beat > 3) continue;
    const spread = (hash >>> (i * 6)) % 64;
    const angle = (spread / 64 + i / 4) * Math.PI * 2;
    let y = -1;
    let x = -1;
    for (let step = 0; step <= 4; step++) {
      const scale = 1 - step * 0.11;
      const ty = Math.round(centreY + Math.sin(angle) * (height / 2 - 0.5) * scale);
      const tx = Math.round(centreX + Math.cos(angle) * (width / 2 - 0.5) * scale);
      if (free(ty, tx)) {
        y = ty;
        x = tx;
        break;
      }
    }
    if (y < 0) continue;
    rows[y]![x] = 'A';
    if (beat !== 1) continue;
    for (const [ay, ax] of [
      [y - 1, x],
      [y + 1, x],
      [y, x - 1],
      [y, x + 1],
    ] as const) {
      if (free(ay, ax)) rows[ay]![ax] = 'a';
    }
  }
  return rows.map((row) => row.join(''));
}

function hash32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function dressSprite(
  grid: readonly string[],
  rarity: PetRarity,
  seed: string,
  phase: number,
): readonly string[] {
  const lit = rimLight(grid);
  if (rarity === 'mythic') return sparkled(glowing(lit), seed, phase);
  if (rarity === 'rare') return glinted(lit);
  return padded(lit, SPRITE_PAD);
}
