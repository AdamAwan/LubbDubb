import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { SkinPicker } from '../skins/SkinPicker.js';
import type { RunningConfigGroup } from '../types.js';

/**
 * Settings: what this harness is running on, and how the cockpit looks.
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
 * The skin picker lives here rather than in each skin's chrome so there is one
 * place an operator looks for a preference, and the cog that opens this is what
 * each skin now embeds — so the picker is still reachable from every skin, which
 * is the property that stops a half-built skin being one you cannot escape.
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
          {groups && <span className="chip small">{chosen} configured</span>}
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>

        <div className="settings-section">
          <span className="pm-section-label">Appearance</span>
          <SkinPicker />
        </div>

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
  );
}

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
