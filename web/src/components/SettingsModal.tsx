import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import type { RunningConfigGroup } from '../types.js';
import { CiPolicyTab } from './CiPolicyTab.js';
import { PromptsTab } from './PromptsTab.js';
import {
  loadNotifyPrefs,
  notifyPermission,
  NOTIFY_CATEGORIES,
  requestNotifyPermission,
  saveNotifyPrefs,
  type NotifyPrefs,
} from '../cockpit/notify.js';

/**
 * Settings: what this harness is running on.
 *
 * **Three tabs since #244.** Everything an operator configures now answers to
 * one cog: the resolved config, the CI policy that decides what a red PR gets,
 * and the prompt book. The last two were reachable only by reading files on the
 * host — `ci.checks` not at all, and the book through a disclosure hanging off
 * the Work panel, which is a place nobody looks for a setting.
 *
 * Each tab fetches its own payload and keeps it: the bodies are mounted lazily
 * on first visit and stay mounted, so switching back is free and no tab pays for
 * a route it never opened.
 *
 * **Fetched on open, never polled** — the prompt book's reason exactly.
 * `loadConfig` runs once at boot, so the answer cannot change while the tab is
 * up and re-sending it with every `/api/state` poll would be paying for a
 * constant.
 *
 * **Read-only**, for the prompt book's reason again: a write route's honest
 * answer to "when does this take effect" is "at the next restart". Changing a
 * value stays an edit to `lubbdubb.config.json` and a restart.
 *
 */
