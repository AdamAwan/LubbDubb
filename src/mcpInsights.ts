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

/**
 * The MCP tool channel as a reading: what the fleet reached for, and — the whole
 * reason this exists — what it never reached for, with the harness's own answer
 * for why.
 *
 * Every other Insights tab folds records that were already being kept for some
 * other purpose. This one folds a table (`mcp_calls`) that exists only for it,
 * because the failure it is about leaves no trace anywhere else. An agent whose
 * `mcp__lubbdubb__*` grants were dropped — an operator's `claudeArgs` carrying its
 * own `--allowedTools`, which is appended last and wins — connects to the channel,
 * is refused every call, finishes its work on the sentinels alone, and reports
 * nothing. Its transcript looks like an agent that chose not to use the tools.
 *
 * ## A count of zero is not a finding
 *
 * "Nothing called `request_human_task` this week" is not a bug report; it is one
 * of four different facts wearing the same face, and they want opposite actions:
 *
 * - **nobody could have called it** — its name appears in neither the protocol
 *   addendum nor any prompt the window dispatched. Nothing told an agent it
 *   exists, and `tools/list` alone does not count: an agent reaches for what its
 *   instructions named, and shells out to `gh` for the rest.
 * - **it was named and nobody reached for it** — the wording is not landing, or
 *   the job it does never came up.
 * - **it was called and always refused** — the tool is reachable and its contract
 *   is rejecting every attempt, which is the one case where the silence is the
 *   tool's own fault.
 * - **the channel was dark** — the runs that would have called it made no call at
 *   all, and then no per-tool reading in this window means anything.
 *
 * So this module does not ship counts for the cockpit to interpret. It ships a
 * {@link McpQuietTool} per silent tool carrying the **verdict** and the evidence
 * behind it, for the reason `PHASE_COPY` and `OUTCOME_COPY` ship their own words:
 * it is a claim about what the harness did, and a cockpit re-deriving it from
 * three numbers would be a second opinion drawn inches from the first.
 *
 * ## Where the evidence comes from
 *
 * `TOOL_NAMING` states where each tool is *supposed* to be named; the addendum
 * text and the dispatched prompts are whether it actually was. Keeping those
 * separate is deliberate — a tool classified `addendum` whose name is not in
 * {@link MCP_PROTOCOL_ADDENDUM} is a defect this reading can name outright, and
 * one that a check of the classification alone would agree was fine.
 *
 * ## The two channels are never summed
 *
 * The fleet's calls arrive on a per-agent credential over one tool set and the
 * operator's on a long-lived one over another, and `validation_report` is two
 * different tools with one name. A total across them would be a number about
 * nothing, so `totals` is the fleet's and the desktop channel is its own section.
 *
 * → `docs/spec/17-cockpit.md#mcp`, `docs/spec/11-mcp-tools.md#what-is-recorded`
 */

/** How many rows the refusal ranking carries. A ranking, and it says its cap out loud. */
const TOP_REFUSALS = 8;

/** Why a tool is quiet, worst first — which is also the order the tab lists them. */
type McpQuietVerdict = 'always-refused' | 'retired' | 'never-named' | 'named-never-called' | 'desktop-unused';

const VERDICT_ORDER: readonly McpQuietVerdict[] = [
  'always-refused',
  'retired',
  'never-named',
  'named-never-called',
  'desktop-unused',
];

/**
 * What each verdict means and what to do about it, in the operator's words.
 *
 * Shipped with the figures for `PHASE_COPY`'s reason. `remedy` is separate from
 * `blurb` because they answer different questions and only one of them is always
 * actionable: `desktop-unused` is a reading with nothing to fix.
 */
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

/** What the naming classification means for how a silence should be read. */
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

/** Where a tool is named — `TOOL_NAMING`'s two classes, plus the two channels' own. */
export type McpNaming = 'addendum' | 'point-of-use' | 'desktop' | 'retired' | 'unknown';

export interface McpToolUsage {
  tool: string;
  channel: McpChannel;
  naming: McpNaming;
  calls: number;
  refused: number;
  /** Share of its own channel's calls. Never of both — see the module note. */
  share: number;
  /** The tool body's own time, not the model's wait. Null when nothing was called. */
  medianMs: number | null;
  /** The last call on either channel, over **all time** — the window cannot contain it. */
  lastCalledAt: string | null;
  /** Whether {@link MCP_PROTOCOL_ADDENDUM} names it. False for every desktop tool. */
  namedInAddendum: boolean;
  /** Dispatched prompts in this window whose text names it. */
  namedInPrompts: number;
  /** What its arguments measured, summed. Zero where the deployment records none. */
  argsBytes: number;
}

