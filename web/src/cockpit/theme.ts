/**
 * The theme: which preset the cockpit is drawn in, and any token moved off it.
 *
 * ## Why the preference is in `localStorage`
 *
 * Beside the notification preference and for its reason exactly: it is a property
 * of *this browser*, not of the harness. Two people on one deployment want
 * different answers, and a server-side setting would make one of them wrong. It is
 * not {@link Place} state either — the address bar holds where you are, and a theme
 * is true of every place at once. `?section=theme` is somewhere you can be; the
 * theme is not.
 *
 * That is also why there is no route, no config key and nothing on the wire. The
 * whole feature is this module, `tokens.ts`, `theme.css` and one section.
 *
 * ## Why the stored value is sparse
 *
 * A preset id plus only the tokens the operator moved, rather than a snapshot of
 * all hundred-odd. Two things fall out of that and neither would survive a
 * snapshot. Switching Dark → Light keeps three deliberate edits, where a snapshot
 * would carry ninety dark values into Light and produce a hybrid nobody chose. And
 * a token added in a later build themes itself, because an absent key means
 * "whatever the preset says" rather than "the value that was current when this was
 * written".
 *
 * There is deliberately **no `version` field**. Every field is validated on the way
 * in, the way `loadNotifyPrefs` does it, and a version number would be a promise to
 * write migrations for a preference cheap enough to lose.
 *
 * → docs/spec/17-cockpit.md#the-theme
 */

import { THEME_TOKENS, type TokenKind } from './tokens.js';

/**
 * The stored key. `web/index.html` names this same string in an inline script, so
 * that a light theme is applied before the first paint rather than after it — see
 * {@link applyTheme}. `test/cockpitTheme.test.ts` asserts the two agree, because a
 * rename here would otherwise leave that script reading a key nothing writes.
 */
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

/**
 * Which way up a preset is. The picker groups by it, because seventeen tiles in
 * one run is a search and "dark or light" is the first question anyone asks of a
 * theme; the answer is declared here rather than read off `--bg`, since the sheet
 * is not loaded where the list is drawn.
 */
type PresetGround = 'dark' | 'light';

/**
 * The presets, in the order the section draws them.
 *
 * Dark is first and is the default because it is `:root` itself — `theme.css` has
 * no block for it, so there is no second copy of the default palette to drift.
 */
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

/** The rows the picker draws, in order. Every preset's `ground` names one of these. */
export const PRESET_GROUPS: readonly { ground: PresetGround; label: string }[] = [
  { ground: 'dark', label: 'Dark' },
  { ground: 'light', label: 'Light' },
];

const DEFAULT_PRESET: PresetId = 'dark';

/**
 * Presets that have been renamed, and where they went.
 *
 * The `TAB_ALIASES` idea from `place.ts`, for the same reason: an unknown preset
 * falls back to Dark, so without this a rename would silently restyle everyone who
 * had chosen the old one. What matters as much as the id is that the fallback
 * **keeps the overrides** — landing on Dark with your edits intact is recoverable,
 * and a wiped theme is not.
 */
const PRESET_ALIASES: Readonly<Record<string, PresetId>> = {};

export interface ThemePrefs {
  preset: PresetId;
  /** Sparse: only the tokens moved off the preset. `--name` → value. */
  overrides: Readonly<Record<string, string>>;
}

const DEFAULT_PREFS: ThemePrefs = { preset: DEFAULT_PRESET, overrides: {} };

const KIND_OF = new Map<string, TokenKind>(THEME_TOKENS.map((t) => [t.name, t.kind]));

/**
 * Whether a value is one this token may hold.
 *
 * Narrow on purpose, and not only for tidiness: these values are handed to
 * `style.setProperty`, and a custom property substituted into a property that
 * accepts a URL is the ordinary shape of CSS-variable injection. A colour is a hex
 * literal and nothing else — every colour token is hex since the overlays moved to
 * the eight-digit form, so there is no alpha case to admit separately.
 */
