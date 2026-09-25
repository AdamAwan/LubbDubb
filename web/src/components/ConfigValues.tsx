import { useState } from 'react';
import { api } from '../api.js';
import type { ConfigChange, RunningConfigEntry, RunningConfigGroup, RunningConfigPayload } from '../types.js';
import { Panel } from './panel.js';
import { Button } from './button.js';
import { Tag } from './tag.js';
import { Row, type Draft } from './ConfigRow.js';
import { chosenIn, configured, parseValue, render, stagedFor, unmetRequirements, type Unmet } from './configEntries.js';

// → docs/spec/17-cockpit.md

export interface Staged {
  set: Record<string, unknown>;
  clear: string[];
}

interface ConfigValuesProps {
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
}: ConfigValuesProps): React.JSX.Element {
  const drafting = useDrafts(staged, onStage);
  const [advanced, setAdvanced] = useState(false);
  const { busy, refusal, restart } = useRestart();

  const shown = payload.groups.find((entry) => entry.title === group) ?? payload.groups[0];
  const broken = Object.values(drafting.drafts).some((draft) => draft.error !== null);
  const unmet = unmetRequirements(payload, staged);
  const dirty = Object.keys(staged.set).length + staged.clear.length;
  const entries = shown?.entries ?? [];
  const rows = (access: (entry: RunningConfigEntry) => boolean): React.JSX.Element => (
    <RowList entries={entries.filter(access)} drafting={drafting} staged={staged} states={states} unmet={unmet} />
  );

  return (
    <div className="cfg-body">
      <GroupRail groups={payload.groups} shown={shown} onGroup={onGroup} />

      <div className="cfg-main">
        {payload.pending.length > 0 && (
          <PendingCard
            pending={payload.pending}
            canRestart={payload.canRestart}
            busy={busy}
            onRestart={(interrupt) => void restart(interrupt)}
          />
        )}

        {saved && saved.length > 0 && <SavedNote saved={saved} file={payload.file} />}

        <GroupCard payload={payload} shown={shown} dirty={dirty}>
          {rows((entry) => entry.access !== 'advanced')}
        </GroupCard>

        {entries.some((entry) => entry.access === 'advanced') && (
          <AdvancedCard
            count={entries.filter((entry) => entry.access === 'advanced').length}
            open={advanced}
            onToggle={() => setAdvanced(!advanced)}
          >
            {rows((entry) => entry.access === 'advanced')}
          </AdvancedCard>
        )}

        <LiveCard payload={payload} control={control} />

        {refusal && <p className="cfg-refusal">{refusal}</p>}
      </div>

      {dirty > 0 && (
        <DirtyBar
          dirty={dirty}
          broken={broken}
          unmet={unmet}
          file={payload.file}
          shownTitle={shown?.title}
          onGroup={onGroup}
          onDiscard={() => {
            drafting.discard();
            onReloaded();
          }}
          onReview={onReview}
        />
      )}
    </div>
  );
}