/** A tool whose silence — or whose unbroken run of refusals — has a diagnosis. */
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
  /** One refusal in the tool's own words, when there is one. The most recent. */
  lastRefusal: string | null;
}

/**
 * A run that settled having made no MCP call at all.
 *
 * The alarm the tab is built around, and the one reading here that is about runs
 * rather than tools. It carries the profile because that is where the answer
 * usually is: a profile whose `claudeArgs` carries its own `--allowedTools` wins
 * over the harness's and silently drops every `mcp__lubbdubb__*` grant.
 */
export interface McpSilentRun {
  agentId: string;
  taskId: string;
  title: string;
  originRef: string | null;
  phase: SpendPhase;
  phaseLabel: string;
  /** The model profile the run was dispatched under, when it had one. */
  profile: string | null;
  status: string;
  endedAt: string | null;
}

export interface McpPhaseUsage {
  phase: SpendPhase;
  label: string;
  runs: number;
  calls: number;
  /** Calls per settled run in this phase. Null when the phase had no runs. */
  perRun: number | null;
  silentRuns: number;
}

/** One channel's totals. Stated per channel because they are never summed. */
export interface McpChannelUsage {
  channel: McpChannel;
  calls: number;
  refused: number;
  toolsAdvertised: number;
  toolsCalled: number;
}

/** One tool's refusals, for the ranking under the tables. */
export interface McpRefusal {
  tool: string;
  channel: McpChannel;
  refused: number;
  calls: number;
  /** The most recent refusal in the tool's own words. */
  message: string;
  at: string;
}

interface McpTotals {
  /** Fleet-channel calls. The desktop channel's are on its own row in `channels`. */
  calls: number;
  refused: number;
  /** Settled runs in the window — the denominator, and what a silence is measured against. */
  runs: number;
  /** Of those, the ones that made no call at all. */
  silentRuns: number;
  callsPerRun: number | null;
  medianCallsPerRun: number | null;
  busiestRunCalls: number;
  medianMs: number | null;
  toolsAdvertised: number;
  /** Advertised fleet tools with something to answer for. Never above `toolsAdvertised`. */
  toolsQuiet: number;
  /** Withdrawn names something is still calling. Counted apart: not a live tool gone quiet. */
  toolsRetiredCalled: number;
  /** What the recorded arguments measure in total, and how much has been compacted. */
  argsBytes: number;
  argsCompacted: number;
}

export interface McpInsights {
  window: InsightsWindowView;
  totals: McpTotals;
  channels: McpChannelUsage[];
  /** Both channels' tools, called ones first. The tab draws them in two tables. */
  tools: McpToolUsage[];
  quiet: McpQuietTool[];
  silentRuns: McpSilentRun[];
  byPhase: McpPhaseUsage[];
  naming: McpNamingTotal[];
  refusals: McpRefusal[];
  /**
   * Whether this deployment's `claudeArgs` carries its own `--allowedTools`.
   *
   * A **live config read**, not a fold of the window, and the only thing on this
   * payload that is not. It is the single commonest cause of the alarm above and
   * it is invisible everywhere else: operator args are appended last, so an
   * explicit `--allowedTools` there beats the harness's and drops every
   * `mcp__lubbdubb__*` grant — leaving a connected channel whose every call is
   * refused. Reported whether or not any run has gone silent yet, because the
   * point is to catch it before one does.
   */
  allowedToolsOverridden: boolean;
}

/** One naming class's share of the fleet channel's calls. */
export interface McpNamingTotal {
  naming: McpNaming;
  label: string;
  blurb: string;
  calls: number;
  share: number;
  /** How many tools of this class exist, and how many of them were called. */
  tools: number;
  toolsCalled: number;
}

interface McpInsightsInput {
  calls: McpCall[];
  /** Every agent the harness has run; windowed here, on `runInstant`, as elsewhere. */
  agents: Agent[];
  tasks: TaskSummary[];
  /** Per tool, how many dispatched prompts in the window name it. See the module note. */
  namedInPrompts: Map<string, number>;
  /**
   * The last call per tool **per channel**, keyed `channel:tool`, over all time —
   * a date the window by definition cannot hold. Keyed on the pair because
   * `validation_report` is two different tools with one name.
   */
  lastCallByTool: Map<string, string>;
  /** This deployment's operator-supplied `claudeArgs`, for the override check. */
  claudeArgs: readonly string[];
  window: ResolvedWindow;
  now: number;
}

