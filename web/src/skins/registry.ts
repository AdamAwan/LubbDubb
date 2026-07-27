import type { Skin } from './types.js';
import { classicSkin } from './classic/index.js';
import { factorySkin } from './factory/index.js';

/**
 * Every skin the cockpit ships. This is also what makes a skin reachable to knip:
 * a directory nothing registers is correctly dead code.
 */
export const SKINS: readonly Skin[] = [classicSkin, factorySkin];

/** The skin a fresh browser, or a stored id nobody recognises, lands on. */
const DEFAULT_SKIN_ID = classicSkin.id;

/** Where the choice is remembered. Read by the pre-paint script in `index.html` too. */
const SKIN_STORAGE_KEY = 'lubbdubb.skin';

/**
 * Resolve a stored id. A value nobody recognises falls back silently rather than
 * erroring: a stale id after a skin is renamed or removed is a normal thing to
 * find in localStorage, and an error screen for it would be absurd.
 */
export function resolveSkin(id: string | null | undefined): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS.find((s) => s.id === DEFAULT_SKIN_ID)!;
}

export function readStoredSkinId(): string | null {
  try {
    return window.localStorage.getItem(SKIN_STORAGE_KEY);
  } catch {
    // Storage can throw outright in private modes; a skin preference is never
    // worth failing the cockpit over.
    return null;
  }
}

export function storeSkinId(id: string): void {
  try {
    window.localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
    /* ignore — the choice simply will not survive a reload */
  }
}
