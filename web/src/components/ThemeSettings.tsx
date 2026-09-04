import { useEffect, useMemo, useState } from 'react';
import {
  applyTheme,
  applyToken,
  isTokenValue,
  loadThemePrefs,
  PRESET_GROUPS,
  PRESETS,
  saveThemePrefs,
  setThemeUnsaved,
  type PresetId,
  type ThemePrefs,
} from '../cockpit/theme.js';
import { THEME_TOKENS, TOKEN_GROUPS, type ThemeToken, type TokenGroup } from '../cockpit/tokens.js';
import { ColourField } from './ColourField.js';
import { Button } from './button.js';

/**
 * The theme: a preset, and any token moved off it.
 *
 * Writable, like Notifications and unlike the rest of this page, and for the same
 * reason — it is a preference of this browser rather than of the harness, so it
 * answers "now" rather than "at the next restart". Nothing here reaches the server.
 *
 * ## Live preview is a DOM write, not a render
 *
 * A dragged colour input fires continuously. `onInput` does two things and they are
 * deliberately different in kind: {@link applyToken} writes the property straight to
 * `documentElement`, which *is* the preview, and `setDraft` records it so the rows
 * and the counts can redraw. React never sits in the drag path, which is what keeps
 * it smooth over a five-thousand line stylesheet.
 *
 * `onInput` rather than `onChange` is load-bearing: Chrome fires `change` on a
 * colour input only when the picker is dismissed, so `onChange` alone would give no
 * live preview at all while dragging.
 *
 * ## Leaving with unsaved edits keeps the preview
 *
 * On purpose — the whole point is to go and look at a real goal page in the theme
 * you are building. So the applier is a plain call and **never an effect whose
 * cleanup reverts it**, and the bar says what that costs: a reload drops them.
 *
 * Which is also why {@link setThemeUnsaved} is published from an effect with **no
 * cleanup**: the marker on the cog is the bar's sentence for everywhere the bar is
 * not, so unmounting this section must not clear it.
 */
const SEARCH_HINT = 'Search by name, by what it is called, or by what it does';

/** A row's current value: the operator's override, else what the sheet computes. */
function shownValue(token: ThemeToken, draft: Readonly<Record<string, string>>): string {
  const override = draft[token.name];
  if (override !== undefined) return override;
  if (typeof getComputedStyle !== 'function') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(token.name).trim();
}

