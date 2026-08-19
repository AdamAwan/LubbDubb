import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import type { ConfigChange, RunningConfigEntry, RunningConfigPayload } from '../types.js';

/**
 * The config, edited.
 *
 * The cockpit drew every setting and could change none of them, so every knob in
 * a fifty-key surface was a trip to a text editor and a restart (#401). What this
 * is *not* is a second place configuration lives: every control writes
 * `lubbdubb.config.json`, the file stays the source of truth, and an edit made in
 * an editor lands on the same apply path this does.
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
 * → `docs/spec/17-cockpit.md#configuration`
 */

/** A staged edit: what was typed, what it parses to, and why it does not. */
interface Draft {
  raw: string;
  value: unknown;
  error: string | null;
}

export function ConfigForm({ control }: { control: { cap: number; paused: boolean } }): React.JSX.Element {
  const [payload, setPayload] = useState<RunningConfigPayload | null>(null);
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const [cleared, setCleared] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState<readonly ConfigChange[] | null>(null);

  const load = (): void => {
    void api.getConfig().then((next) => {
      setPayload(next);
      setEdits({});
      setCleared(new Set());
    });
  };
  useEffect(load, []);

  const dirty = Object.keys(edits).length + cleared.size;
  const broken = Object.values(edits).some((draft) => draft.error !== null);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!payload) return null;
    if (!needle) return payload.groups;
    return payload.groups
      .map((group) => ({
        title: group.title,
        entries: group.entries.filter(
          (entry) => entry.path.toLowerCase().includes(needle) || entry.why.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.entries.length > 0);
  }, [payload, filter]);

  const edit = (entry: RunningConfigEntry, raw: string): void => {
    setSaved(null);
    setEdits((held) => {
      const draft = parseDraft(entry, raw);
      // Typing a value back to what is running is not an edit. Without this a
      // save carries a key it does not change, and the file grows a line saying
      // what the default already said.
      if (draft.error === null && JSON.stringify(draft.value) === JSON.stringify(entry.value)) {
        const { [entry.path]: _dropped, ...rest } = held;
        return rest;
      }
      return { ...held, [entry.path]: draft };
    });
  };

  const reset = (path: string): void => {
    setSaved(null);
    setEdits((held) => {
      const { [path]: _dropped, ...rest } = held;
      return rest;
    });
    setCleared((held) => new Set([...held, path]));
  };

  const undo = (path: string): void => {
    setSaved(null);
    setEdits((held) => {
      const { [path]: _dropped, ...rest } = held;
      return rest;
    });
    setCleared((held) => new Set([...held].filter((entry) => entry !== path)));
  };

  const save = async (): Promise<void> => {
    if (!payload) return;
    setBusy(true);
    setRefusal(null);
    try {
      const set: Record<string, unknown> = {};
      for (const [path, draft] of Object.entries(edits)) {
        if (!cleared.has(path) && draft.error === null) set[path] = draft.value;
      }
      const result = await api.saveConfig({ set, clear: [...cleared], baseline: payload.revision });
      setSaved(result.changes);
      load();
    } catch (err) {
      setRefusal((err as Error).message);
    } finally {
      setBusy(false);
    }
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

  if (!payload || !groups) return <div className="muted">Loading…</div>;

  const plain = groups.map((group) => ({
    title: group.title,
    entries: group.entries.filter((entry) => entry.access !== 'advanced'),
  }));
  const guarded = groups
    .map((group) => ({ title: group.title, entries: group.entries.filter((entry) => entry.access === 'advanced') }))
    .filter((group) => group.entries.length > 0);
  const guardedCount = guarded.reduce((count, group) => count + group.entries.length, 0);

  const row = (entry: RunningConfigEntry): React.JSX.Element => (
    <ConfigRow
      key={entry.path}
      entry={entry}
      draft={edits[entry.path]}
      cleared={cleared.has(entry.path)}
      onEdit={(raw) => edit(entry, raw)}
      onReset={() => reset(entry.path)}
      onUndo={() => undo(entry.path)}
    />
  );

  return (
    <div className="settings-section">
      <div className="pm-head">
        <span className="pm-section-label">Configuration</span>
        <input
          className="settings-filter"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <p className="muted settings-hint">
        Saving writes <code>{payload.file}</code>, which stays the source of truth — editing it by hand does the same
        thing this does. Values in <strong>bold</strong> were configured; the rest are built-in defaults, and a reset
        clears the key rather than writing the default back.
      </p>

      {/* The two values a config block on its own would lie about: both are
          runtime-adjustable through the fleet control and revert to the file on
          restart. Drawn from the same fetch as the rows below, so the two halves
          of "live 5, configured 3" can never come from readings that disagree. */}
      <div className="settings-live">
        <Live label="Agent cap" live={String(control.cap)} configured={valueAt(payload, 'maxConcurrentAgents')} />
        <Live label="Paused" live={String(control.paused)} configured={valueAt(payload, 'startPaused')} />
      </div>

      {payload.pending.length > 0 && (
        <PendingBlock
          pending={payload.pending}
          canRestart={payload.canRestart}
          busy={busy}
          onRestart={(interrupt) => void restart(interrupt)}
        />
      )}

      {saved && saved.length > 0 && (
        <p className="settings-saved">
          Saved. {saved.filter((change) => change.applied).length} applied now,{' '}
          {saved.filter((change) => !change.applied).length} waiting for a restart.
        </p>
      )}

      {plain.map((group) =>
        group.entries.length === 0 ? null : (
          <div className="settings-group" key={group.title}>
            <span className="settings-group-title">{group.title}</span>
            {group.entries.map(row)}
          </div>
        ),
      )}

      {guardedCount > 0 && (
        <div className="settings-advanced">
          <button className="settings-advanced-head" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
            <span className="muted">{advanced ? '▾' : '▸'}</span> Advanced — paths, server and the agent command
            <span className="chip small warn">{guardedCount} keys that can lock you out</span>
          </button>
          {advanced && (
            <>
              <p className="settings-advanced-warn">
                These decide where the fleet works and how you reach this cockpit. Every one of them is read once, at
                boot, and a wrong value here is one you fix in the file rather than in here.
              </p>
              {guarded.map((group) => (
                <div className="settings-group" key={group.title}>
                  <span className="settings-group-title">{group.title}</span>
                  {group.entries.map(row)}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {refusal && <p className="settings-refusal">{refusal}</p>}

      {dirty > 0 && (
        <div className="settings-savebar">
          <span className="settings-dirty">{dirty} unsaved</span>
          <span className="muted">
            {broken ? 'one of them is not a value this field takes' : 'nothing has been written to the file yet'}
          </span>
          <span className="settings-savebar-acts">
            <button
              className="btn ghost small"
              disabled={busy}
              onClick={() => {
                setEdits({});
                setCleared(new Set());
                setRefusal(null);
              }}
            >
              Discard
            </button>
            <button className="btn primary small" disabled={busy || broken} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** What the file says for `path`, for the live-vs-configured pair. */
function valueAt(payload: RunningConfigPayload, path: string): string | null {
  for (const group of payload.groups) {
    const hit = group.entries.find((entry) => entry.path === path);
    if (hit) return rawOf(hit.value);
  }
  return null;
}

/**
 * A live control beside what the file says, and only when they differ — the
 * divergence is the whole point, and a row that always restated the same number
 * twice would bury the times it does not.
 */
function Live({
  label,
  live,
  configured,
}: {
  label: string;
  live: string;
  configured: string | null;
}): React.JSX.Element {
  return (
    <div className="settings-live-row">
      <span className="settings-key">{label}</span>
      <span className="settings-value">
        <strong>{live}</strong>
        {configured !== null && live !== configured && (
          <span className="muted"> — overriding the configured {configured} until restart</span>
        )}
      </span>
    </div>
  );
}

/**
 * What has reached the file and is waiting for a restart — the same list a hand
 * edit produces, since both go through one apply path.
 *
 * The restart is offered only where this process has somewhere to hand off to.
 * Where it does not, the reason is drawn rather than the button: a control that
 * would stop the harness and not bring it back is worse than none.
 */
function PendingBlock({
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
    <div className="settings-pending">
      <div className="pm-head">
        <span className="pm-section-label" style={{ marginBottom: 0 }}>
          Waiting for a restart
        </span>
        {canRestart ? (
          <span className="settings-savebar-acts">
            <label className="settings-toggle" style={{ padding: 0 }}>
              <input type="checkbox" checked={interrupt} onChange={(e) => setInterrupt(e.target.checked)} />
              <span className="muted">stop running agents</span>
            </label>
            <button className="btn small" disabled={busy} onClick={() => onRestart(interrupt)}>
              Apply and restart
            </button>
          </span>
        ) : (
          <span className="chip small">no supervisor</span>
        )}
      </div>
      {pending.map((change) => (
        <div className="settings-pending-row" key={change.path}>
          <span className="settings-key">{change.path}</span>
          <span className="settings-value">
            {render(change.from)} → <strong>{render(change.to)}</strong>
          </span>
        </div>
      ))}
      {!canRestart && (
        <p className="muted settings-hint" style={{ marginBottom: 0 }}>
          This harness was not started by the supervisor, so nothing here can restart it. Restart it the way you started
          it — these are what it will come back on.
        </p>
      )}
    </div>
  );
}

function ConfigRow({
  entry,
  draft,
  cleared,
  onEdit,
  onReset,
  onUndo,
}: {
  entry: RunningConfigEntry;
  draft: Draft | undefined;
  cleared: boolean;
  onEdit: (raw: string) => void;
  onReset: () => void;
  onUndo: () => void;
}): React.JSX.Element {
  // A field the environment sets, one the file owns alone, and one this build does
  // not declare are all un-editable — for different reasons, each stated on the row
  // rather than left as a control that does nothing.
  const locked = entry.env !== null || entry.access === 'fileOnly';
  const staged = draft !== undefined || cleared;
  const raw = draft?.raw ?? rawOf(entry.value);

  return (
    <div className={`settings-field${entry.isDefault ? '' : ' chosen'}${staged ? ' staged' : ''}`}>
      <div className="settings-key">
        {entry.path}
        <span className="settings-why">{entry.why}</span>
      </div>

      <div className="settings-control">
        {cleared ? (
          <span className="muted">will fall back to its default</span>
        ) : (
          <Widget entry={entry} raw={raw} locked={locked} onEdit={onEdit} />
        )}
        {draft?.error && <span className="settings-refusal-inline">{draft.error}</span>}
        {entry.ms && draft?.error == null && !cleared && typeof numberOf(raw) === 'number' && (
          <span className="settings-unit">{humanizeMs(numberOf(raw) as number)}</span>
        )}
      </div>

      <div className="settings-meta">
        {entry.env !== null ? (
          <span className="chip small warn">env {entry.env}</span>
        ) : entry.isDefault ? (
          <span className="chip small">default</span>
        ) : (
          <span className="chip small info">file</span>
        )}
        <span className={`settings-when${entry.live ? ' now' : ''}`}>
          {entry.access === 'fileOnly' ? 'file only' : entry.live ? 'applies now' : 'needs restart'}
        </span>
      </div>

      <div className="settings-act">
        {staged ? (
          <button className="btn ghost small" onClick={onUndo}>
            Undo
          </button>
        ) : (
          !entry.isDefault &&
          !locked && (
            <button className="btn ghost small" onClick={onReset}>
              Reset
            </button>
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
  onEdit,
}: {
  entry: RunningConfigEntry;
  raw: string;
  locked: boolean;
  onEdit: (raw: string) => void;
}): React.JSX.Element {
  if (locked) return <input className="settings-input locked" value={raw} readOnly />;
  if (entry.type === 'boolean') {
    return (
      <label className="settings-toggle" style={{ padding: 0 }}>
        <input type="checkbox" checked={raw === 'true'} onChange={(e) => onEdit(String(e.target.checked))} />
        <span className="muted">{raw}</span>
      </label>
    );
  }
  if (entry.type === 'enum') {
    return (
      <select className="settings-input" value={raw} onChange={(e) => onEdit(e.target.value)}>
        {(entry.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (entry.type === 'stringList' || entry.type === 'json') {
    return (
      <textarea
        className="settings-input settings-input-tall"
        value={raw}
        rows={entry.type === 'json' ? 4 : 3}
        onChange={(e) => onEdit(e.target.value)}
      />
    );
  }
  return (
    <input
      className="settings-input"
      inputMode={entry.type === 'number' ? 'numeric' : 'text'}
      value={raw}
      onChange={(e) => onEdit(e.target.value)}
    />
  );
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

/** One line, for the pending list. */
function render(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

function numberOf(raw: string): number | null {
  const parsed = Number(raw);
  return raw.trim() !== '' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse what was typed into the value the route will be sent.
 *
 * The refusal is stated here as well as on the server, and that is not a second
 * opinion: this one is about the keystroke in front of the operator, and the
 * server's is about anything that reaches the route. The server's is the one that
 * decides.
 */
function parseDraft(entry: RunningConfigEntry, raw: string): Draft {
  switch (entry.type) {
    case 'number': {
      const parsed = numberOf(raw);
      return { raw, value: parsed, error: parsed === null ? 'not a number' : null };
    }
    case 'boolean':
      return { raw, value: raw === 'true', error: null };
    case 'enum':
      return {
        raw,
        value: raw,
        error: (entry.options ?? []).includes(raw) ? null : `not one of ${(entry.options ?? []).join(', ')}`,
      };
    case 'stringList':
      return {
        raw,
        value: raw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
        error: null,
      };
    case 'json':
      try {
        return { raw, value: JSON.parse(raw), error: null };
      } catch (err) {
        return { raw, value: null, error: (err as Error).message };
      }
    default:
      return { raw, value: raw, error: null };
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
