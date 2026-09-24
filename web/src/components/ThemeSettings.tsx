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

// → docs/spec/17-cockpit.md

const SEARCH_HINT = 'Search by name, by what it is called, or by what it does';

function shownValue(token: ThemeToken, draft: Readonly<Record<string, string>>): string {
  const override = draft[token.name];
  if (override !== undefined) return override;
  if (typeof getComputedStyle !== 'function') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(token.name).trim();
}

function PresetPicker({ preset, onChoose }: { preset: PresetId; onChoose: (id: PresetId) => void }) {
  return (
    <>
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
                  onClick={() => onChoose(p.id)}
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
    </>
  );
}

function TokenRow({
  token,
  draft,
  presetLabel,
  onSet,
  onReset,
}: {
  token: ThemeToken;
  draft: Readonly<Record<string, string>>;
  presetLabel: string;
  onSet: (value: string) => void;
  onReset: () => void;
}) {
  const value = shownValue(token, draft);
  const set = draft[token.name] !== undefined;
  return (
    <div className={`th-row${set ? ' set' : ''}`}>
      <code className="th-name">{token.name}</code>
      <span className="th-label">{token.label}</span>
      <span className="th-why muted">{token.why}</span>
      <span className="th-pick">
        {token.kind === 'colour' ? (
          <ColourField
            value={value}
            label={token.label}
            valid={value === '' || isTokenValue(token.name, value)}
            onChange={onSet}
          />
        ) : (
          <input
            type="text"
            className={`cf-hex${value !== '' && !isTokenValue(token.name, value) ? ' bad' : ''}`}
            aria-label={token.label}
            value={value}
            spellCheck={false}
            onChange={(e) => onSet(e.target.value)}
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
          onClick={onReset}
        >
          ↺
        </button>
      ) : (
        <span className="th-reset" />
      )}
    </div>
  );
}

function SaveBar({
  dirty,
  changed,
  justSaved,
  presetLabel,
  onRevert,
  onSave,
}: {
  dirty: boolean;
  changed: number;
  justSaved: boolean;
  presetLabel: string;
  onRevert: () => void;
  onSave: () => void;
}) {
  return (
    <div className="th-bar">
      <span className="th-barn">
        {dirty ? (
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
        <Button ghost size="small" onClick={onRevert} disabled={!dirty}>
          Revert unsaved
        </Button>
        <Button size="small" onClick={onSave} disabled={!dirty}>
          Save
        </Button>
      </span>
    </div>
  );
}

function useThemeEditor() {
  const [saved, setSaved] = useState<ThemePrefs>(() => loadThemePrefs());
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>(() => loadThemePrefs().overrides);
  const [preset, setPreset] = useState<PresetId>(() => loadThemePrefs().preset);
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const root = typeof document === 'undefined' ? null : document.documentElement;

  const dirty = preset !== saved.preset || THEME_TOKENS.some((t) => draft[t.name] !== saved.overrides[t.name]);

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

  return {
    draft,
    preset,
    query,
    setQuery,
    onlyChanged,
    setOnlyChanged,
    advanced,
    setAdvanced,
    justSaved,
    dirty,
    choosePreset,
    setToken,
    resetToken,
    revert,
    resetAll,
    save,
  };
}

export function ThemeSettings() {
  const editor = useThemeEditor();
  const { draft, preset, query, onlyChanged, advanced, dirty } = editor;

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
      <PresetPicker preset={preset} onChoose={editor.choosePreset} />

      <div className="th-tools">
        <input
          className="th-search"
          type="search"
          value={query}
          placeholder={SEARCH_HINT}
          aria-label={SEARCH_HINT}
          onChange={(e) => editor.setQuery(e.target.value)}
        />
        <label className="th-only">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => editor.setOnlyChanged(e.target.checked)} />
          Only what I have changed
        </label>
        <label className="th-only">
          <input type="checkbox" checked={advanced} onChange={(e) => editor.setAdvanced(e.target.checked)} />
          Show every token
        </label>
        {changed > 0 && (
          <Button ghost size="small" onClick={editor.resetAll}>
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
            .map((token) => (
              <TokenRow
                key={token.name}
                token={token}
                draft={draft}
                presetLabel={presetLabel}
                onSet={(next) => editor.setToken(token, next)}
                onReset={() => editor.resetToken(token)}
              />
            ))}
        </section>
      ))}

      <SaveBar
        dirty={dirty}
        changed={changed}
        justSaved={editor.justSaved}
        presetLabel={presetLabel}
        onRevert={editor.revert}
        onSave={editor.save}
      />
    </div>
  );
}