export function ThemeSettings() {
  const [saved, setSaved] = useState<ThemePrefs>(() => loadThemePrefs());
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>(() => loadThemePrefs().overrides);
  const [preset, setPreset] = useState<PresetId>(() => loadThemePrefs().preset);
  // Not on `Place`, for the reason the review step is not: a filter inside an
  // unsaved edit is a step, not a destination. `?keys=` is the values tab's besides.
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const root = typeof document === 'undefined' ? null : document.documentElement;

  const dirty = preset !== saved.preset || THEME_TOKENS.some((t) => draft[t.name] !== saved.overrides[t.name]);

  // No cleanup, on purpose — see the note above. Save and Revert both land here
  // with `dirty` false, so nothing else has to clear it.
  useEffect(() => setThemeUnsaved(dirty), [dirty]);

  const choosePreset = (id: PresetId): void => {
    setPreset(id);
    setJustSaved(false);
    if (root) applyTheme({ preset: id, overrides: draft }, root);
  };

  const setToken = (token: ThemeToken, value: string): void => {
    setJustSaved(false);
    setDraft((prev) => ({ ...prev, [token.name]: value }));
    if (root) applyToken(token.name, value, root);
  };

  const resetToken = (token: ThemeToken): void => {
    setJustSaved(false);
    setDraft((prev) => {
      const next = { ...prev };
      delete next[token.name];
      return next;
    });
    if (root) applyToken(token.name, null, root);
  };

  const revert = (): void => {
    setPreset(saved.preset);
    setDraft(saved.overrides);
    setJustSaved(false);
    if (root) applyTheme(saved, root);
  };

  // A statement about the preset rather than about the edit, which is why it sits
  // beside the picker and not in the save bar.
  const resetAll = (): void => {
    setDraft({});
    setJustSaved(false);
    if (root) applyTheme({ preset, overrides: {} }, root);
  };

  const save = (): void => {
    const next: ThemePrefs = { preset, overrides: draft };
    saveThemePrefs(next);
    setSaved(next);
    setJustSaved(true);
  };

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      THEME_TOKENS.filter((t) => {
        if (onlyChanged && draft[t.name] === undefined) return false;
        if (!advanced && TOKEN_GROUPS[t.group].advanced && !needle && !onlyChanged) return false;
        if (!needle) return true;
        return (
          t.name.includes(needle) || t.label.toLowerCase().includes(needle) || t.why.toLowerCase().includes(needle)
        );
      }),
    [needle, onlyChanged, advanced, draft],
  );

  const groups = (Object.keys(TOKEN_GROUPS) as TokenGroup[]).filter((g) => visible.some((t) => t.group === g));
  const changed = THEME_TOKENS.filter((t) => draft[t.name] !== undefined).length;
  const presetLabel = PRESETS.find((p) => p.id === preset)?.label ?? preset;

  return (
    <div className="th">
      {/* Tiles carry the swatches and a name only, in a Dark row and a Light row;
          the blurb is drawn once, beneath, for the preset that is on. Seventeen
          blurbs is a page, and the question the picker answers is "which one". */}
      <div className="th-presets" role="radiogroup" aria-label="Theme">
        {PRESET_GROUPS.map((g) => (
          <div className="th-preset-group" key={g.ground}>
            <span className="th-preset-groupn">{g.label}</span>
            <div className="th-preset-tiles">
              {PRESETS.filter((p) => p.ground === g.ground).map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={preset === p.id}
                  className={`th-preset${preset === p.id ? ' on' : ''}`}
                  onClick={() => choosePreset(p.id)}
                  title={p.blurb}
                >
                  {/* The swatches read their colours through the same declaration block
                      as the theme itself — `theme.css` gives every preset a
                      `[data-theme-swatch]` selector beside its `html[data-theme]` one —
                      so a card cannot show a palette its preset does not have. */}
                  <span className="th-sws" data-theme-swatch={p.id}>
                    <i className="th-sw" style={{ background: 'var(--bg)' }} />
                    <i className="th-sw" style={{ background: 'var(--panel)' }} />
                    <i className="th-sw" style={{ background: 'var(--text)' }} />
                    <i className="th-sw" style={{ background: 'var(--accent)' }} />
                  </span>
                  <b className="th-presetn">{p.label}</b>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="th-presetb">{PRESETS.find((p) => p.id === preset)?.blurb}</p>

      <div className="th-tools">
        <input
          className="th-search"
          type="search"
          value={query}
          placeholder={SEARCH_HINT}
          aria-label={SEARCH_HINT}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="th-only">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
          Only what I have changed
        </label>
        <label className="th-only">
          <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
          Show every token
        </label>
        {changed > 0 && (
          <Button ghost size="small" onClick={resetAll}>
            Reset to {presetLabel}
          </Button>
        )}
      </div>

      {groups.length === 0 && <p className="muted th-empty">Nothing matches “{query}”.</p>}

      {groups.map((g) => (
        <section className="th-group" key={g}>
          <h3 className="th-groupn">{TOKEN_GROUPS[g].label}</h3>
          <p className="muted th-groupb">{TOKEN_GROUPS[g].blurb}</p>
          {visible
            .filter((t) => t.group === g)
            .map((token) => {
              const value = shownValue(token, draft);
              const set = draft[token.name] !== undefined;
              return (
                <div className={`th-row${set ? ' set' : ''}`} key={token.name}>
                  <code className="th-name">{token.name}</code>
                  <span className="th-label">{token.label}</span>
                  <span className="th-why muted">{token.why}</span>
                  <span className="th-pick">
                    {token.kind === 'colour' ? (
                      <ColourField
                        value={value}
                        label={token.label}
                        valid={value === '' || isTokenValue(token.name, value)}
                        onChange={(next) => setToken(token, next)}
                      />
                    ) : (
                      <input
                        type="text"
                        className={`cf-hex${value !== '' && !isTokenValue(token.name, value) ? ' bad' : ''}`}
                        aria-label={token.label}
                        value={value}
                        spellCheck={false}
                        onChange={(e) => setToken(token, e.target.value)}
                      />
                    )}
                  </span>
                  {/* Drawn only when the row is overridden: a hundred disabled
                      buttons is furniture, not an affordance. */}
                  {set ? (
                    <button
                      className="th-reset"
                      title={`Back to ${presetLabel}`}
                      aria-label={`Reset ${token.label} to ${presetLabel}`}
                      onClick={() => resetToken(token)}
                    >
                      ↺
                    </button>
                  ) : (
                    <span className="th-reset" />
                  )}
                </div>
              );
            })}
        </section>
      ))}

      <div className="th-bar">
        <span className="th-barn">
          {dirty ? (
            /* A preset change sets `dirty` but moves no token, so the count would
               read zero of the thing the sentence says is unsaved — which reads as
               "nothing pending" (issue #680). The message names what changed. */
            changed === 0 ? (
              <>
                Preset <b>{presetLabel}</b>, unsaved — a reload drops it
              </>
            ) : (
              <>
                <b>{changed}</b> token{changed === 1 ? '' : 's'} changed · unsaved, and a reload drops them
              </>
            )
          ) : justSaved ? (
            <>Saved · this browser only</>
          ) : (
            <>
              {changed > 0 ? (
                <>
                  <b>{changed}</b> token{changed === 1 ? '' : 's'} off {presetLabel}
                </>
              ) : (
                <>{presetLabel}, unmodified</>
              )}
            </>
          )}
        </span>
        <span className="th-baracts">
          <Button ghost size="small" onClick={revert} disabled={!dirty}>
            Revert unsaved
          </Button>
          <Button size="small" onClick={save} disabled={!dirty}>
            Save
          </Button>
        </span>
      </div>
    </div>
  );
}
