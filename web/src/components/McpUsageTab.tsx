import type { JSX } from 'react';
import type {
  McpChannelUsage,
  McpInsights,
  McpNamingTotal,
  McpPhaseUsage,
  McpQuietTool,
  McpRefusal,
  McpSilentRun,
  McpToolUsage,
} from '../types.js';
import { fmtShare, fmtSince, share } from './insightsFormat.js';
import { toCsv } from './Downloads.js';
import { Ref } from './refs.js';
import { HeadRow } from './panel.js';
import { Label } from './label.js';

// → docs/spec/17-cockpit.md

export function McpUsageTab({ insights }: { insights: McpInsights }): JSX.Element {
  const { totals, quiet, silentRuns } = insights;
  if (totals.calls === 0 && insights.channels.every((c) => c.calls === 0)) {
    return (
      <>
        <p className="empty">
          {totals.runs === 0
            ? 'No agent settled in this window, so there is nothing the channel could have been asked for.'
            : `${totals.runs} run${totals.runs === 1 ? '' : 's'} settled in this window and not one made a tool ` +
              'call. That is not a quiet fleet — it is a channel no agent could reach.'}
        </p>
        {totals.runs > 0 && <GrantHazard insights={insights} />}
      </>
    );
  }

  return (
    <div className="mc sp">
      <Tiles totals={totals} />

      {silentRuns.length > 0 && <SilentRuns runs={silentRuns} totals={totals} />}
      <GrantHazard insights={insights} />

      {quiet.length > 0 && (
        <>
          <p className="sp-sub">What is not being used, and why</p>
          <Quiet quiet={quiet} />
        </>
      )}

      <p className="sp-sub">Where the calls went, by how the tool is named</p>
      <NamingBar naming={insights.naming} calls={totals.calls} />
      <NamingKey naming={insights.naming} />

      <p className="sp-sub">By tool · the fleet&rsquo;s channel</p>
      <Tools tools={insights.tools.filter((t) => t.channel === 'fleet')} total={totals.calls} />

      <div className="sp-cols">
        <section className="sp-col">
          <p className="sp-sub">By phase</p>
          <Phases phases={insights.byPhase} />
          {insights.refusals.length > 0 && (
            <>
              <p className="sp-sub">Refusals</p>
              <Refusals refusals={insights.refusals} />
            </>
          )}
        </section>
        <section className="sp-col">
          <p className="sp-sub">The other channel · your own Claude Code</p>
          <Desktop insights={insights} />
          <Method totals={totals} />
        </section>
      </div>
    </div>
  );
}

export function mcpCsv(insights: McpInsights): string {
  const { totals } = insights;
  return toCsv([
    ['Tallies'],
    ['Measure', 'Value'],
    ['Tool calls (fleet)', totals.calls],
    ['Refused', totals.refused],
    ['Runs settled', totals.runs],
    ['Runs that called nothing', totals.silentRuns],
    ['Calls per run (mean)', totals.callsPerRun ?? ''],
    ['Calls per run (median)', totals.medianCallsPerRun ?? ''],
    ['Busiest run', totals.busiestRunCalls],
    ['Median call (ms)', totals.medianMs ?? ''],
    ['Tools advertised', totals.toolsAdvertised],
    ['Tools with something to answer for', totals.toolsQuiet],
    ['Retired names still being called', totals.toolsRetiredCalled],
    ['Recorded argument bytes', totals.argsBytes],
    ['Calls whose arguments have been compacted', totals.argsCompacted],
    ['Operator --allowedTools override present', insights.allowedToolsOverridden ? 'yes' : 'no'],
    ['Window', insights.window.label],
    ['Window opened (ISO)', insights.window.since ?? 'no lower bound — all time'],
    ['A call is', 'one tools/call that reached a tool body, counted at the server'],
    ['Refused means', 'a handled error the tool returned — never a permission refusal, which never arrives at all'],
    ['The two channels are', 'never summed: different credentials, different tool sets, one shared tool name'],
    [],

    ['Not being used'],
    ['Tool', 'Channel', 'Verdict', 'Calls', 'Refused', 'Named in addendum', 'Named in prompts', 'Last called', 'Why'],
    ...insights.quiet.map((q) => [
      q.tool,
      q.channel,
      q.label,
      q.calls,
      q.refused,
      q.namedInAddendum ? 'yes' : 'no',
      q.namedInPrompts,
      q.lastCalledAt ?? 'never',
      q.blurb,
    ]),
    [],

    ['Runs that called nothing'],
    ['Agent', 'Task', 'Goal', 'Phase', 'Profile', 'Status', 'Ended'],
    ...insights.silentRuns.map((r) => [
      r.agentId,
      r.taskId,
      r.originRef ?? '',
      r.phaseLabel,
      r.profile ?? '',
      r.status,
      r.endedAt ?? '',
    ]),
    [],

    ['By tool'],
    ['Tool', 'Channel', 'Named', 'Calls', 'Share', 'Refused', 'Median ms', 'Last called', 'Argument bytes'],
    ...insights.tools.map((t) => [
      t.tool,
      t.channel,
      t.naming,
      t.calls,
      t.share,
      t.refused,
      t.medianMs ?? '',
      t.lastCalledAt ?? 'never',
      t.argsBytes,
    ]),
    [],

    ['By phase'],
    ['Phase', 'Runs', 'Calls', 'Per run', 'Silent runs'],
    ...insights.byPhase.map((p) => [p.label, p.runs, p.calls, p.perRun ?? '', p.silentRuns]),
    [],

    ['Refusals'],
    ['Tool', 'Channel', 'Refused', 'Of calls', 'Last refusal', 'At'],
    ...insights.refusals.map((r) => [r.tool, r.channel, r.refused, r.calls, r.message, r.at]),
  ]);
}

