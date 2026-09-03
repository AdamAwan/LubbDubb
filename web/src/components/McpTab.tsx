import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { McpChannelPayload } from '../types.js';
import { Panel } from './panel.js';
import { Button } from './button.js';

/**
 * How to point the operator's **own** Claude Code at this harness.
 *
 * The desktop channel is unconditional — every start binds the stable socket,
 * mints the credential and rewrites the `/lubbdubb` skill — but the one thing an
 * operator has to do by hand, exactly once, is register the bridge with
 * `claude mcp add`. Until #244's config page grew this tab that command existed in
 * two places, neither of which is where somebody looks for it: a boot line that
 * has scrolled away, and `docs/spec/11-mcp-tools.md`. A channel nobody registered
 * is a **Copy desktop prompt** button that reaches nothing, and it fails exactly
 * the way this repo's sharp edges do — silently, looking like a harness that
 * simply never asks for a check to be run here.
 *
 * **Every value is read off the running channel** (`/api/mcp`), not written down
 * here: the bridge path is resolved from the server module's own URL, so it is
 * right in a checkout and in a `dist` install; the paths come from `validation.*`,
 * so an operator who moved either sees where it went; and the tool list is what
 * `tools/list` would answer. A tab that restated any of it would be a second copy
 * of the install instructions, correct on the day it was written.
 *
 * → `docs/spec/11-mcp-tools.md#the-desktop-channel`
 */
export function McpTab() {
  const [mcp, setMcp] = useState<McpChannelPayload | null>(null);

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

  const register = `claude mcp add --scope user ${mcp.serverId} -- ${shellArgv([
    mcp.registration.command,
    ...mcp.registration.args,
  ])}`;

  return (
    <div className="mcp">
      <p className="muted settings-hint">
        The harness runs a second MCP channel for the Claude Code <em>you</em> drive, so a validation check that needs a
        browser, a login or a VPN the fleet does not have can be run at your keyboard and land on the same row. It is
        three tools and nothing else — read a plan, take one check, report what you saw.
      </p>

      {!mcp.running && (
        <p className="empty mcp-down">
          The channel is not listening, so the command below would reach nothing. The commonest cause is another
          LubbDubb already holding the socket — the boot log and the Faults panel name which. Everything here is what it
          would be once it starts.
        </p>
      )}

      <Panel density="flush" className="cfg-card mcp-step">
        <h3>
          <span className="mcp-n">1</span> Register it, once
        </h3>
        <p className="cfg-hint">
          Run this in any terminal. <code>--scope user</code> puts it in your own Claude Code config rather than in a
          checkout, which is what makes it available in every repo you work in.
        </p>
        <Command text={register} />
        <p className="cfg-hint mcp-foot">
          The command carries no secret and never changes. The credential is a file at{' '}
          <code>{mcp.credentialPath || '(nowhere yet)'}</code> (mode <code>0600</code>) that the bridge reads when
          Claude Code spawns it, and it is minted fresh at every start — so a restarted harness needs no
          re-registration. Check it took with <code>claude mcp list</code>.
        </p>
      </Panel>

      <Panel density="flush" className="cfg-card mcp-step">
        <h3>
          <span className="mcp-n">2</span> Ask for a check
        </h3>
        <p className="cfg-hint">
          The harness installs a <code>/lubbdubb</code> skill at <code>{mcp.skillPath || '(not installed)'}</code> and
          rewrites it at every start, so you do not have to explain the job each time:
        </p>
        <Command text="/lubbdubb 284:C" />
        <p className="cfg-hint mcp-foot">
          <code>284:C</code> is goal 284, check C. <code>284</code> on its own asks what that goal needs. A goal&apos;s
          validation section also has a <b>Copy desktop prompt</b> button, which is the same request in words for a
          session that has no skills.
        </p>
      </Panel>

      <Panel density="flush" className="cfg-card mcp-step">
        <h3>
          <span className="mcp-n">3</span> What it can do
        </h3>
        <p className="cfg-hint">
          These three, and nothing else. The credential is long-lived and sits in your home directory, so the narrowing
          is structural rather than a filter — there is no code path from this channel to the tools the fleet gets.
        </p>
        {mcp.tools.length === 0 ? (
          <p className="cfg-hint mcp-foot">No tools to list — this cockpit is running against the demo backend.</p>
        ) : (
          <ul className="mcp-tools">
            {mcp.tools.map((tool) => (
              <li key={tool.name}>
                <code className="mcp-tool">{tool.name}</code>
                <span className="muted">{tool.description}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/**
 * One paste-able line, with the copy button beside it.
 *
 * The command is selectable as well as copyable for the desktop prompt's reason:
 * a copy that silently did nothing — no clipboard permission, a browser that
 * refuses it over plain HTTP — would leave an operator with nothing, and the text
 * is the thing they came for.
 */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mcp-cmd">
      <code>{text}</code>
      <Button
        ghost
        size="small"
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

/**
 * The argv as a shell would need it back.
 *
 * Windows is the case this exists for, and it is not hypothetical: the bridge
 * lives under the harness's install directory and `process.execPath` is routinely
 * `C:\Program Files\nodejs\node.exe`. Unquoted, the line an operator pastes
 * registers a server called `C:\Program` — which succeeds, and fails later as a
 * channel that will not connect.
 */
export function shellArgv(argv: readonly string[]): string {
  return argv.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)).join(' ');
}
