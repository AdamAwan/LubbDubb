import type { Agent, McpCall, McpChannel, TaskSummary } from './types.js';
import { MCP_PROTOCOL_ADDENDUM } from './agents/agentProtocol.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES, RETIRED_TOOL_NAMES, TOOL_NAMING } from './mcp/names.js';
import { phaseLabel, phaseOf, PHASE_ORDER, type SpendPhase } from './spendInsights.js';
import {
  inWindow,
  runInstant,
  timelineSpan,
  windowView,
  type InsightsWindowView,
  type ResolvedWindow,
} from './insightsWindow.js';

// → docs/spec/11-mcp-tools.md

const TOP_REFUSALS = 8;

type McpQuietVerdict = 'always-refused' | 'retired' | 'never-named' | 'named-never-called' | 'desktop-unused';

const VERDICT_ORDER: readonly McpQuietVerdict[] = [
  'always-refused',
  'retired',
  'never-named',
  'named-never-called',
  'desktop-unused',
];

const VERDICT_COPY: Record<McpQuietVerdict, { label: string; blurb: string; remedy: string | null }> = {
  'always-refused': {
    label: 'Called and always refused',
    blurb: 'Agents are reaching for it and its contract turns every one of them away.',
    remedy:
      'Read the refusals below — a tool refusing every call is either a schema nobody can satisfy or a prompt describing arguments it does not take.',
  },
  retired: {
    label: 'Retired, and still being called',
    blurb: 'This name was withdrawn. Something is still naming it, and every call to it spends a turn on a refusal.',
    remedy: 'Find the prompt override that names it and say `raise` instead. The Setup reading names the file.',
  },
  'never-named': {
    label: 'Nothing named it',
    blurb:
      'Its name is in neither the protocol addendum nor any prompt dispatched in this window, so no agent was told it exists. Being in `tools/list` is not being told.',
    remedy:
      'Name it where it is used — in the dispatch prompt for the work it belongs to, or in the addendum if every agent may call it.',
  },
  'named-never-called': {
    label: 'Named, never reached for',
    blurb:
      'Agents were told about it and none called it. Either the job it does did not come up, or the wording is not landing.',
    remedy: 'Worth a look if the job it does plainly did come up — otherwise this is the tool waiting for its case.',
  },
  'desktop-unused': {
    label: 'No desktop session used it',
    blurb:
      'A desktop tool is called by a person at their own keyboard, so zero means nobody ran one — not that anything is wrong.',
    remedy: null,
  },
};

const NAMING_COPY: Record<McpNaming, { label: string; blurb: string }> = {
  addendum: {
    label: 'Addendum',
    blurb:
      'Named to every agent on every dispatch. Silence here is a broken channel or a prompt that stopped naming it.',
  },
  'point-of-use': {
    label: 'Point of use',
    blurb: 'Named by the prompt that dispatches the work it belongs to. Silence tracks what ran.',
  },
  desktop: {
    label: 'Desktop',
    blurb:
      'The operator’s own channel. Called by a person, so its counts read as usage rather than as fleet behaviour.',
  },
  retired: {
    label: 'Retired',
    blurb: 'A withdrawn name, answered only with a refusal naming `raise`. Any call at all is a prompt out of date.',
  },
  unknown: {
    label: 'Never a tool',
    blurb:
      'A name that is neither advertised nor retired — reached for by a prompt or a model and answered by nothing. ' +
      'It has no row of its own above; this is where its traffic is.',
  },
};

export type McpNaming = 'addendum' | 'point-of-use' | 'desktop' | 'retired' | 'unknown';

export interface McpToolUsage {
  tool: string;
  channel: McpChannel;
  naming: McpNaming;
  calls: number;
  refused: number;
  share: number;
  medianMs: number | null;
  lastCalledAt: string | null;
  namedInAddendum: boolean;
  namedInPrompts: number;
  argsBytes: number;
}

export interface McpQuietTool {
  tool: string;
  channel: McpChannel;
  naming: McpNaming;
  verdict: McpQuietVerdict;
  label: string;
  blurb: string;
  remedy: string | null;
  calls: number;
  refused: number;
  namedInAddendum: boolean;
  namedInPrompts: number;
  lastCalledAt: string | null;
  lastRefusal: string | null;
}

