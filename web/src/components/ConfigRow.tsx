import { useState } from 'react';
import { isStateColour } from '../stateColour.js';
import { ColourField } from './ColourField.js';
import type { RunningConfigEntry } from '../types.js';
import { Button } from './button.js';
import { rawOf, readColourMap } from './configEntries.js';

export interface Draft {
  raw: string;
  error: string | null;
}

export function Row({
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

      <RowInput
        entry={entry}
        draft={draft}
        staged={staged}
        states={states}
        required={required}
        raw={raw}
        locked={locked}
        onEdit={onEdit}
      />

      <RowSource entry={entry} />

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

function RowInput({
  entry,
  draft,
  staged,
  states,
  required,
  raw,
  locked,
  onEdit,
}: {
  entry: RunningConfigEntry;
  draft: Draft | undefined;
  staged: 'set' | 'cleared' | null;
  states: readonly string[];
  required: boolean;
  raw: string;
  locked: boolean;
  onEdit: (raw: string) => void;
}): React.JSX.Element {
  return (
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
      <RowNotes entry={entry} draft={draft} staged={staged} required={required} raw={raw} />
    </div>
  );
}

function RowNotes({
  entry,
  draft,
  staged,
  required,
  raw,
}: {
  entry: RunningConfigEntry;
  draft: Draft | undefined;
  staged: 'set' | 'cleared' | null;
  required: boolean;
  raw: string;
}): React.JSX.Element {
  return (
    <>
      {required && (
        <span className="cfg-bad">
          {entry.requiredWhen?.path} is not “{entry.requiredWhen?.unless}”, so this one has to be set
        </span>
      )}
      {draft?.error && <span className="cfg-bad">{draft.error}</span>}
      {entry.ms && !draft?.error && staged !== 'cleared' && Number.isFinite(Number(raw)) && (
        <span className="cfg-unit">{humanizeMs(Number(raw))}</span>
      )}
    </>
  );
}

function RowSource({ entry }: { entry: RunningConfigEntry }): React.JSX.Element {
  return (
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
        {entry.access === 'fileOnly' ? 'file only' : entry.env !== null ? 'locked' : entry.live ? 'now' : 'at restart'}
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
