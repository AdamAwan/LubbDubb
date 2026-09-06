import { THEME_TOKENS, type TokenKind } from './tokens.js';

// → docs/spec/17-cockpit.md#the-address-bar

export const THEME_KEY = 'lubbdubb.theme';

export type PresetId =
  | 'dark'
  | 'light'
  | 'contrast'
  | 'solarized-dark'
  | 'monokai'
  | 'dracula'
  | 'one-dark'
  | 'moonlight'
  | 'amber'
  | 'nord'
  | 'gruvbox-dark'
  | 'catppuccin-mocha'
  | 'tokyo-night'
  | 'night-owl'
  | 'github-dark'
  | 'solarized-light'
  | 'github-light';

type PresetGround = 'dark' | 'light';

export const PRESETS: readonly { id: PresetId; label: string; blurb: string; ground: PresetGround }[] = [
  { id: 'dark', label: 'Dark', blurb: 'The default — cool slate, one warm accent', ground: 'dark' },
  { id: 'light', label: 'Light', blurb: 'Paper ground, hues darkened to hold against it', ground: 'light' },
  { id: 'contrast', label: 'High contrast', blurb: 'Black ground, white lettering, loud hues', ground: 'dark' },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    blurb: "Schoonover's palette, mapped role for role",
    ground: 'dark',
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    blurb: "Schoonover's cream paper, the same eight hues",
    ground: 'light',
  },
  { id: 'monokai', label: 'Monokai', blurb: 'The classic editor palette', ground: 'dark' },
  { id: 'dracula', label: 'Dracula', blurb: 'Violet ground, six bright accents', ground: 'dark' },
  {
    id: 'one-dark',
    label: 'Atom One Dark',
    blurb: "Atom's, and already half here — the ANSI cyan is its",
    ground: 'dark',
  },
  { id: 'moonlight', label: 'Moonlight', blurb: 'The one cool-violet ground', ground: 'dark' },
  { id: 'nord', label: 'Nord', blurb: 'Arctic blue-grey, frost and aurora accents', ground: 'dark' },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark', blurb: 'Warm retro browns, earthy hues', ground: 'dark' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', blurb: 'Soft pastels on a deep mauve ground', ground: 'dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', blurb: 'Deep indigo, neon blues and violets', ground: 'dark' },
  { id: 'night-owl', label: 'Night Owl', blurb: "Drasner's navy, tuned for a dark room", ground: 'dark' },
  { id: 'github-dark', label: 'GitHub Dark', blurb: "GitHub's own dark UI", ground: 'dark' },
  { id: 'github-light', label: 'GitHub Light', blurb: "GitHub's own light UI", ground: 'light' },
  { id: 'amber', label: 'Amber', blurb: 'Warm and low-blue, for a room with the lights off', ground: 'dark' },
];

export const PRESET_GROUPS: readonly { ground: PresetGround; label: string }[] = [
  { ground: 'dark', label: 'Dark' },
  { ground: 'light', label: 'Light' },
];

const DEFAULT_PRESET: PresetId = 'dark';

const PRESET_ALIASES: Readonly<Record<string, PresetId>> = {};

export interface ThemePrefs {
  preset: PresetId;
  overrides: Readonly<Record<string, string>>;
}

const DEFAULT_PREFS: ThemePrefs = { preset: DEFAULT_PRESET, overrides: {} };

const KIND_OF = new Map<string, TokenKind>(THEME_TOKENS.map((t) => [t.name, t.kind]));

export function isTokenValue(name: string, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const kind = KIND_OF.get(name);
  if (kind === 'colour') return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
  if (kind === 'radius') return /^\d{1,3}(?:px|rem|em|%)?$/.test(value);
  if (kind === 'space') return /^\d{1,3}(?:px|rem|em)( \d{1,3}(?:px|rem|em))?$/.test(value);
  if (kind === 'metric') return /^\d{1,3}(?:\.\d{1,2})?(?:px|rem|em)?$/.test(value);
  if (kind === 'font') return value.length <= 200 && !/[;(){}]|url|\\/i.test(value);
  return false;
}

export function readThemePrefs(raw: string | null): ThemePrefs {
  if (!raw) return DEFAULT_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS;
  const record = parsed as { preset?: unknown; overrides?: unknown };
  const named = typeof record.preset === 'string' ? record.preset : '';
  const preset = PRESETS.some((p) => p.id === named) ? (named as PresetId) : (PRESET_ALIASES[named] ?? DEFAULT_PRESET);
  const overrides: Record<string, string> = {};
  const source = record.overrides;
  if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
    for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
      if (KIND_OF.has(name) && isTokenValue(name, value)) overrides[name] = value;
    }
  }
  return { preset, overrides };
}

export function loadThemePrefs(): ThemePrefs {
  try {
    return readThemePrefs(localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveThemePrefs(prefs: ThemePrefs): void {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(prefs));
  } catch {
    // TECHDEBT: a browser refusing storage (private mode, quota) costs the theme its
    // durability, not the session its colours.
  }
}

/**
 * What {@link applyTheme} writes to. `HTMLElement` satisfies it structurally; a
 * test passes a recording stub.
 *
 * @public used by ThemeSettings for live preview and by the test's stub
 */
export interface ThemeTarget {
  readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function applyTheme(prefs: ThemePrefs, target: ThemeTarget): void {
  if (prefs.preset === DEFAULT_PRESET) target.removeAttribute('data-theme');
  else target.setAttribute('data-theme', prefs.preset);
  for (const token of THEME_TOKENS) {
    const value = prefs.overrides[token.name];
    if (value !== undefined && isTokenValue(token.name, value)) target.style.setProperty(token.name, value);
    else target.style.removeProperty(token.name);
  }
}

export function applyToken(name: string, value: string | null, target: ThemeTarget): void {
  if (value !== null && isTokenValue(name, value)) target.style.setProperty(name, value);
  else target.style.removeProperty(name);
}

let unsaved = false;
const unsavedListeners = new Set<() => void>();

export function setThemeUnsaved(next: boolean): void {
  if (next === unsaved) return;
  unsaved = next;
  for (const listener of unsavedListeners) listener();
}

/** @public read through `useThemeUnsaved` by the top bar and the config tabs */
export function themeUnsaved(): boolean {
  return unsaved;
}

/** @public subscribed to by `useThemeUnsaved` */
export function subscribeThemeUnsaved(listener: () => void): () => void {
  unsavedListeners.add(listener);
  return () => {
    unsavedListeners.delete(listener);
  };
}