function Tiles({ totals }: { totals: McpInsights['totals'] }): JSX.Element {
  return (
    <div className="sp-tiles">
      <div className="sp-tile">
        <Label dense>Tool calls</Label>
        <span className="vl">{totals.calls.toLocaleString()}</span>
        <span className="sb">across {totals.runs.toLocaleString()} settled runs</span>
      </div>
      <div className="sp-tile">
        <Label dense>Calls per run</Label>
        <span className="vl">{totals.callsPerRun === null ? '—' : totals.callsPerRun.toFixed(1)}</span>
        <span className="sb">
          median {totals.medianCallsPerRun ?? '—'} · busiest {totals.busiestRunCalls}
        </span>
      </div>
      {/* The two alarms carry the alarm colours, and only when there is something
          to be alarmed about: a tile permanently tinted red is a tile nobody reads. */}
      <div className={totals.silentRuns > 0 ? 'sp-tile sp-leak' : 'sp-tile'}>
        <Label dense>Runs that called nothing</Label>
        <span className="vl">{totals.silentRuns}</span>
        <span className="sb">{fmtShare(totals.silentRuns, totals.runs)} of settled runs</span>
      </div>
      {/* Both numbers count the advertised set, so the fraction is a reading and
          not two counters. A retired name still being called is its own finding
          and says so beneath, rather than pushing the numerator past 20/20. */}
      <div className={totals.toolsQuiet > 0 || totals.toolsRetiredCalled > 0 ? 'sp-tile sp-watch' : 'sp-tile'}>
        <Label dense>Tools to answer for</Label>
        <span className="vl">
          {totals.toolsQuiet}
          <small>/</small>
          {totals.toolsAdvertised}
        </span>
        <span className="sb">
          silent, or refusing everything
          {totals.toolsRetiredCalled > 0
            ? ` · plus ${totals.toolsRetiredCalled} retired ${totals.toolsRetiredCalled === 1 ? 'name' : 'names'} still called`
            : ''}
        </span>
      </div>
      <div className="sp-tile">
        <Label dense>Refused</Label>
        <span className="vl">{totals.refused}</span>
        <span className="sb">
          {fmtShare(totals.refused, totals.calls)} · median call{' '}
          {totals.medianMs === null ? '—' : `${totals.medianMs}ms`}
        </span>
      </div>
    </div>
  );
}

function SilentRuns({ runs, totals }: { runs: readonly McpSilentRun[]; totals: McpInsights['totals'] }): JSX.Element {
  const profiles = [...new Set(runs.map((r) => r.profile).filter((p): p is string => p !== null))];
  return (
    <section className="mc-alarm">
      <h3>
        {runs.length} run{runs.length === 1 ? '' : 's'} settled having made no tool call at all
        <span className="when">{fmtShare(runs.length, totals.runs)} of this window</span>
      </h3>
      <p>
        A run reaches the channel or it does not, and one that never called anything did not. The commonest cause is an{' '}
        <code>--allowedTools</code> of your own in <code>claudeArgs</code>: operator args are appended last, so it wins
        over the harness&rsquo;s and drops every <code>mcp__lubbdubb__*</code> grant — a <b>connected</b> server whose
        every call is refused. The agent finishes on the sentinels alone and reports nothing.
        {profiles.length > 0 && (
          <>
            {' '}
            {profiles.length === 1 ? 'All of these ran' : 'These ran'} under{' '}
            {profiles.map((p) => (
              <code key={p}>{p}</code>
            ))}
            .
          </>
        )}
      </p>
      <ul className="mc-runs">
        {runs.slice(0, 8).map((run) => (
          <li key={run.agentId}>
            <span className="mc-run-what">{run.title}</span>
            <span className="cn-refs">
              <Ref to={run.originRef} />
            </span>
            <span className="mc-run-meta">
              {run.phaseLabel} · {run.status} · {run.endedAt === null ? 'still out' : fmtSince(run.endedAt)}
            </span>
          </li>
        ))}
      </ul>
      {runs.length > 8 && <p className="mc-more">and {runs.length - 8} more — the export carries all of them.</p>}
    </section>
  );
}

