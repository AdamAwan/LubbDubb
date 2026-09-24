import type { JSX } from 'react';
import type { McpChannelUsage, McpInsights } from '../types.js';
import { fmtShare, fmtSince, share } from './insightsFormat.js';

// → docs/spec/17-cockpit.md

export function McpDesktopChannel({ insights }: { insights: McpInsights }): JSX.Element {
  const desktop = insights.channels.find((c) => c.channel === 'desktop');
  const tools = insights.tools.filter((t) => t.channel === 'desktop');
  return (
    <>
      <table className="sp-tbl">
        <thead>
          <tr>
            <th>Tool</th>
            <th className="n">Calls</th>
            <th className="n">Refused</th>
            <th className="n">Last</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.tool}>
              <td className="nm">{tool.tool}</td>
              <td className="n">{tool.calls}</td>
              <td className={tool.refused > 0 ? 'n mc-bad' : 'n mc-none'}>{tool.refused === 0 ? '—' : tool.refused}</td>
              <td className="n">{tool.lastCalledAt === null ? 'never' : fmtSince(tool.lastCalledAt)}</td>
            </tr>
          ))}
          <tr className="rest">
            <td className="nm">{desktop?.toolsCalled ?? 0} of these used</td>
            <td className="n">{desktop?.calls ?? 0}</td>
            <td className="n">{desktop?.refused ?? 0}</td>
            <td className="n" />
          </tr>
        </tbody>
      </table>
      <ChannelSplit channels={insights.channels} />
    </>
  );
}

function ChannelSplit({ channels }: { channels: readonly McpChannelUsage[] }): JSX.Element {
  const all = channels.reduce((sum, c) => sum + c.calls, 0);
  return (
    <>
      <p className="sp-sub">Which channel the traffic is</p>
      <div
        className="sp-bar"
        role="img"
        aria-label={channels.map((c) => `${c.channel} ${fmtShare(c.calls, all)}`).join(', ')}
      >
        {channels.map((c) => (
          <span
            key={c.channel}
            className="sg"
            style={{ width: `${share(c.calls, all)}%`, background: `var(--mc-ch-${c.channel})` }}
          />
        ))}
      </div>
      <p className="mc-split-key">
        {channels.map((c) => (
          <span key={c.channel}>
            <span className="sw" style={{ background: `var(--mc-ch-${c.channel})` }} />
            {c.channel} · {c.calls.toLocaleString()} calls, {c.toolsCalled}/{c.toolsAdvertised} tools
          </span>
        ))}
      </p>
    </>
  );
}