export interface McpSilentRun {
  agentId: string;
  taskId: string;
  title: string;
  originRef: string | null;
  phase: SpendPhase;
  phaseLabel: string;
  profile: string | null;
  status: string;
  endedAt: string | null;
}

export interface McpPhaseUsage {
  phase: SpendPhase;
  label: string;
  runs: number;
  calls: number;
  perRun: number | null;
  silentRuns: number;
}

export interface McpChannelUsage {
  channel: McpChannel;
  calls: number;
  refused: number;
  toolsAdvertised: number;
  toolsCalled: number;
}

export interface McpRefusal {
  tool: string;
  channel: McpChannel;
  refused: number;
  calls: number;
  message: string;
  at: string;
}

interface McpTotals {
  calls: number;
  refused: number;
  runs: number;
  silentRuns: number;
  callsPerRun: number | null;
  medianCallsPerRun: number | null;
  busiestRunCalls: number;
  medianMs: number | null;
  toolsAdvertised: number;
  toolsQuiet: number;
  toolsRetiredCalled: number;
  argsBytes: number;
  argsCompacted: number;
}

export interface McpInsights {
  window: InsightsWindowView;
  totals: McpTotals;
  channels: McpChannelUsage[];
  tools: McpToolUsage[];
  quiet: McpQuietTool[];
  silentRuns: McpSilentRun[];
  byPhase: McpPhaseUsage[];
  naming: McpNamingTotal[];
  refusals: McpRefusal[];
  allowedToolsOverridden: boolean;
}

export interface McpNamingTotal {
  naming: McpNaming;
  label: string;
  blurb: string;
  calls: number;
  share: number;
  tools: number;
  toolsCalled: number;
}

interface McpInsightsInput {
  calls: McpCall[];
  agents: Agent[];
  tasks: TaskSummary[];
  namedInPrompts: Map<string, number>;
  lastCallByTool: Map<string, string>;
  callsEverByAgent: Map<string, number>;
  claudeArgs: readonly string[];
  window: ResolvedWindow;
  now: number;
}

export function buildMcpInsights(input: McpInsightsInput): McpInsights {
  const { calls, window } = input;
  const span = timelineSpan(window, earliestOf(input));
  const tasksById = new Map(input.tasks.map((t) => [t.id, t]));

  const settled = input.agents.filter((a) => a.endedAt !== null && inWindow(window, runInstant(a)));
  const callsByAgent = new Map<string, number>();
  for (const call of calls) {
    if (call.agentId === null) continue;
    callsByAgent.set(call.agentId, (callsByAgent.get(call.agentId) ?? 0) + 1);
  }

  const fleetCalls = calls.filter((c) => c.channel === 'fleet');
  const desktopCalls = calls.filter((c) => c.channel === 'desktop');

  const tools = [
    ...MCP_TOOL_NAMES.map((name) => toolUsage(name, 'fleet', TOOL_NAMING[name], fleetCalls, input)),
    ...RETIRED_TOOL_NAMES.filter((name) => fleetCalls.some((c) => c.tool === name)).map((name) =>
      toolUsage(name, 'fleet', 'retired', fleetCalls, input),
    ),
    ...DESKTOP_TOOL_NAMES.map((name) => toolUsage(name, 'desktop', 'desktop', desktopCalls, input)),
  ].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  const quiet = tools
    .map((usage) => quietTool(usage, calls))
    .filter((entry): entry is McpQuietTool => entry !== null)
    .sort(
      (a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || a.tool.localeCompare(b.tool),
    );

  const perRun = settled.map((a) => callsByAgent.get(a.id) ?? 0);
  const silent = settled.filter((a) => (input.callsEverByAgent.get(a.id) ?? 0) === 0);

  return {
    window: windowView(window, span),
    totals: {
      calls: fleetCalls.length,
      refused: fleetCalls.filter((c) => !c.ok).length,
      runs: settled.length,
      silentRuns: silent.length,
      callsPerRun: settled.length === 0 ? null : round(fleetCalls.length / settled.length),
      medianCallsPerRun: median(perRun),
      busiestRunCalls: perRun.reduce((most, n) => Math.max(most, n), 0),
      medianMs: median(fleetCalls.map((c) => c.durationMs)),
      toolsAdvertised: MCP_TOOL_NAMES.length,
      toolsQuiet: quiet.filter((q) => q.channel === 'fleet' && q.naming !== 'retired').length,
      toolsRetiredCalled: quiet.filter((q) => q.channel === 'fleet' && q.naming === 'retired').length,
      argsBytes: calls.reduce((sum, c) => sum + c.argsBytes, 0),
      argsCompacted: calls.filter((c) => c.argsDropped).length,
    },
    channels: [
      channelUsage('fleet', fleetCalls, MCP_TOOL_NAMES),
      channelUsage('desktop', desktopCalls, DESKTOP_TOOL_NAMES),
    ],
    tools,
    quiet,
    silentRuns: silent
      .map((agent) => silentRun(agent, tasksById.get(agent.taskId)))
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '')),
    byPhase: byPhase(settled, tasksById, callsByAgent, input.callsEverByAgent, fleetCalls),
    naming: namingTotals(tools, fleetCalls),
    refusals: refusals(calls),
    allowedToolsOverridden: input.claudeArgs.some((arg) => arg.startsWith('--allowedTools')),
  };
}

