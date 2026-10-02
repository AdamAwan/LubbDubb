import { useEffect, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { PluginInstallPayload, PluginStatusPayload } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Panel } from './panel.js';

// → docs/spec/17-cockpit.md#the-plugin

/* One reading for every surface that draws it: each read spawns `claude plugin list`
   on the harness, and the band must drop the moment the tab's button lands. */
let shared: PluginStatusPayload | null = null;
let asked: Promise<void> | null = null;
const listeners = new Set<(status: PluginStatusPayload) => void>();

function publish(status: PluginStatusPayload): void {
  shared = status;
  for (const listener of listeners) listener(status);
}

export function usePluginStatus(): PluginStatusPayload | null {
  const [status, setStatus] = useState(shared);
  useEffect(() => {
    listeners.add(setStatus);
    asked ??= api.getPlugin().then(publish, () => {
      asked = null;
    });
    return () => {
      listeners.delete(setStatus);
    };
  }, []);
  return status;
}

export function PluginStep(): JSX.Element {
  const status = usePluginStatus();
  const [result, setResult] = useState<PluginInstallPayload | null>(null);

  const install = async (): Promise<void> => {
    const next = await api.installPlugin();
    setResult(next);
    publish(next.status);
  };

  return (
    <Panel density="flush" className="cfg-card mcp-step">
      <h3>
        <span className="mcp-n">1</span> Install the plugin
      </h3>
      <p className="cfg-hint">{status === null ? 'Asking Claude Code what it has installed…' : describe(status)}</p>
      {status !== null && (status.state === 'missing' || status.state === 'stale') && (
        <div className="mcp-cmd">
          <AsyncButton size="small" usage="config.accept" pendingLabel="Installing…" onClick={install}>
            {status.state === 'stale' ? 'Update' : 'Install'}
          </AsyncButton>
        </div>
      )}
      {result !== null && (
        <ul className="plugin-steps">
          {result.steps.map((step) => (
            <li key={step.label} className={step.ok ? 'plugin-step-ok' : 'plugin-step-failed'}>
              {step.ok ? '✓' : '✗'} {step.label}
              {step.detail !== null && <span className="muted"> — {step.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="cfg-hint mcp-foot">
        The click runs <code>claude plugin marketplace add</code> and <code>claude plugin install</code> at user scope,
        then removes the hand-registered <code>lubbdubb</code> MCP server and the old <code>/lubbdubb</code> skill if
        either is still there. Sessions already open pick the plugin up when they restart.
        {status?.bundle && (
          <>
            {' '}
            It is written to <code>{status.bundle.marketplaceDir}</code> at every start.
          </>
        )}
      </p>
    </Panel>
  );
}

function describe(status: PluginStatusPayload): string {
  switch (status.state) {
    case 'current':
      return `Installed, and up to date (${status.installed}).`;
    case 'stale':
      return `Installed, but this harness has a newer build of it (${status.installed} installed, ${status.bundle?.version ?? ''} here).`;
    case 'missing':
      return status.legacySkill
        ? 'Not installed. You have the old /lubbdubb skill, which the cockpit’s links no longer call.'
        : 'Not installed — every Open in Claude Code link needs it.';
    case 'unknown':
      return `Could not tell whether it is installed: ${status.reason}.`;
  }
}