export function SettingsModal({
  control,
  onClose,
}: {
  /** The live dispatch controls, off the snapshot. */
  control: { cap: number; paused: boolean };
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<RunningConfigGroup[] | null>(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<TabId>('settings');
  // Which bodies have ever been shown. A tab is mounted on its first visit and
  // never unmounted, so its fetched-once payload survives a switch away — the
  // alternative re-fetches a constant every time the operator changes tab.
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set<TabId>(['settings']));

  const show = (id: TabId) => {
    setTab(id);
    setVisited((seen) => (seen.has(id) ? seen : new Set([...seen, id])));
  };

  useEffect(() => {
    let live = true;
    void api.getConfig().then((c) => {
      if (live) setGroups(c.groups);
    });
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!groups) return null;
    const needle = filter.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({
        title: g.title,
        entries: g.entries.filter(
          (e) => e.path.toLowerCase().includes(needle) || format(e.path, e.value).toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.entries.length > 0);
  }, [groups, filter]);

  const chosen = groups?.reduce((n, g) => n + g.entries.filter((e) => !e.isDefault).length, 0) ?? 0;

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          <span className="pm-title">Settings</span>
          {tab === 'settings' && groups && <span className="chip small">{chosen} configured</span>}
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>

        {/* Tabs, not a scroll: the three are different questions ("how is it
            configured", "what happens to a red PR", "what do the agents get
            told") and stacking them made the last two unfindable. */}
        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`btn ghost settings-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => show(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {visited.has('ci') && (
          <div hidden={tab !== 'ci'} role="tabpanel">
            <CiPolicyTab />
          </div>
        )}
        {visited.has('prompts') && (
          <div hidden={tab !== 'prompts'} role="tabpanel">
            <PromptsTab />
          </div>
        )}

        <div hidden={tab !== 'settings'} role="tabpanel">
          <div className="settings-section">
            <span className="pm-section-label">Live controls</span>
            {/* The two values the frozen config below would otherwise lie about:
              both are runtime-adjustable and revert to config on restart. Named
              here rather than annotated on their rows so the config block stays
              one honest answer to "what is in the file". */}
            <div className="settings-live">
              <Live
                label="Agent cap"
                live={String(control.cap)}
                configured={configuredValue(groups, 'maxConcurrentAgents')}
                configuredLabel="maxConcurrentAgents"
              />
              <Live
                label="Paused"
                live={String(control.paused)}
                configured={configuredValue(groups, 'startPaused')}
                configuredLabel="startPaused"
              />
            </div>
          </div>

          <NotificationSettings />

          <div className="settings-section">
            <div className="pm-head">
              <span className="pm-section-label">Running config</span>
              <input
                className="settings-filter"
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <p className="muted settings-hint">
              Read-only. Values in <strong>bold</strong> were configured; the rest are built-in defaults. Edit{' '}
              <code>lubbdubb.config.json</code> and restart to change one.
            </p>
            {shown === null && <div className="muted">Loading…</div>}
            {shown !== null && shown.length === 0 && (
              <div className="muted">
                {filter.trim() ? 'Nothing matches that filter.' : 'No config to show — the demo resolves none.'}
              </div>
            )}
            {shown?.map((group) => (
              <div className="settings-group" key={group.title}>
                <span className="settings-group-title">{group.title}</span>
                <table className="settings-table">
                  <tbody>
                    {group.entries.map((entry) => (
                      <tr key={entry.path} className={entry.isDefault ? '' : 'chosen'}>
                        <td className="settings-key">{entry.path}</td>
                        <td className="settings-value">{format(entry.path, entry.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Desktop notifications: the switch, the browser's grant, and the categories.
 *
 * **The only place permission is requested**, because every engine requires a
 * user gesture and refuses a mount-effect ask — silently, on some. So the grant
 * is asked for by a button an operator pressed, and never on load.
 *
 * Unlike everything else on this tab it is *writable*, which is not the
 * inconsistency it looks like: the running config is read-only because its honest
 * answer to "when does this take effect" is "at the next restart", and this
 * answers "now". It is a preference of this browser rather than of the harness —
 * held in `localStorage` beside the token, never sent anywhere — so two people on
 * one deployment can want different things without one of them being wrong.
 */
function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => loadNotifyPrefs());
  const [permission, setPermission] = useState(() => notifyPermission());

  const write = (next: NotifyPrefs) => {
    setPrefs(next);
    saveNotifyPrefs(next);
  };

  const turnOn = async () => {
    const granted = await requestNotifyPermission();
    setPermission(granted);
    // Only claim to be on if the browser actually said yes. Storing `enabled`
    // against a denied grant would leave a switch that reads on and does nothing.
    if (granted === 'granted') write({ ...prefs, enabled: true });
  };

  if (permission === 'unsupported') {
    return (
      <div className="settings-section">
        <span className="pm-section-label">Notifications</span>
        <p className="muted settings-hint">This browser has no Notification API, so the cockpit cannot raise one.</p>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <span className="pm-section-label">Notifications</span>
      <p className="muted settings-hint">
        Raised while the cockpit is open but not in front of you — a backgrounded tab or another window counts, a closed
        one does not. Nothing leaves this machine.
      </p>

      {permission === 'denied' && (
        <p className="muted settings-hint">
          This browser is blocking notifications for the cockpit. Allow them in its site settings; the harness cannot
          ask again once refused.
        </p>
      )}

      {permission === 'granted' ? (
        <>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(e) => write({ ...prefs, enabled: e.target.checked })}
            />
            <span>Notify me</span>
          </label>
          {prefs.enabled &&
            NOTIFY_CATEGORIES.map((cat) => (
              <label className="settings-toggle settings-toggle-child" key={cat.id}>
                <input
                  type="checkbox"
                  checked={prefs.categories[cat.id]}
                  onChange={(e) => write({ ...prefs, categories: { ...prefs.categories, [cat.id]: e.target.checked } })}
                />
                <span>
                  {cat.label} <span className="muted">— {cat.blurb}</span>
                </span>
              </label>
            ))}
        </>
      ) : (
        <button className="btn small" disabled={permission === 'denied'} onClick={() => void turnOn()}>
          Enable notifications
        </button>
      )}
    </div>
  );
}

type TabId = 'settings' | 'ci' | 'prompts';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'ci', label: 'CI policy' },
  { id: 'prompts', label: 'Prompts' },
];

/**
 * What the config says for `path`, read back out of the fetched block rather than
 * off the state snapshot. One source for the pair either way, so the two halves
 * of "live 5, configured 3" can never come from two readings that disagree.
 * Null until the fetch lands — which reads as "nothing to compare against yet".
 */
function configuredValue(groups: RunningConfigGroup[] | null, path: string): string | null {
  for (const group of groups ?? []) {
    const hit = group.entries.find((e) => e.path === path);
    if (hit) return format(hit.path, hit.value);
  }
  return null;
}

function Live({
  label,
  live,
  configured,
  configuredLabel,
}: {
  label: string;
  live: string;
  configured: string | null;
  configuredLabel: string;
}) {
  return (
    <div className="settings-live-row">
      <span className="settings-key">{label}</span>
      <span className="settings-value">
        <strong>{live}</strong>
        {configured !== null && live !== configured && (
          <span className="muted">
            {' '}
            — overriding <code>{configuredLabel}</code> ({configured}) until restart
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Render a config value as one line. Objects and arrays are JSON: they are the
 * leaves the flattener chose not to expand (an ordered rule list, a label→weight
 * map), and their shape is the thing worth reading.
 *
 * A duration carries its own reading beside it. Every interval in the config is
 * named `…Ms` and written in milliseconds, and `21600000` is not a number anyone
 * checks at a glance — which is exactly what somebody opens this to do.
 */
function format(path: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return path.endsWith('Ms') ? `${value} (${humanizeMs(value)})` : String(value);
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function humanizeMs(ms: number): string {
  if (ms === 0) return 'off';
  for (const [unit, size] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ] as const) {
    if (ms >= size) return `${round(ms / size)}${unit}`;
  }
  return `${ms}ms`;
}

/** One decimal, and none when it would read `.0`. */
function round(n: number): string {
  return String(Math.round(n * 10) / 10);
}