export function buildMcpInsights(input: McpInsightsInput): McpInsights {
  const { calls, window } = input;
  const span = timelineSpan(window, earliestOf(input));
  const tasksById = new Map(input.tasks.map((t) => [t.id, t]));

  // The runs the window covers, on the same instant the spend and reliability
  // folds use: where a run *ended*, and where it started only while it is still
  // going. A run that opened before the window and finished inside it made its
  // calls inside it.
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
  const silent = settled.filter((a) => (callsByAgent.get(a.id) ?? 0) === 0);

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
      // Over the advertised set only. A retired name being called is its own
      // finding — it is *not* a live tool gone quiet — and counting it here read
      // as 24 tools to answer for out of 20 advertised, on exactly the
      // deployment the verdict exists to help.
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
    byPhase: byPhase(settled, tasksById, callsByAgent, fleetCalls),
    naming: namingTotals(tools, fleetCalls),
    refusals: refusals(calls),
    // `some`, not an exact match: an operator writes `--allowedTools` and
    // `--allowedTools=Bash(git:*)` alike, and both win over ours the same way.
    allowedToolsOverridden: input.claudeArgs.some((arg) => arg.startsWith('--allowedTools')),
  };
}

/**
 * Whether the addendum names a tool.
 *
 * A word-boundary match on the tool's own name rather than on `name(`, because a
 * prompt that names a tool in prose has named it just as surely as one that
 * writes its signature. The two names this could over-match on are `raise` and
 * `escalate`, which are ordinary English words — and both are named in the
 * addendum in any case, so the ambiguity cannot produce a wrong verdict. Every
 * other tool name is snake_case and occurs in no sentence.
 *
 * One matcher for the addendum and for the prompts (`countTasksNamingTools` uses
 * SQL `instr`, which is the same question asked of the same text), because two
 * ways of asking whether a prompt names a tool is how one of them comes to
 * disagree.
 */
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

/**
 * The verdict for one tool, or null when it has nothing to answer for.
 *
 * The ladder is ordered by what would make the others meaningless: a tool that
 * was called cannot be unnamed, and a retired name that is being called is a
 * finding whatever else is true of it.
 */
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
  // A retired name being called at all is the finding, whether or not the
  // refusals are its only outcome — they always are, since that is all it does.
  if (usage.naming === 'retired') return usage.calls > 0 ? 'retired' : null;
  if (usage.calls > 0) return usage.refused === usage.calls ? 'always-refused' : null;
  if (usage.channel === 'desktop') return 'desktop-unused';
  return usage.namedInAddendum || usage.namedInPrompts > 0 ? 'named-never-called' : 'never-named';
}

/**
 * `toolsCalled` counts the **advertised** names called, because it is drawn over
 * `toolsAdvertised` as a fraction. Calls carry whatever name the model reached
 * for — a retired one, or one that never existed — and counting those here put
 * the numerator above its denominator on the deployment the reading is for.
 * Retired names are counted once, on the totals; an unknown name is a naming
 * class of its own.
 */
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
  fleetCalls: readonly McpCall[],
): McpPhaseUsage[] {
  const runs = new Map<SpendPhase, number>();
  const silent = new Map<SpendPhase, number>();
  for (const agent of settled) {
    const phase = phaseOf(tasksById.get(agent.taskId)?.originRef ?? null);
    runs.set(phase, (runs.get(phase) ?? 0) + 1);
    if ((callsByAgent.get(agent.id) ?? 0) === 0) silent.set(phase, (silent.get(phase) ?? 0) + 1);
  }
  // Off the call's **own** origin rather than its agent's task as it stands now:
  // the ref was copied onto the row at call time for exactly this, so a task
  // retargeted since does not silently re-file every call it ever made.
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
  // A call to a name that is neither live nor retired belongs to no `tools` row,
  // so without a class of its own its traffic is in the total and in none of the
  // shares — the by-task-type table's remainder, unstated. Stated instead, since
  // a prompt naming a tool that has never existed is itself the finding.
  const known = new Set(tools.filter((t) => t.channel === 'fleet').map((t) => t.tool));
  const unknown = fleetCalls.filter((c) => !known.has(c.tool));
  return (
    classes
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
      // A retired name nothing has called does not earn a row: it is the expected
      // state, and drawing it would put a permanent zero beside two real readings.
      // Same for a name nothing has ever reached for, which is every deployment.
      .filter((row) => (row.naming !== 'retired' && row.naming !== 'unknown') || row.tools > 0)
  );
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

/** The earliest datum the timeline can start from, for an unbounded window. */
function earliestOf(input: McpInsightsInput): number | null {
  const first = input.calls[0];
  return first === undefined ? null : Date.parse(first.createdAt);
}

function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Two decimals, which is the resolution every rate on this page is drawn at. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