export function isTokenValue(name: string, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const kind = KIND_OF.get(name);
  if (kind === 'colour') return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
  if (kind === 'radius') return /^\d{1,3}(?:px|rem|em|%)?$/.test(value);
  // One length or two — a frame's inset is `10px 12px`, and a shorthand longer than
  // that is a fourth padding by the back door, which is the spread the ramp replaced.
  if (kind === 'space') return /^\d{1,3}(?:px|rem|em)( \d{1,3}(?:px|rem|em))?$/.test(value);
  // A decimal length, or a bare number for a weight. Half a pixel is a real step at
  // 10px, so `space`'s whole-number grammar would refuse the sheet's own values.
  if (kind === 'metric') return /^\d{1,3}(?:\.\d{1,2})?(?:px|rem|em)?$/.test(value);
  if (kind === 'font') return value.length <= 200 && !/[;(){}]|url|\\/i.test(value);
  return false;
}

/**
 * Parse a stored theme, falling back to the default on anything unreadable.
 *
 * Tolerant by construction, and split out from {@link loadThemePrefs} so it is
 * testable in node, which has no `localStorage`. An override naming a token the
 * registry no longer carries is **dropped** rather than retained-and-ignored:
 * keeping it would re-apply it the day someone adds a token by that name meaning
 * something else. The drop is not persisted until the operator saves, so upgrading,
 * looking, and going back loses nothing.
 */
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
    // A browser refusing storage (private mode, quota) costs the theme its
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

/**
 * Put a theme on the document.
 *
 * Two mechanisms, one for each half of the shape, mirroring the split VS Code makes
 * between a theme contribution and `colorCustomizations`. The preset is an
 * attribute, because the palettes are CSS and a block wins on specificity. The
 * overrides are inline custom properties, because only those can express a sparse
 * set — one `setProperty` per moved token, and `removeProperty` to give one back.
 *
 * The default preset **removes** the attribute rather than writing `dark`, so each
 * theme has exactly one spelling in the DOM, for the reason `placeQuery` omits
 * defaults from the query string.
 *
 * Every registered token is visited, not only the overridden ones — that is what
 * makes this idempotent and two-way. Applying a draft that has dropped a token
 * clears it; tracking what was set last time instead would leave a reverted edit
 * standing, which is the bug that makes live preview one-way.
 */
export function applyTheme(prefs: ThemePrefs, target: ThemeTarget): void {
  if (prefs.preset === DEFAULT_PRESET) target.removeAttribute('data-theme');
  else target.setAttribute('data-theme', prefs.preset);
  for (const token of THEME_TOKENS) {
    const value = prefs.overrides[token.name];
    if (value !== undefined && isTokenValue(token.name, value)) target.style.setProperty(token.name, value);
    else target.style.removeProperty(token.name);
  }
}

/**
 * One token, straight to the element — the live-preview path.
 *
 * Deliberately not routed through {@link applyTheme}: a dragged colour input fires
 * on every frame, and rewriting a hundred properties per frame over a five-thousand
 * line stylesheet is work with nothing to show for it. React holds the draft; this
 * holds the paint.
 */
export function applyToken(name: string, value: string | null, target: ThemeTarget): void {
  if (value !== null && isTokenValue(name, value)) target.style.setProperty(name, value);
  else target.style.removeProperty(name);
}

/**
 * Whether the Theme section is holding an edit that has not been saved.
 *
 * Module state and a listener set rather than React state, because the two ends
 * are not in one tree: the section is inside the config page and the marker is on
 * the top bar's cog, which outlives it. It is not {@link Place} state either — an
 * unsaved edit is a fact about this tab, not a destination, and putting it in the
 * query string would make the back button undo it.
 *
 * It is deliberately **not** persisted. The draft lives in the section's own state
 * and dies with the tab, so a flag that outlived a reload would mark a pending
 * edit that no longer exists.
 *
 * The section publishes on every change and **never clears on unmount** — leaving
 * the section keeps the preview, so the cost has to stay visible off-page, which
 * is the whole reason this exists. → docs/spec/17-cockpit.md#the-section
 */
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