function addendumNames(tool: string): boolean {
  return new RegExp(`\\b${tool}\\b`).test(MCP_PROTOCOL_ADDENDUM);
}

function toolUsage(
  tool: string,
  channel: McpChannel,
  naming: McpNaming,
  channelCalls: McpCall[],
  input: McpInsightsInput,
): McpToolUsage {
  const mine = channelCalls.filter((c) => c.tool === tool);
  return {
    tool,
    channel,
    naming,
    calls: mine.length,
    refused: mine.filter((c) => !c.ok).length,
    share: channelCalls.length === 0 ? 0 : round(mine.length / channelCalls.length),
    medianMs: median(mine.map((c) => c.durationMs)),
    lastCalledAt: input.lastCallByTool.get(`${channel}:${tool}`) ?? null,
    namedInAddendum: channel === 'fleet' && addendumNames(tool),
    namedInPrompts: input.namedInPrompts.get(tool) ?? 0,
    argsBytes: mine.reduce((sum, c) => sum + c.argsBytes, 0),
  };
}

function quietTool(usage: McpToolUsage, calls: McpCall[]): McpQuietTool | null {
  const verdict = verdictFor(usage);
  if (verdict === null) return null;
  const copy = VERDICT_COPY[verdict];
  const refusal = calls.filter((c) => c.tool === usage.tool && c.channel === usage.channel && c.error !== null).at(-1);
  return {
    tool: usage.tool,
    channel: usage.channel,
    naming: usage.naming,
    verdict,
    label: copy.label,
    blurb: copy.blurb,
    remedy: copy.remedy,
    calls: usage.calls,
    refused: usage.refused,
    namedInAddendum: usage.namedInAddendum,
    namedInPrompts: usage.namedInPrompts,
    lastCalledAt: usage.lastCalledAt,
    lastRefusal: refusal?.error ?? null,
  };
}

function verdictFor(usage: McpToolUsage): McpQuietVerdict | null {
  if (usage.naming === 'retired') return usage.calls > 0 ? 'retired' : null;
  if (usage.calls > 0) return usage.refused === usage.calls ? 'always-refused' : null;
  if (usage.channel === 'desktop') return 'desktop-unused';
  return usage.namedInAddendum || usage.namedInPrompts > 0 ? 'named-never-called' : 'never-named';
}

function channelUsage(channel: McpChannel, channelCalls: McpCall[], advertised: readonly string[]): McpChannelUsage {
  const live = new Set(advertised);
  return {
    channel,
    calls: channelCalls.length,
    refused: channelCalls.filter((c) => !c.ok).length,
    toolsAdvertised: advertised.length,
    toolsCalled: new Set(channelCalls.filter((c) => live.has(c.tool)).map((c) => c.tool)).size,
  };
}