function GrantHazard({ insights }: { insights: McpInsights }): JSX.Element | null {
  if (!insights.allowedToolsOverridden) return null;
  return (
    <p className="mc-hazard">
      <b>
        This deployment&rsquo;s <code>claudeArgs</code> carries its own <code>--allowedTools</code>.
      </b>{' '}
      Operator args are appended last, so that flag beats the harness&rsquo;s and drops every{' '}
      <code>mcp__lubbdubb__*</code> grant from the launch. Move the list to <code>agentAllowedTools</code>, which rides
      in <code>--settings</code> — a different flag, and one the harness&rsquo;s grants survive.
    </p>
  );
}

function Quiet({ quiet }: { quiet: readonly McpQuietTool[] }): JSX.Element {
  return (
    <ul className="mc-quiet">
      {quiet.map((tool) => (
        <li key={`${tool.channel}:${tool.tool}`} className={`mc-q-${tool.verdict}`}>
          <HeadRow align="baseline" className="mc-q-head">
            <code className="mc-q-tool">{tool.tool}</code>
            <span className={`cls ${tool.naming}`}>{tool.naming.replace('-', ' ')}</span>
            <span className="mc-q-verdict">{tool.label}</span>
            <span className="mc-q-when">
              {tool.lastCalledAt === null ? 'never called' : `last called ${fmtSince(tool.lastCalledAt)}`}
            </span>
          </HeadRow>
          <p className="mc-q-why">{tool.blurb}</p>
          {/* The evidence, so the verdict is checkable rather than merely stated.
              Omitted for a desktop tool, whose verdict rests on neither. */}
          {tool.channel === 'fleet' && (
            <p className="mc-q-ev">
              addendum: <b>{tool.namedInAddendum ? 'names it' : 'does not'}</b> · dispatch prompts naming it:{' '}
              <b>{tool.namedInPrompts}</b>
              {tool.calls > 0 && (
                <>
                  {' '}
                  · calls: <b>{tool.calls}</b>, all refused
                </>
              )}
            </p>
          )}
          {tool.lastRefusal !== null && <p className="mc-q-refusal">“{tool.lastRefusal}”</p>}
          {tool.remedy !== null && <p className="mc-q-fix">{tool.remedy}</p>}
        </li>
      ))}
    </ul>
  );
}

function NamingBar({ naming, calls }: { naming: readonly McpNamingTotal[]; calls: number }): JSX.Element {
  return (
    <div
      className="sp-bar"
      role="img"
      aria-label={naming.map((n) => `${n.label} ${fmtShare(n.calls, calls)}`).join(', ')}
    >
      {naming.map((n) => (
        <span
          key={n.naming}
          className="sg"
          style={{ width: `${share(n.calls, calls)}%`, background: `var(--mc-${n.naming})` }}
        />
      ))}
    </div>
  );
}