function RowList({
  entries,
  drafting,
  staged,
  states,
  unmet,
}: {
  entries: readonly RunningConfigEntry[];
  drafting: ReturnType<typeof useDrafts>;
  staged: Staged;
  states: readonly string[];
  unmet: readonly Unmet[];
}): React.JSX.Element {
  const { drafts, edit, reset, undo } = drafting;
  return (
    <>
      {entries.map((entry) => (
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
  );
}

function useDrafts(staged: Staged, onStage: (staged: Staged) => void) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

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

  const discard = (): void => {
    setDrafts({});
    onStage({ set: {}, clear: [] });
  };

  return { drafts, edit, reset, undo, discard };
}

function useRestart() {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
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
  return { busy, refusal, restart };
}

function GroupRail({
  groups,
  shown,
  onGroup,
}: {
  groups: readonly RunningConfigGroup[];
  shown: RunningConfigGroup | undefined;
  onGroup: (group: string | null) => void;
}): React.JSX.Element {
  return (
    <aside className="cfg-rail">
      <div className="cfg-railhead">Groups</div>
      {groups.map((entry) => (
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
  );
}

function GroupCard({
  payload,
  shown,
  dirty,
  children,
}: {
  payload: RunningConfigPayload;
  shown: RunningConfigGroup | undefined;
  dirty: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Panel density="flush" className="cfg-card">
      <h3>
        {shown?.title ?? 'Config'}
        <span className="cfg-more">
          {chosenIn(shown)} of {shown?.entries.length ?? 0} configured
          {dirty > 0 ? ` · ${dirty} staged` : ''}
        </span>
      </h3>
      <p className="cfg-hint">
        Editing a row stages a change to <code>{payload.file}</code> — nothing else stores it. A value in <b>bold</b> is
        one the file sets; the rest are inherited, shown as they resolve.
        {payload.projectFile !== null && (
          <>
            {' '}
            Rows marked <span className="cfg-src project">project</span> come from <code>{payload.projectFile}</code>,
            which your team commits — saving here overrides one for you alone.
          </>
        )}
      </p>
      {children}
    </Panel>
  );
}

function SavedNote({ saved, file }: { saved: readonly ConfigChange[]; file: string }): React.JSX.Element {
  return (
    <p className="cfg-saved">
      Written to <code>{file}</code>. {saved.filter((change) => change.applied).length} applied now,{' '}
      {saved.filter((change) => !change.applied).length} waiting for a restart.
    </p>
  );
}

function AdvancedCard({
  count,
  open,
  onToggle,
  children,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Panel density="flush" className="cfg-card">
      <button className="cfg-advhead" onClick={onToggle} aria-expanded={open}>
        <span className="muted">{open ? '▾' : '▸'}</span> Advanced
        <Tag tone="amber">{count} keys that can lock you out</Tag>
      </button>
      {open && (
        <>
          <p className="cfg-advwarn">
            These decide where the fleet works and how you reach this cockpit. Every one of them is read once, at boot,
            and a wrong value here is one you fix in the file rather than in here.
          </p>
          {children}
        </>
      )}
    </Panel>
  );
}

/* The two values a config block on its own would lie about: both are
   runtime-adjustable through the fleet control and revert to the file on
   restart. Drawn from the same fetch as the rows above, so the two halves
   of "live 5, configured 3" can never come from readings that disagree. */
function LiveCard({
  payload,
  control,
}: {
  payload: RunningConfigPayload;
  control: { cap: number; paused: boolean };
}): React.JSX.Element {
  return (
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
  );
}

function DirtyBar({
  dirty,
  broken,
  unmet,
  file,
  shownTitle,
  onGroup,
  onDiscard,
  onReview,
}: {
  dirty: number;
  broken: boolean;
  unmet: readonly Unmet[];
  file: string;
  shownTitle: string | undefined;
  onGroup: (group: string | null) => void;
  onDiscard: () => void;
  onReview: () => void;
}): React.JSX.Element {
  return (
    <div className="cfg-dirty">
      <span className="cfg-dirtyn">{dirty} staged</span>
      <span className="cfg-dirtywhat">
        {broken
          ? 'one of them is not a value this field takes'
          : unmet.length > 0
            ? `${unmet[0]?.entry.path ?? ''} is needed while ${unmet[0]?.because ?? ''}`
            : `nothing has been written to ${file} yet`}
      </span>
      <div className="cfg-dirtyacts">
        {unmet.length > 0 && unmet[0] && unmet[0].group !== shownTitle && (
          <Button ghost size="small" onClick={() => onGroup(unmet[0]?.group ?? null)}>
            Show it
          </Button>
        )}
        <Button ghost size="small" onClick={onDiscard}>
          Discard all
        </Button>
        <Button tone="primary" size="small" disabled={broken || unmet.length > 0} onClick={onReview}>
          Review &amp; write
        </Button>
      </div>
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
