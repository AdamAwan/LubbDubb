import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useThemeUnsaved } from '../hooks.js';
import type { CockpitActions, ConfigTab } from '../cockpit/actions.js';
import type { CockpitView } from '../view/viewModel.js';
import type { ConfigChange, RunningConfigPayload } from '../types.js';
import { CiPolicyTab } from './CiPolicyTab.js';
import { ConfigValues, type Staged } from './ConfigValues.js';
import { McpTab } from './McpTab.js';
import { NotificationSettings } from './NotificationSettings.js';
import { PromptsTab } from './PromptsTab.js';
import { RawConfigTab } from './RawConfigTab.js';
import { ReviewWrite } from './ReviewWrite.js';
import { ThemeSettings } from './ThemeSettings.js';
import { Button } from './button.js';

// → docs/spec/17-cockpit.md

const TABS: readonly { id: ConfigTab; label: string }[] = [
  { id: 'values', label: 'Values' },
  { id: 'raw', label: 'Raw file' },
  { id: 'ci', label: 'CI policy' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'mcp', label: 'MCP' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'theme', label: 'Theme' },
];

function trackerStates(view: CockpitView): string[] {
  const seen = new Set<string>();
  for (const issue of view.state.world.issues) seen.add(issue.workItemState ?? issue.state);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function ConfigPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): React.JSX.Element {
  const [payload, setPayload] = useState<RunningConfigPayload | null>(null);
  const [staged, setStaged] = useState<Staged>({ set: {}, clear: [] });
  const [reviewing, setReviewing] = useState(false);
  const [saved, setSaved] = useState<readonly ConfigChange[] | null>(null);
  const themeEdit = useThemeUnsaved();

  const load = (): void => {
    void api.getConfig().then((next) => {
      setPayload(next);
      setStaged({ set: {}, clear: [] });
      setReviewing(false);
    });
  };
  useEffect(load, []);

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
            {/* The team's file, named here rather than only on the rows it sets:
                an operator whose harness is behaving unlike their config says has
                to be able to see that a second file is in play at all. */}
            {payload.projectFile !== null && (
              <>
                {' · under '}
                <b>{payload.projectFile}</b>
              </>
            )}
          </span>
        </div>
        <div className="cfg-headacts">
          <Button ghost size="small" onClick={load}>
            Reload from disk
          </Button>
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
            {/* A dot rather than a count: what the theme is holding is one pending
                edit, however many tokens it moved. It is what the cog's dot leads
                to (issue #680). */}
            {entry.id === 'theme' && themeEdit && (
              <i className="cfg-tabn" title="An unsaved theme edit is pending">
                &#9679;
              </i>
            )}
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
              states={trackerStates(view)}
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
          {tab === 'mcp' && <McpTab />}
          {tab === 'notifications' && <NotificationSettings />}
          {tab === 'theme' && <ThemeSettings />}
        </>
      )}
    </div>
  );
}
