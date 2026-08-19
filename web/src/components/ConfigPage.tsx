import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { CockpitActions, ConfigTab } from '../cockpit/actions.js';
import type { CockpitView } from '../view/viewModel.js';
import type { ConfigChange, RunningConfigPayload } from '../types.js';
import { CiPolicyTab } from './CiPolicyTab.js';
import { ConfigValues, type Staged } from './ConfigValues.js';
import { NotificationSettings } from './NotificationSettings.js';
import { PromptsTab } from './PromptsTab.js';
import { RawConfigTab } from './RawConfigTab.js';
import { ReviewWrite } from './ReviewWrite.js';
import { ThemeSettings } from './ThemeSettings.js';

/**
 * Configuration, as a surface rather than a modal.
 *
 * It was a modal with three tabs, opened from the top bar, until the page it had
 * outgrown was drawn: fifty keys, five sections and a file to reconcile against
 * is a thing you work in, and a modal is a thing you glance at and dismiss. The
 * decisive argument is smaller than that, though — a modal cannot be linked to.
 * "Look at what `agentMode` is set to on the box" is a URL now.
 *
 * Everything that says *where you are* lives on `Place` (`cockpit/place.ts`) and
 * nothing lives in a `useState` here: the section, and the group it is showing.
 * A surface held outside the address bar compiles, renders and works until the
 * back button steps over it or a reload drops it, and neither is a thing
 * `npm run check` can see.
 *
 * What is **not** here is a second store. Every section reads and writes
 * `lubbdubb.config.json`; the file stays the source of truth, and an edit made in
 * an editor lands on the same apply path these do.
 *
 * → `docs/spec/17-cockpit.md#configuration`
 */
const TABS: readonly { id: ConfigTab; label: string }[] = [
  { id: 'values', label: 'Values' },
  { id: 'raw', label: 'Raw file' },
  { id: 'ci', label: 'CI policy' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'theme', label: 'Theme' },
];

export function ConfigPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): React.JSX.Element {
  const [payload, setPayload] = useState<RunningConfigPayload | null>(null);
  const [staged, setStaged] = useState<Staged>({ set: {}, clear: [] });
  // The review step, once the operator has asked to see what the write would do.
  // Held here rather than on `Place` deliberately: it is a step inside an
  // unsaved edit, and a URL that restored it would restore a review of changes
  // the reload has already dropped.
  const [reviewing, setReviewing] = useState(false);
  const [saved, setSaved] = useState<readonly ConfigChange[] | null>(null);

  const load = (): void => {
    void api.getConfig().then((next) => {
      setPayload(next);
      setStaged({ set: {}, clear: [] });
      setReviewing(false);
    });
  };
  useEffect(load, []);

  // The file moved — a save from another cockpit, or the watcher picking up an
  // edit on disk. Re-read rather than patch: the payload is what `/api/config`
  // answers, and half of it applied here would be a second opinion about it.
  useEffect(() => {
    const onChanged = (): void => load();
    window.addEventListener('lubbdubb:config-changed', onChanged);
    return () => window.removeEventListener('lubbdubb:config-changed', onChanged);
  }, []);

  const tab = view.configTab;
  const go = (id: ConfigTab): void => actions.openConfig({ configTab: id });

  if (!payload) return <div className="cfg muted">Loading…</div>;

  const dirty = Object.keys(staged.set).length + staged.clear.length;

  return (
    <div className="cfg">
      <div className="cfg-head">
        <div>
          <h1 className="cfg-title">Config</h1>
          <span className="cfg-where">
            <b>{payload.file}</b> · read at boot
          </span>
        </div>
        <div className="cfg-headacts">
          <button className="btn ghost small" onClick={load}>
            Reload from disk
          </button>
        </div>
      </div>

      <div className="cfg-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className={`cfg-tab${tab === entry.id ? ' on' : ''}`}
            onClick={() => go(entry.id)}
          >
            {entry.label}
            {entry.id === 'values' && dirty > 0 && <i className="cfg-tabn">{dirty}</i>}
          </button>
        ))}
      </div>

      {reviewing ? (
        <ReviewWrite
          payload={payload}
          staged={staged}
          onCancel={() => setReviewing(false)}
          onWrote={(changes) => {
            setSaved(changes);
            load();
          }}
        />
      ) : (
        <>
          {tab === 'values' && (
            <ConfigValues
              payload={payload}
              staged={staged}
              saved={saved}
              group={view.configGroup}
              control={view.state.control}
              onGroup={(group) => actions.openConfig({ configGroup: group })}
              onStage={(next) => {
                setSaved(null);
                setStaged(next);
              }}
              onReview={() => setReviewing(true)}
              onReloaded={load}
            />
          )}
          {tab === 'raw' && <RawConfigTab payload={payload} onWrote={load} />}
          {tab === 'ci' && <CiPolicyTab />}
          {tab === 'prompts' && <PromptsTab />}
          {tab === 'notifications' && <NotificationSettings />}
          {tab === 'theme' && <ThemeSettings />}
        </>
      )}
    </div>
  );
}