function silentRun(agent: Agent, task: TaskSummary | undefined): McpSilentRun {
  const originRef = task?.originRef ?? null;
  const phase = phaseOf(originRef);
  return {
    agentId: agent.id,
    taskId: agent.taskId,
    title: task?.title ?? 'an agent with no task on record',
    originRef,
    phase,
    phaseLabel: phaseLabel(phase),
    profile: task?.profile ?? null,
    status: agent.status,
    endedAt: agent.endedAt,
  };
}

function byPhase(
  settled: readonly Agent[],
  tasksById: Map<string, TaskSummary>,
  callsByAgent: Map<string, number>,
  callsEverByAgent: Map<string, number>,
  fleetCalls: readonly McpCall[],
): McpPhaseUsage[] {
  const runs = new Map<SpendPhase, number>();
  const silent = new Map<SpendPhase, number>();
  for (const agent of settled) {
    const phase = phaseOf(tasksById.get(agent.taskId)?.originRef ?? null);
    runs.set(phase, (runs.get(phase) ?? 0) + 1);
    if ((callsEverByAgent.get(agent.id) ?? 0) === 0) silent.set(phase, (silent.get(phase) ?? 0) + 1);
  }
  const callsIn = new Map<SpendPhase, number>();
  for (const call of fleetCalls) {
    const phase = phaseOf(call.originRef);
    callsIn.set(phase, (callsIn.get(phase) ?? 0) + 1);
  }
  return PHASE_ORDER.map((phase) => {
    const phaseRuns = runs.get(phase) ?? 0;
    const phaseCalls = callsIn.get(phase) ?? 0;
    return {
      phase,
      label: phaseLabel(phase),
      runs: phaseRuns,
      calls: phaseCalls,
      perRun: phaseRuns === 0 ? null : round(phaseCalls / phaseRuns),
      silentRuns: silent.get(phase) ?? 0,
    };
  }).filter((row) => row.runs > 0 || row.calls > 0);
}

function namingTotals(tools: readonly McpToolUsage[], fleetCalls: readonly McpCall[]): McpNamingTotal[] {
  const classes: readonly McpNaming[] = ['addendum', 'point-of-use', 'retired', 'unknown'];
  const known = new Set(tools.filter((t) => t.channel === 'fleet').map((t) => t.tool));
  const unknown = fleetCalls.filter((c) => !known.has(c.tool));
  return classes
    .map((naming) => {
      const mine = tools.filter((t) => t.naming === naming);
      const names = new Set(unknown.map((c) => c.tool));
      if (naming === 'unknown')
        return {
          naming,
          label: NAMING_COPY[naming].label,
          blurb: NAMING_COPY[naming].blurb,
          calls: unknown.length,
          share: fleetCalls.length === 0 ? 0 : round(unknown.length / fleetCalls.length),
          tools: names.size,
          toolsCalled: names.size,
        };
      const calls = mine.reduce((sum, t) => sum + t.calls, 0);
      return {
        naming,
        label: NAMING_COPY[naming].label,
        blurb: NAMING_COPY[naming].blurb,
        calls,
        share: fleetCalls.length === 0 ? 0 : round(calls / fleetCalls.length),
        tools: mine.length,
        toolsCalled: mine.filter((t) => t.calls > 0).length,
      };
    })
    .filter((row) => (row.naming !== 'retired' && row.naming !== 'unknown') || row.tools > 0);
}

function refusals(calls: readonly McpCall[]): McpRefusal[] {
  const byTool = new Map<string, McpCall[]>();
  for (const call of calls) {
    if (call.ok) continue;
    const key = `${call.channel}:${call.tool}`;
    byTool.set(key, [...(byTool.get(key) ?? []), call]);
  }
  return [...byTool.values()]
    .map((group) => {
      const last = group[group.length - 1]!;
      return {
        tool: last.tool,
        channel: last.channel,
        refused: group.length,
        calls: calls.filter((c) => c.tool === last.tool && c.channel === last.channel).length,
        message: last.error ?? 'refused without a reason',
        at: last.createdAt,
      };
    })
    .sort((a, b) => b.refused - a.refused || a.tool.localeCompare(b.tool))
    .slice(0, TOP_REFUSALS);
}

function earliestOf(input: McpInsightsInput): number | null {
  const first = input.calls[0];
  return first === undefined ? null : Date.parse(first.createdAt);
}

function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
