import { useState } from 'react';
import { api } from '../api.js';
import { isStateColour } from '../stateColour.js';
import { ColourField } from './ColourField.js';
import type { ConfigChange, RunningConfigEntry, RunningConfigGroup, RunningConfigPayload } from '../types.js';
import { Panel } from './panel.js';
import { Button } from './button.js';

/**
 * The values section: every configurable leaf, grouped, editable.
 *
 * Three things the server decides and this only draws, because a browser that
 * decided them would be a second copy free to drift:
 *
 * - **What each value is** — the widget comes from `entry.type`, declared once in
 *   `src/configFields.ts`.
 * - **When saving it takes effect** — `entry.live` is true only because an arm in
 *   `src/configApply.ts` re-seats whoever holds the value.
 * - **What a reset means** — clearing the key, never writing the default back. The
 *   browser is deliberately never told what a default *is*; it is told
 *   `isDefault`, which is the answer to the question an operator asks.
 *
 * The one judgement that is made here is whether a key another key requires has
 * been filled in, and it is made here because it is a question about the **edit**:
 * `entry.requiredWhen` is the server's declaration, and the value it is judged
 * against is the staged one. Left to the server it would be the answer for the
 * config the harness is running — so an operator who switches the pool on and
 * saves gets the next boot's own refusal as a 400, over a key with no row on the
 * page to fix it.
 *
 * Nothing is written from here. Edits stage, and the write goes through the
 * review step — which is drawn from the server's own candidate bytes rather than
 * a guess at them.
 */

/** What the page holds between an edit and the write: paths to set, paths to clear. */
export interface Staged {
  set: Record<string, unknown>;
  clear: string[];
}

/** A staged edit's text, and why it is not a value. */
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
  /**
   * The state words the tracker is actually reporting, so the colour picker
   * offers the vocabulary in front of the operator rather than asking them to
   * spell it. Not a closed list: a state that has left the board is still one you
   * can colour, so the control takes a typed word too.
   */
  states: readonly string[];
  onGroup: (group: string | null) => void;
  onStage: (staged: Staged) => void;
  onReview: () => void;
  onReloaded: () => void;
}): React.JSX.Element {
  // What was *typed*, which is not what is staged: a half-typed number is a draft
  // and never a value, so it cannot reach the write.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const shown = payload.groups.find((entry) => entry.title === group) ?? payload.groups[0];
  const broken = Object.values(drafts).some((draft) => draft.error !== null);
  // Judged over staged ∪ running, so switching the pool provider raises the
  // requirement in the same keystroke rather than at the next boot.
  const unmet = unmetRequirements(payload, staged);

  const edit = (entry: RunningConfigEntry, raw: string): void => {
    const parsed = parseValue(entry, raw);
    setDrafts((held) => ({ ...held, [entry.path]: { raw, error: parsed.error } }));
    if (parsed.error !== null) return;
    const next: Staged = {
      set: { ...staged.set },
      clear: staged.clear.filter((path) => path !== entry.path),
    };
    // Typing a value back to what is running is not an edit. Without this a write
    // carries a key it does not change, and the file grows a line saying what it
    // already said.
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
              <span className="chip small warn">
                {(shown?.entries ?? []).filter((entry) => entry.access === 'advanced').length} keys that can lock you
                out
              </span>
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
                ? // Named, not counted: the row that needs filling in is usually in
                  // a group the operator is no longer looking at — they got here by
                  // changing the key that raised the requirement.
                  `${unmet[0]?.entry.path ?? ''} is needed while ${unmet[0]?.because ?? ''}`
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

/** What has reached the file and is waiting for a restart. */
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
          <span className="cfg-more chip small">no supervisor</span>
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
  /** Another key requires this one, and nothing has filled it in yet. */
  required: boolean;
  onEdit: (raw: string) => void;
  onReset: () => void;
  onUndo: () => void;
}): React.JSX.Element {
  // A field the environment sets, one the file owns alone, and one this build
  // does not declare are all un-editable — for different reasons, each stated on
  // the row rather than left as a control that does nothing.
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
          // Naming the layer rather than saying "default", because with a project
          // config in play those are two different values and only one of them is
          // what clearing leaves behind.
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
    // A value no picker can draw — an array, a number, a hand-edited half-map —
    // is handed back as JSON rather than silently replaced. Losing an operator's
    // typo is worse than showing it to them.
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
  // `text` joins the textarea cases rather than the input one, and is otherwise a
  // plain string all the way down: no parse on the way in, no serialise on the way
  // out. It is here because several sentences in a one-line input is a field an
  // operator cannot read back what they typed into.
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
      // Greyed rather than filled in, for the button's reason: a placeholder is
      // legible as "not yet a value", and a prefilled field reads as one the
      // operator has already answered.
      placeholder={entry.suggestion ?? ''}
      onChange={(e) => onEdit(e.target.value)}
    />
  );
}