function NamingKey({ naming }: { naming: readonly McpNamingTotal[] }): JSX.Element {
  const calls = naming.reduce((sum, n) => sum + n.calls, 0);
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Named</th>
          <th className="n">Tools</th>
          <th className="n">Calls</th>
          <th className="n">Share</th>
          <th>What silence there means</th>
        </tr>
      </thead>
      <tbody>
        {naming.map((n) => (
          <tr key={n.naming}>
            <td>
              <span className="sw" style={{ background: `var(--mc-${n.naming})` }} />
              <span className="nm">{n.label}</span>
            </td>
            <td className="n">
              {n.toolsCalled}/{n.tools}
            </td>
            <td className="n">{n.calls.toLocaleString()}</td>
            <td className="n">{fmtShare(n.calls, calls)}</td>
            <td>{n.blurb}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Tools({ tools, total }: { tools: readonly McpToolUsage[]; total: number }): JSX.Element {
  const most = tools.reduce((top, t) => Math.max(top, t.calls), 0);
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Tool</th>
          <th>Named</th>
          <th className="n">Calls</th>
          <th className="bar">Share</th>
          <th className="n">Refused</th>
          <th className="n">Median</th>
          <th className="n">Last</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((tool) => (
          <tr key={tool.tool}>
            <td className="nm">{tool.tool}</td>
            <td>
              <span className={`cls ${tool.naming}`}>{tool.naming.replace('-', ' ')}</span>
            </td>
            <td className="n">{tool.calls.toLocaleString()}</td>
            <td className="bar">
              <span className="sp-gbar">
                <span
                  className="sg"
                  style={{ width: `${share(tool.calls, most)}%`, background: `var(--mc-${tool.naming})` }}
                />
              </span>
            </td>
            <td className={tool.refused > 0 ? 'n mc-bad' : 'n mc-none'}>{tool.refused === 0 ? '—' : tool.refused}</td>
            <td className="n">{tool.medianMs === null ? '—' : `${tool.medianMs}ms`}</td>
            <td className="n">{tool.lastCalledAt === null ? 'never' : fmtSince(tool.lastCalledAt)}</td>
          </tr>
        ))}
        <tr className="rest">
          <td className="nm">{tools.length} tools</td>
          <td />
          <td className="n">{total.toLocaleString()}</td>
          <td className="bar" />
          <td className="n">{tools.reduce((sum, t) => sum + t.refused, 0)}</td>
          <td className="n" />
          <td className="n" />
        </tr>
      </tbody>
    </table>
  );
}

function Phases({ phases }: { phases: readonly McpPhaseUsage[] }): JSX.Element {
  if (phases.length === 0) return <p className="empty">No run in this window had a phase to file it under.</p>;
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Phase</th>
          <th className="n">Runs</th>
          <th className="n">Calls</th>
          <th className="n">Per run</th>
          <th className="n">Silent</th>
        </tr>
      </thead>
      <tbody>
        {phases.map((phase) => (
          <tr key={phase.phase}>
            <td>
              <span className="sw" style={{ background: `var(--sp-${phase.phase})` }} />
              <span className="nm ph">{phase.label}</span>
            </td>
            <td className="n">{phase.runs}</td>
            <td className="n">{phase.calls.toLocaleString()}</td>
            <td className="n">{phase.perRun === null ? '—' : phase.perRun.toFixed(1)}</td>
            <td className={phase.silentRuns > 0 ? 'n mc-bad' : 'n mc-none'}>
              {phase.silentRuns === 0 ? '—' : phase.silentRuns}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Refusals({ refusals }: { refusals: readonly McpRefusal[] }): JSX.Element {
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Tool</th>
          <th className="n">Refused</th>
          <th>Most recent</th>
        </tr>
      </thead>
      <tbody>
        {refusals.map((refusal) => (
          <tr key={`${refusal.channel}:${refusal.tool}`}>
            <td className="nm">
              {refusal.tool}
              <span className="bl">{refusal.channel}</span>
            </td>
            <td className="n">
              {refusal.refused}
              <span className="bl mono">of {refusal.calls}</span>
            </td>
            <td>
              <span className="mc-refusal">{refusal.message}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Desktop({ insights }: { insights: McpInsights }): JSX.Element {
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

function Method({ totals }: { totals: McpInsights['totals'] }): JSX.Element {
  return (
    <div className="sp-method">
      <p className="sp-sub">What these numbers are</p>
      <p>
        A <b>call</b> is one <span className="mono">tools/call</span> that reached a tool body, counted at the server
        rather than in a transcript — so a call an agent made and abandoned still counts, and a tool an agent talked
        about calling does not.
      </p>
      <p>
        <b>Refused</b> is a handled error the tool returned: a schema it rejected, a goal it would not write to. It is{' '}
        <b>not</b> a permission refusal — a call the grants dropped never arrives at all, which is why the count that
        matters for those is <b>runs that called nothing</b>.
      </p>
      <p>
        <b>Median</b> is the tool body&rsquo;s own time, not the model&rsquo;s wait.{' '}
        <span className="mono">request_permission</span> blocks on you, so its median is a reading about how quickly you
        answer.
      </p>
      <p>
        <b>Arguments</b> are kept for a fortnight and then cleared, the row staying behind — so every count here is
        exact over any window, and only the text goes.{' '}
        {totals.argsCompacted > 0 && (
          <span className="dim">
            {totals.argsCompacted.toLocaleString()} call{totals.argsCompacted === 1 ? '' : 's'} in this window have been
            compacted.
          </span>
        )}
      </p>
    </div>
  );
}
