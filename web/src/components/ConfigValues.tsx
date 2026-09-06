import { useState } from 'react';
import { api } from '../api.js';
import { isStateColour } from '../stateColour.js';
import { ColourField } from './ColourField.js';
import type { ConfigChange, RunningConfigEntry, RunningConfigGroup, RunningConfigPayload } from '../types.js';
import { Panel } from './panel.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export interface Staged {
  set: Record<string, unknown>;
  clear: string[];
}

interface Draft {
  raw: string;
  error: string | null;
}

export function ConfigValues({
  payload,
  staged,
  saved,
  group,
  control,
  states,
  onGroup,
  onStage,
  onReview,
  onReloaded,
}: {
  payload: RunningConfigPayload;
  staged: Staged;
  saved: readonly ConfigChange[] | null;
  group: string | null;
  control: { cap: number; paused: boolean };
  states: readonly string[];
  onGroup: (group: string | null) => void;
  onStage: (staged: Staged) => void;
  onReview: () => void;
  onReloaded: () => void;
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const shown = payload.groups.find((entry) => entry.title === group) ?? payload.groups[0];
  const broken = Object.values(drafts).some((draft) => draft.error !== null);
  const unmet = unmetRequirements(payload, staged);

  const edit = (entry: RunningConfigEntry, raw: string): void => {
    const parsed = parseValue(entry, raw);
    setDrafts((held) => ({ ...held, [entry.path]: { raw, error: parsed.error } }));
    if (parsed.error !== null) return;
    const next: Staged = {
      set: { ...staged.set },
      clear: staged.clear.filter((path) => path !== entry.path),
    };
    if (JSON.stringify(parsed.value) === JSON.stringify(entry.value)) delete next.set[entry.path];
    else next.set[entry.path] = parsed.value;
    onStage(next);
  };

  const reset = (path: string): void => {
    setDrafts((held) => {
      const { [path]: _dropped, ...rest } = held;
      return rest;
    });
    const set = { ...staged.set };
    delete set[path];
    onStage({ set, clear: [...staged.clear, path] });
  };

  const undo = (path: string): void => {
    setDrafts((held) => {
      const { [path]: _dropped, ...rest } = held;
      return rest;
    });
    const set = { ...staged.set };
    delete set[path];
    onStage({ set, clear: staged.clear.filter((entry) => entry !== path) });
  };

  const restart = async (interrupt: boolean): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    try {
      await api.restartHarness(interrupt);
    } catch (err) {
      setRefusal((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dirty = Object.keys(staged.set).length + staged.clear.length;

  return (
    <div className="cfg-body">
      <aside className="cfg-rail">
        <div className="cfg-railhead">Groups</div>
        {payload.groups.map((entry) => (
          <button
            key={entry.title}
            className={`cfg-railrow${entry.title === shown?.title ? ' on' : ''}`}
            onClick={() => onGroup(entry.title)}
          >
            {entry.title}
            <span className={`cfg-count${chosenIn(entry) > 0 ? ' set' : ''}`}>
              {chosenIn(entry)}/{entry.entries.length}
            </span>
          </button>
        ))}
        <div className="cfg-railnote">
          Precedence, later winning: defaults → <code>lubbdubb.config.json</code> → environment → live controls.
          <br />
          <br />
          This page writes the <b>file</b> layer only. Anything the environment pins is shown, and locked.
        </div>
      </aside>

      <div className="cfg-main">
        {payload.pending.length > 0 && (
          <PendingCard
            pending={payload.pending}
            canRestart={payload.canRestart}
            busy={busy}
            onRestart={(interrupt) => void restart(interrupt)}
          />
        )}

        {saved && saved.length > 0 && (
          <p className="cfg-saved">
            Written to <code>{payload.file}</code>. {saved.filter((change) => change.applied).length} applied now,{' '}
            {saved.filter((change) => !change.applied).length} waiting for a restart.
          </p>
        )}

        <Panel density="flush" className="cfg-card">
          <h3>
            {shown?.title ?? 'Config'}
            <span className="cfg-more">
              {chosenIn(shown)} of {shown?.entries.length ?? 0} configured
              {dirty > 0 ? ` · ${dirty} staged` : ''}
            </span>
          </h3>
          <p className="cfg-hint">
            Editing a row stages a change to <code>{payload.file}</code> — nothing else stores it. A value in{' '}
            <b>bold</b> is one the file sets; the rest are inherited, shown as they resolve.
            {payload.projectFile !== null && (
              <>
                {' '}
                Rows marked <span className="cfg-src project">project</span> come from{' '}
                <code>{payload.projectFile}</code>, which your team commits — saving here overrides one for you alone.
              </>
            )}
          </p>
          {(shown?.entries ?? [])
            .filter((entry) => entry.access !== 'advanced')
            .map((entry) => (
              <Row
                key={entry.path}
                entry={entry}
                draft={drafts[entry.path]}
                staged={stagedFor(staged, entry.path)}
                states={states}
                required={unmet.some((need) => need.entry.path === entry.path)}
                onEdit={(raw) => edit(entry, raw)}
                onReset={() => reset(entry.path)}
                onUndo={() => undo(entry.path)}
              />
            ))}
        </Panel>

        {(shown?.entries ?? []).some((entry) => entry.access === 'advanced') && (
          <Panel density="flush" className="cfg-card">
            <button className="cfg-advhead" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              <span className="muted">{advanced ? '▾' : '▸'}</span> Advanced
              <Tag tone="amber">
                {(shown?.entries ?? []).filter((entry) => entry.access === 'advanced').length} keys that can lock you
                out
              </Tag>
            </button>
            {advanced && (
              <>
                <p className="cfg-advwarn">
                  These decide where the fleet works and how you reach this cockpit. Every one of them is read once, at
                  boot, and a wrong value here is one you fix in the file rather than in here.
                </p>
                {(shown?.entries ?? [])
                  .filter((entry) => entry.access === 'advanced')
                  .map((entry) => (
                    <Row
                      key={entry.path}
                      entry={entry}
                      draft={drafts[entry.path]}
                      staged={stagedFor(staged, entry.path)}
                      states={states}
                      required={unmet.some((need) => need.entry.path === entry.path)}
                      onEdit={(raw) => edit(entry, raw)}
                      onReset={() => reset(entry.path)}
                      onUndo={() => undo(entry.path)}
                    />
                  ))}
              </>
            )}
          </Panel>
        )}

        {/* The two values a config block on its own would lie about: both are
            runtime-adjustable through the fleet control and revert to the file on
            restart. Drawn from the same fetch as the rows above, so the two halves
            of "live 5, configured 3" can never come from readings that disagree. */}
        <Panel density="flush" className="cfg-card">
          <h3>Live now</h3>
          <div className="cfg-liverow">
            <span className="cfg-key">Agent cap</span>
            <span className="cfg-value">
              <b>{control.cap}</b>
              {configured(payload, 'maxConcurrentAgents') !== String(control.cap) && (
                <span className="muted"> — overriding the configured {configured(payload, 'maxConcurrentAgents')}</span>
              )}
            </span>
          </div>
          <div className="cfg-liverow">
            <span className="cfg-key">Paused</span>
            <span className="cfg-value">
              <b>{String(control.paused)}</b>
              {configured(payload, 'startPaused') !== String(control.paused) && (
                <span className="muted"> — overriding the configured {configured(payload, 'startPaused')}</span>
              )}
            </span>
          </div>
        </Panel>

        {refusal && <p className="cfg-refusal">{refusal}</p>}
      </div>

      {dirty > 0 && (
        <div className="cfg-dirty">
          <span className="cfg-dirtyn">{dirty} staged</span>
          <span className="cfg-dirtywhat">
            {broken
              ? 'one of them is not a value this field takes'
              : unmet.length > 0
                ? `${unmet[0]?.entry.path ?? ''} is needed while ${unmet[0]?.because ?? ''}`
                : `nothing has been written to ${payload.file} yet`}
          </span>
          <div className="cfg-dirtyacts">
            {unmet.length > 0 && unmet[0] && unmet[0].group !== shown?.title && (
              <Button ghost size="small" onClick={() => onGroup(unmet[0]?.group ?? null)}>
                Show it
              </Button>
            )}
            <Button
              ghost
              size="small"
              onClick={() => {
                setDrafts({});
                onStage({ set: {}, clear: [] });
                onReloaded();
              }}
            >
              Discard all
            </Button>
            <Button tone="primary" size="small" disabled={broken || unmet.length > 0} onClick={onReview}>
              Review &amp; write
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PendingCard({
  pending,
  canRestart,
  busy,
  onRestart,
}: {
  pending: readonly ConfigChange[];
  canRestart: boolean;
  busy: boolean;
  onRestart: (interrupt: boolean) => void;
}): React.JSX.Element {
  const [interrupt, setInterrupt] = useState(false);
  return (
    <Panel density="flush" className="cfg-card cfg-pending">
      <h3>
        Waiting for a restart
        {canRestart ? (
          <span className="cfg-more">
            <label className="cfg-toggle">
              <input type="checkbox" checked={interrupt} onChange={(e) => setInterrupt(e.target.checked)} />
              stop running agents
            </label>
            <Button size="small" disabled={busy} onClick={() => onRestart(interrupt)}>
              Apply and restart
            </Button>
          </span>
        ) : (
          <span className="cfg-more tag">no supervisor</span>
        )}
      </h3>
      {pending.map((change) => (
        <div className="cfg-liverow" key={change.path}>
          <span className="cfg-key">{change.path}</span>
          <span className="cfg-value">
            {render(change.from)} → <b>{render(change.to)}</b>
          </span>
        </div>
      ))}
      {!canRestart && (
        <p className="cfg-hint">
          This harness was not started by the supervisor, so nothing here can restart it. Restart it the way you started
          it — these are what it will come back on.
        </p>
      )}
    </Panel>
  );
}

function Row({
  entry,
  draft,
  staged,
  states,
  required,
  onEdit,
  onReset,
  onUndo,
}: {
  entry: RunningConfigEntry;
  draft: Draft | undefined;
  staged: 'set' | 'cleared' | null;
  states: readonly string[];
  required: boolean;
  onEdit: (raw: string) => void;
  onReset: () => void;
  onUndo: () => void;
}): React.JSX.Element {
  const locked = entry.env !== null || entry.access === 'fileOnly';
  const raw = draft?.raw ?? rawOf(entry.value);

  return (
    <div className={`cfg-row${entry.isDefault ? '' : ' set'}${staged ? ' staged' : ''}${required ? ' needed' : ''}`}>
      <div className="cfg-key">
        {entry.path}
        {required && <span className="cfg-need">needed</span>}
        <span className="cfg-why">{entry.why}</span>
      </div>

      <div className="cfg-inwrap">
        {staged === 'cleared' ? (
          <span className="muted">
            {entry.fromProject ? 'will fall back to the project’s value' : 'will fall back to its default'}
          </span>
        ) : (
          <Widget entry={entry} raw={raw} locked={locked} states={states} onEdit={onEdit} />
        )}
        {/* The suggestion is a button and never a value the form fills in: the
            whole point of an address nobody else writes to is that its owner
            typed it. Offered while the field is empty, whether or not anything
            requires it yet. */}
        {entry.suggestion !== undefined && raw === '' && !locked && staged !== 'cleared' && (
          <Button ghost size="small" className="cfg-suggest" onClick={() => onEdit(entry.suggestion ?? '')}>
            Use <code>{entry.suggestion}</code>
          </Button>
        )}
        {required && (
          <span className="cfg-bad">
            {entry.requiredWhen?.path} is not “{entry.requiredWhen?.unless}”, so this one has to be set
          </span>
        )}
        {draft?.error && <span className="cfg-bad">{draft.error}</span>}
        {entry.ms && !draft?.error && staged !== 'cleared' && Number.isFinite(Number(raw)) && (
          <span className="cfg-unit">{humanizeMs(Number(raw))}</span>
        )}
      </div>

      <div>
        {/* Four layers, four words. "project" is the one an operator cannot act
            on from here — it is committed in the repository the fleet works on —
            so a row that drew it as "default" would send them looking for a key
            their own file does not have. */}
        {entry.env !== null ? (
          <span className="cfg-src env">env {entry.env}</span>
        ) : !entry.isDefault ? (
          <span className="cfg-src file">file</span>
        ) : entry.fromProject ? (
          <span className="cfg-src project">project</span>
        ) : (
          <span className="cfg-src">default</span>
        )}
        <div className={`cfg-effect${entry.live ? ' now' : ''}`}>
          {entry.access === 'fileOnly'
            ? 'file only'
            : entry.env !== null
              ? 'locked'
              : entry.live
                ? 'now'
                : 'at restart'}
        </div>
      </div>

      <div className="cfg-act">
        {staged ? (
          <Button ghost size="small" onClick={onUndo}>
            Undo
          </Button>
        ) : (
          !entry.isDefault &&
          !locked && (
            <Button ghost size="small" onClick={onReset}>
              Reset
            </Button>
          )
        )}
      </div>
    </div>
  );
}

function Widget({
  entry,
  raw,
  locked,
  states,
  onEdit,
}: {
  entry: RunningConfigEntry;
  raw: string;
  locked: boolean;
  states: readonly string[];
  onEdit: (raw: string) => void;
}): React.JSX.Element {
  if (locked) return <input className="cfg-in locked" value={raw} readOnly />;
  if (entry.type === 'colourMap') {
    const map = readColourMap(raw);
    if (map) return <ColourMap map={map} states={states} onEdit={onEdit} />;
  }
  if (entry.type === 'boolean') {
    return (
      <label className="cfg-toggle">
        <input type="checkbox" checked={raw === 'true'} onChange={(e) => onEdit(String(e.target.checked))} />
        <span className="muted">{raw}</span>
      </label>
    );
  }
  if (entry.type === 'enum') {
    return (
      <select className="cfg-in" value={raw} onChange={(e) => onEdit(e.target.value)}>
        {(entry.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (entry.type === 'stringList' || entry.type === 'json' || entry.type === 'colourMap' || entry.type === 'text') {
    return (
      <textarea
        className="cfg-in cfg-in-tall"
        value={raw}
        rows={entry.type === 'json' || entry.type === 'text' ? 4 : 3}
        onChange={(e) => onEdit(e.target.value)}
      />
    );
  }
  return (
    <input
      className="cfg-in"
      inputMode={entry.type === 'number' ? 'numeric' : 'text'}
      value={raw}
      placeholder={entry.suggestion ?? ''}
      onChange={(e) => onEdit(e.target.value)}
    />
  );
}

const NEW_COLOUR = '#7fb3ff';

function ColourMap({
  map,
  states,
  onEdit,
}: {
  map: Readonly<Record<string, string>>;
  states: readonly string[];
  onEdit: (raw: string) => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState('');
  const write = (next: Record<string, string>): void => onEdit(JSON.stringify(next, null, 2));

  const add = (): void => {
    const state = adding.trim();
    if (state === '' || Object.hasOwn(map, state)) return;
    setAdding('');
    write({ ...map, [state]: NEW_COLOUR });
  };

  const known = states.filter((state) => !Object.hasOwn(map, state));

  return (
    <div className="cfg-colours">
      {Object.entries(map).map(([state, colour]) => (
        <div className="cfg-colour" key={state}>
          <ColourField
            value={colour}
            label={`Colour for ${state}`}
            valid={isStateColour(colour)}
            onChange={(next) => write({ ...map, [state]: next })}
          />
          <i className="tag" style={{ color: colour, borderColor: colour }}>
            {state}
          </i>
          <Button
            ghost
            size="small"
            title={`Stop colouring "${state}" — it goes back to the reading it had before`}
            onClick={() => {
              const { [state]: _dropped, ...rest } = map;
              write(rest);
            }}
          >
            Remove
          </Button>
        </div>
      ))}

      <div className="cfg-colouradd">
        <input
          className="cfg-in"
          list="cfg-states"
          placeholder={known.length > 0 ? 'A state to colour…' : 'A state to colour'}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <datalist id="cfg-states">
          {known.map((state) => (
            <option key={state} value={state} />
          ))}
        </datalist>
        <Button size="small" disabled={adding.trim() === ''} onClick={add}>
          Add
        </Button>
        {Object.keys(map).length === 0 && (
          <span className="muted">Nothing is coloured — every state draws as it always has.</span>
        )}
      </div>
    </div>
  );
}

function asColourMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [state, colour] of Object.entries(value)) {
    if (!isStateColour(colour)) return null;
    out[state] = colour;
  }
  return out;
}

function readColourMap(raw: string): Record<string, string> | null {
  try {
    return asColourMap(JSON.parse(raw));
  } catch {
    return null;
  }
}

interface Unmet {
  entry: RunningConfigEntry;
  group: string;
  because: string;
}

function unmetRequirements(payload: RunningConfigPayload, staged: Staged): Unmet[] {
  const out: Unmet[] = [];
  for (const group of payload.groups) {
    for (const entry of group.entries) {
      const need = entry.requiredWhen;
      if (!need) continue;
      const raiser = find(payload, need.path);
      if (!raiser || staged.clear.includes(need.path)) continue;
      const on = Object.hasOwn(staged.set, need.path) ? staged.set[need.path] : raiser.value;
      if (on === need.unless) continue;
      const held = staged.clear.includes(entry.path)
        ? entry.fromProject
          ? 'project'
          : ''
        : Object.hasOwn(staged.set, entry.path)
          ? staged.set[entry.path]
          : entry.value;
      if (typeof held === 'string' && held.trim() !== '') continue;
      out.push({ entry, group: group.title, because: `${need.path} is “${String(on)}”` });
    }
  }
  return out;
}

function find(payload: RunningConfigPayload, path: string): RunningConfigEntry | undefined {
  for (const group of payload.groups) {
    const hit = group.entries.find((entry) => entry.path === path);
    if (hit) return hit;
  }
  return undefined;
}

function stagedFor(staged: Staged, path: string): 'set' | 'cleared' | null {
  if (staged.clear.includes(path)) return 'cleared';
  return Object.hasOwn(staged.set, path) ? 'set' : null;
}

function chosenIn(group: RunningConfigGroup | undefined): number {
  return (group?.entries ?? []).filter((entry) => !entry.isDefault).length;
}

function configured(payload: RunningConfigPayload, path: string): string {
  const hit = find(payload, path);
  return hit ? rawOf(hit.value) : '—';
}

function rawOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join('\n');
  return JSON.stringify(value, null, 2);
}

function render(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

function parseValue(entry: RunningConfigEntry, raw: string): { value: unknown; error: string | null } {
  switch (entry.type) {
    case 'number': {
      const parsed = Number(raw);
      const ok = raw.trim() !== '' && Number.isFinite(parsed);
      return { value: ok ? parsed : null, error: ok ? null : 'not a number' };
    }
    case 'boolean':
      return { value: raw === 'true', error: null };
    case 'enum':
      return {
        value: raw,
        error: (entry.options ?? []).includes(raw) ? null : `not one of ${(entry.options ?? []).join(', ')}`,
      };
    case 'stringList':
      return {
        value: raw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
        error: null,
      };
    case 'json':
      try {
        return { value: JSON.parse(raw), error: null };
      } catch (err) {
        return { value: null, error: (err as Error).message };
      }
    case 'colourMap': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return { value: null, error: (err as Error).message };
      }
      const map = asColourMap(parsed);
      return map ? { value: map, error: null } : { value: null, error: 'each state needs a #rrggbb colour' };
    }
    default:
      return { value: raw, error: null };
  }
}

function humanizeMs(ms: number): string {
  if (ms === 0) return 'off';
  for (const [unit, size] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ] as const) {
    if (ms >= size) return `${String(Math.round((ms / size) * 10) / 10)}${unit}`;
  }
  return `${ms}ms`;
}