/** What a state starts on when it is first given a colour. Neutral, and not grey. */
const NEW_COLOUR = '#7fb3ff';

/**
 * The state → colour control: one swatch per coloured state, and one way to add
 * another.
 *
 * Drawn rather than typed because the value is a *colour*: JSON is the wrong
 * instrument for picking one, and a hex an operator typed is a hex nobody looked
 * at next to the chip it lands on. Each row previews itself in the chip's own
 * shape, so what is picked here is what the backlog draws.
 *
 * The add control is a text input over a `datalist` on purpose. A closed dropdown
 * of the states the tracker is reporting would refuse the one case that most needs
 * colouring — a state no open item is sitting in — and a bare text box would make
 * the operator spell a word the cockpit already knows. This is both.
 */
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
          <i className="tickets-state" style={{ color: colour, borderColor: colour }}>
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

/**
 * The map a colour picker can draw, or null for a value it cannot.
 *
 * Two callers with the same answer and different jobs: {@link Widget} asks so it
 * can fall back to the textarea, and {@link parseValue} asks so a rescued edit is
 * refused rather than written.
 */
function asColourMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [state, colour] of Object.entries(value)) {
    if (!isStateColour(colour)) return null;
    out[state] = colour;
  }
  return out;
}

/** The same, from the row's raw text. Unparseable text is not a map. */
function readColourMap(raw: string): Record<string, string> | null {
  try {
    return asColourMap(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** A key another key requires, which nothing has filled in yet. */
interface Unmet {
  entry: RunningConfigEntry;
  /** The group its row is in, so the save bar can offer a way to it. */
  group: string;
  /** Why it is needed, in the words of the key that raised it. */
  because: string;
}

/**
 * Every declared requirement the staged config does not satisfy.
 *
 * Judged over **staged ∪ running**, which is the whole reason this is here and
 * not on the server: the requirement an operator runs into is the one their edit
 * raises, and the server only ever sees the config the harness booted on. The
 * rule itself is still the server's — `entry.requiredWhen`, declared once in
 * `src/configFields.ts`.
 *
 * A **cleared** path is the one thing this cannot read, because the browser is
 * never told what a default is. So a cleared *raiser* lifts the requirement (it
 * is falling back to a value this side cannot name, and the save is still
 * refused by `loadConfigFromText` if that value keeps it standing), and a cleared
 * *required* key counts as unfilled unless the project layer is setting it.
 */
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

/**
 * The value as text to edit. A list is one entry per line and an object is JSON —
 * both are what an operator would type, and both parse back the same way.
 */
function rawOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join('\n');
  return JSON.stringify(value, null, 2);
}

function render(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

/**
 * Parse what was typed into the value the route will be sent.
 *
 * Stated here as well as on the server, and that is not a second opinion: this
 * one is about the keystroke in front of the operator, and the server's is about
 * anything that reaches the route. The server's is the one that decides.
 */
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
      // The picker only ever writes this shape; the rescue textarea can write
      // anything, and the refusal is what stops it reaching the file.
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

/**
 * A duration's own reading beside the number. Every interval in the config is
 * named `…Ms`, and `21600000` is not a value anyone checks at a glance — which is
 * exactly what somebody opens this to do.
 */
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
