import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { McpChannelPayload } from '../types.js';
import { Panel } from './panel.js';
import { Button } from './button.js';
import { PluginStep, usePluginStatus } from './PluginStep.js';

// → docs/spec/17-cockpit.md

export function McpTab() {
  const [mcp, setMcp] = useState<McpChannelPayload | null>(null);
  const skills = usePluginStatus()?.skills ?? [];

  useEffect(() => {
    let live = true;
    void api.getMcp().then((next) => {
      if (live) setMcp(next);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!mcp) return <div className="muted">Loading…</div>;

  return (
    <div className="mcp">
      <p className="muted settings-hint">
        The harness ships a Claude Code plugin for the Claude Code <em>you</em> drive. It carries the{' '}
        <code>/lubbdubb:…</code> skills every <b>Open in Claude Code</b> link calls, the desktop tool channel those
        skills talk to, and a notice board above your prompt that says what the harness is waiting on you for.
      </p>

      {!mcp.running && (
        <p className="empty mcp-down">
          The desktop channel is not listening, so the plugin&apos;s tools would reach nothing. The commonest cause is
          another LubbDubb already holding the socket — the boot log and the Faults panel name which.
        </p>
      )}

      <PluginStep />

      <Panel density="flush" className="cfg-card mcp-step">
        <h3>
          <span className="mcp-n">2</span> Ask for something
        </h3>
        <p className="cfg-hint">One skill per job, each namespaced under the plugin:</p>
        <Command text="/lubbdubb:check 284:C" />
        <p className="cfg-hint mcp-foot">
          <code>284:C</code> is goal 284, check C. The others are{' '}
          {skills
            .filter((s) => s !== 'check')
            .map((s, i, all) => (
              <span key={s}>
                <code>{s}</code>
                {i === all.length - 1 ? '' : i === all.length - 2 ? ' and ' : ', '}
              </span>
            ))}{' '}
          — and a question asked in plain words finds the right one by itself. The tool channel reads its credential
          from <code>{mcp.credentialPath || '(nowhere yet)'}</code> (mode <code>0600</code>), reminted at every start,
          so a restarted harness needs no reinstall.
        </p>
      </Panel>

      <McpToolsStep tools={mcp.tools} />
    </div>
  );
}

function McpToolsStep({ tools }: { tools: McpChannelPayload['tools'] }) {
  return (
    <Panel density="flush" className="cfg-card mcp-step">
      <h3>
        <span className="mcp-n">3</span> What it can do
      </h3>
      <p className="cfg-hint">
        These three, and nothing else. The credential is long-lived and sits in your home directory, so the narrowing is
        structural rather than a filter — there is no code path from this channel to the tools the fleet gets.
      </p>
      {tools.length === 0 ? (
        <p className="cfg-hint mcp-foot">No tools to list — this cockpit is running against the demo backend.</p>
      ) : (
        <ul className="mcp-tools">
          {tools.map((tool) => (
            <li key={tool.name}>
              <code className="mcp-tool">{tool.name}</code>
              <span className="muted">{tool.description}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mcp-cmd">
      <code>{text}</code>
      <Button
        ghost
        size="small"
        usage="config.copy"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
