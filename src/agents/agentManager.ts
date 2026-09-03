import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import { recentOutputExcerpt } from '../escalation/context.js';
import type { WhitelistRule } from '../config.js';
import type {
  AccountRateLimits,
  Agent,
  AgentAsk,
  AgentFlag,
  AgentStatus,
  AgentUsage,
  HumanTask,
  HumanTaskInput,
  IssueConclusion,
  IssueConclusionVerdict,
  KnowledgeFact,
  KnowledgeGraduation,
  ObstacleBlock,
  PartOutcomeKind,
  PlanPart,
  Remedy,
  PadDecision,
  ScratchEntry,
  ShortfallCause,
  StallPark,
  Task,
  BugFiling,
} from '../types.js';

/**
 * What `link_ticket` settled. A filing job is created for a finding *or* for a bug
 * an operator raised — never both, so the arms are exclusive — kept as a union
 * rather than two nullable fields so a caller cannot read the one that was not
 * filled.
 */
type LinkTicketResult =
  | { ok: true; graduation: KnowledgeGraduation; bug?: undefined }
  | { ok: true; bug: BugFiling; graduation?: undefined }
  | { ok: false; error: string };

/**
 * Which filing a credential resolves to, and — for a bug — the story it must end up
 * related to. The harness reads this before it creates the item, so neither the
 * work item type nor the relation is ever an argument an agent could get wrong.
 */
type FilingTargetResult =
  | { ok: true; kind: 'claim' | 'bug'; storyNumber: number | null }
  | { ok: false; error: string };
import { conclusionOrigin } from '../issueConclusion.js';
import { assessmentOrigin, type AssessmentVerdict } from '../mcp/assessment.js';
import { appraiserOrigin, type GoalAppraisalVerdictName } from '../mcp/goalAppraisal.js';
import { plannerOrigin } from '../mcp/planNotNeeded.js';
import { goalFingerprint } from '../intake/appraisal.js';
import { padWriteTarget } from '../scratch/pad.js';
import { retroSubmitOrigin } from '../retro/retro.js';
import { featureSummarySubmitOrigin, type FeatureSummaryInput } from '../summaries/featureSummary.js';
import { remedyOrigin, type RemedySubmission } from '../remedies/remedies.js';
import {
  corroborationGoal,
  distinctCorroborators,
  type FactContradiction,
  type FactProposal,
} from '../knowledge/knowledge.js';
import type { AnsweredFact } from '../mcp/tools/context.js';
import type { FactAgreementOutcome, FactContradictionOutcome, FactProposalOutcome } from '../store/knowledge.js';
import { partConclusionOrigin } from '../mcp/partOutcome.js';
import type { AgentToolTarget } from '../mcp/tools/context.js';
import type { ParsedFlag } from './sentinels.js';
import { classifyArtifact, type FileEventRecord, type FileEventsSpool } from './fileEvents.js';
import { PLAN_FILE, isPlanFile, parsePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument } from '../plans/planIngest.js';
import type { WatchDryRunner } from '../environments/watchDryRun.js';
import { issueOrigin, planOriginIssue } from '../plans/planning.js';
import { liveParts } from '../plans/parts.js';
import type { AgentSession, SessionFactory } from './session.js';
import { STALL_NUDGE, silenceReason, stallReason } from './agentProtocol.js';
import { HUMAN_BLOCK, renderBlocks } from './streamTranscript.js';
import type { RateLimitPark } from './streamJsonSession.js';
import { debugEnabled, debugLog } from '../debug.js';

/**
 * The MCP tool channel, as {@link AgentManager} needs it. Narrow by design: the
 * manager mints a credential per launch and hands it back when the agent leaves
 * the fleet, and knows nothing about sockets or the tool surface.
 */
interface McpChannel {
  /** Mint a per-launch credential. `configPath` is null when tools can't be wired. */
  open(): { token: string; configPath: string | null };
  /** Complete the credential's identity once the agent row exists. */
  bind(token: string, agentId: string): void;
  /** Revoke a credential and drop its launch config. */
  release(token: string): void;
}

interface AgentManagerOptions {
  command: string;
  /**
   * Builds the argv for a launch. `sessionId` is the id the agent runs under and
   * `resume` re-attaches to it (`claude --resume`) instead of starting fresh.
   * `mcpConfigPath` wires that launch's tool channel, or is null for none.
   * `model` and `effort` are the task's resolved `--model` / `--effort` values,
   * either null to pass no flag.
   * Runtimes that don't support session ids (mock/stream) ignore the first two.
   */
  buildArgs: (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    model: string | null;
    effort: string | null;
  }) => string[];
  /**
   * What a goal's work runs on today, for the one decision `recordAppraisal` has to
   * make about a proposal (issue #342).
   *
   * A function rather than the config, so the manager stays as ignorant of
   * labels, profiles and precedence as it is of rules — it asks one question and
   * gets one name. Unset (every runtime with no `agentModels`, and the tests that
   * do not care) means no proposal is ever stored and no gate can ever hold.
   */
  goalProfile?: {
    /** The profile `issue:<n>`'s work would run on now: its tag, or the configured default. */
    effective: (issueOrigin: string) => string | null;
  };
  /**
   * Where a Feature's children stand *now*, as `featureStandingKey` digests it —
   * what a summary is stamped with when it lands.
   *
   * A function rather than the mirror, for `goalProfile`'s reason: the manager
   * asks one question and gets one string, and stays as ignorant of container
   * types, watch labels and environments as it is of rules.
   *
   * **Read at submission and never at dispatch**, which is the whole of why it is
   * a callback at all. A key stamped when the agent was launched would record
   * where the Feature stood before the run, so anything that moved *during* it
   * would match the stored key for ever after and the Feature would never be
   * summarised again — silently, and indistinguishably from a Feature at rest.
   *
   * Unset (every deployment with no feature board, and the tests that do not care)
   * stamps an empty key. Nothing dispatches a summariser on such a deployment, so
   * the row is only ever reachable there by a caller that hand-built the origin.
   */
  featureStanding?: (featureOrigin: string) => string | null;
  whitelistedApprovals: WhitelistRule[];
  /** Builds the underlying runtime (PTY or stream-JSON) for a launch spec. */
  createSession: SessionFactory;
  /**
   * If set, the string it returns is delivered to the session as the first
   * message once the process has had `promptDelayMs` to boot. Used to hand a
   * real `claude` agent its task. Return null to send nothing (e.g. the mock
   * agent, which reads its prompt from the environment).
   */
  initialInput?: (task: Task) => string | null;
  /**
   * Message nudging a *resumed* agent to continue. Delivered only when re-attaching
   * an agent that was mid-work (not parked on a question) — `--resume` re-opens the
   * session idle and awaiting input. Null to send nothing.
   */
  resumeInput?: () => string | null;
  /** Delay before sending the initial input, giving an interactive CLI time to start. */
  promptDelayMs?: number;
  /** Extra literal substrings a PTY session treats as "waiting for input". */
  waitingPatterns?: string[];
  /**
   * `agentStallNudges` — how many times an agent that ends a turn with no sentinel
   * in it is asked to account for itself before the stop is put to a human.
   *
   * Unset or 0 restores the behaviour this replaced: the first unannounced stop
   * parks the agent and files an escalation.
   */
  stallNudges?: number;
  /**
   * `agentStallParkMs` — how long an unannounced stop stands parked in front of a
   * person before the harness settles it `done` itself. Unset or 0 means it stands
   * until somebody acts on it, which is the behaviour this replaced.
   */
  stallParkMs?: number;
  /** `agentStallExtendMs` — what one press of Extend adds to that countdown. */
  stallExtendMs?: number;
  /**
   * `agentSilenceParkMs` — how long a stream agent may produce nothing at all
   * before the runtime calls it silent. Unset or 0 means it never does, which is
   * the behaviour this replaced.
   *
   * Held here as well as in the session because it is the *grace* a silence park
   * re-arms on: an agent that goes quiet for this long has proved that this is
   * longer than its work takes between words, so it is the honest amount of rope to
   * give it back when it speaks again (see {@link StallClock}).
   */
  silenceParkMs?: number;
  /**
   * Whether this runtime can capture a session id and be resumed after a restart.
   * True only for the interactive PTY `claude`; the mock and stream runtimes leave
   * agents without a session id, so boot reconciliation falls back to interrupting.
   */
  resumable?: boolean;
  /**
   * `agentResumeAttempts` — how many times a live agent whose process dies mid-run
   * is re-attached before it is settled as failed. Unset or 0 means a mid-run death
   * is terminal, which is also what every unresumable runtime gets regardless.
   */
  resumeAttempts?: number;
  /**
   * Spool for the file-events `PostToolUse` hook. When set, each launch gets a
   * per-agent dir exported as `$LUBBDUBB_EVENTS_DIR`; the hook drops written
   * paths there and {@link AgentManager.drainFileEvents} folds them into the
   * files list / artifact chips. Unset (mock runtime) → no capture.
   */
  fileEvents?: FileEventsSpool;
  /** Folder(s) whose files are promoted to artifacts (any extension); relative or absolute. See {@link classifyArtifact}. */
  docsFolderPrefix?: string | string[];
  /**
   * The typed tool channel (issue #108). When set, each launch gets its own
   * credential and `--mcp-config`; unset leaves agents on the sentinels alone,
   * which is a supported configuration, not a degraded one.
   */
  mcp?: McpChannel;
  /**
   * The post-deploy watch's dry run, for a plan that arrived as a *file*.
   *
   * The tool transport can hand a refusal straight back to its author; this one
   * cannot — the write is a hook draining a file, with nobody left to answer. So
   * the reading is taken and stored anyway, because the plan sheet is where an
   * operator reads it either way, and a plan submitted through the file path
   * would otherwise draw a watch nothing has ever put to an environment.
   */
  watch?: WatchDryRunner;
  /** Central error sink: agent failures (spawn errors, crashes + exit codes) are recorded here. */
  errors?: ErrorRecorder;
}

/**
 * A usage-limit park this process is holding: the sentence an operator reads, and
 * the moment the account works again — null when `claude` did not say, which is a
 * park only a human can end.
 */
interface LimitPark {
  reason: string;
  /** ISO, from the `rate_limit_event`'s own `resetsAt`. */
  resetsAt: string | null;
}

/**
 * The countdown on a park that settles itself — one per entry in
 * {@link AgentManager.stalled}.
 *
 * Two numbers rather than one because two different parties push the deadline, and
 * they are claims about different clocks. `at` is when the harness settles the
 * agent unless somebody says otherwise, which the operator moves with Extend. The
 * `grace` is what the *agent* moves it by, by doing something: a parked agent that
 * makes a tool call is working, and buying it back this much is what stops the
 * countdown finishing an agent under its own hands. For a silence park that is the
 * agent's own silence window, which it has just proved is shorter than its work
 * goes between words; for an unannounced stop the two are the same number.
 */
interface StallClock {
  at: number;
  grace: number;
}

/**
 * Who reached a terminal. `agent` is the sentinel or a clean exit, `operator` is
 * the cockpit's "Mark work done", and `expiry` is a stall park whose countdown ran
 * out with nobody having said otherwise ({@link AgentManager.completeExpiredStalls}).
 * They record identically — the run really did finish — and are told apart only
 * where the *provenance* matters: the dismissal wording on the escalation the park
 * left open, and the audit row.
 */
type TerminalBy = 'agent' | 'operator' | 'expiry';

/** A park whose window turned over but which could not be resumed. */
export interface LimitResumeFailure {
  agentId: string;
  error: string;
}

interface AgentManagerEvents {
  output: [{ agentId: string; delta: string }];
  /** `ask` is present only when the park came through the `escalate` tool, which can carry structure. */
  waiting: [{ agentId: string; taskId: string; reason: string; ask?: AgentAsk }];
  autoAnswered: [{ agentId: string; taskId: string; reason: string; response: string }];
  /**
   * `by` distinguishes the agent declaring itself finished (a sentinel, a clean
   * exit) from one declared so through {@link AgentManager.complete} — by an
   * operator's click, or by a stall park's countdown running out. The record is
   * identical for all three — that is the point — but the latter two leave an
   * escalation nobody can answer, so the composition root needs to tell them apart
   * to dismiss it, and to say which of them did it.
   */
  done: [{ agentId: string; taskId: string; status: AgentStatus; by: TerminalBy }];
  /**
   * The agent finished (done/failed) *and* its OS process has actually exited —
   * the two arrive in either order (PTY: sentinel first, exit later; stream:
   * exit first). Only now is it safe to touch resources the process pinned,
   * e.g. removing its worktree cwd.
   */
  reaped: [{ agentId: string; taskId: string; status: 'done' | 'failed' | 'killed' }];
  status: [{ agentId: string; taskId: string; status: AgentStatus }];
  usage: [{ agentId: string; taskId: string; usage: AgentUsage }];
  /** The agent surfaced an artifact/link mid-run (already persisted, deduped by ref). */
  flag: [{ agentId: string; taskId: string; flag: AgentFlag }];
  /** The agent filed something outside its own task (already persisted). `created` is false for a verbatim repeat. */
  /** The agent asked for work only a person can do (already persisted). `created` is false for a repeat. */
  humanTask: [{ agentId: string; taskId: string; humanTask: HumanTask; created: boolean }];
  /** The agent said what it is working on (already persisted onto its row, replacing the previous note). */
  progress: [{ agentId: string; taskId: string; note: string; notedAt: string }];
  /** The agent said whether its issue is finished (already persisted against the issue origin). */
  conclusion: [{ agentId: string; taskId: string; conclusion: IssueConclusion }];
  assessment: [{ agentId: string; taskId: string; issueOrigin: string; verdict: AssessmentVerdict }];
  /** The appraiser said whether its issue's goal can be worked from (already persisted against the issue origin). */
  appraisal: [{ agentId: string; taskId: string; issueOrigin: string; verdict: GoalAppraisalVerdictName }];
  /** A planner found its issue's goal already met (already persisted as a delivery verdict). */
  goalMet: [{ agentId: string; taskId: string; issueOrigin: string }];
  /** The agent closed its plan part without a pull request (already persisted on the part row). */
  partOutcome: [{ agentId: string; taskId: string; part: PlanPart }];
  /** The agent left a note on its issue's shared pad (already persisted, append-only). */
  scratch: [{ agentId: string; taskId: string; entry: ScratchEntry }];
  /** The retrospective for a delivered goal was written (already persisted against the issue origin). */
  retrospective: [{ agentId: string; taskId: string; issueOrigin: string }];
  /**
   * An agent accounted for why it had to come back to a pull request (already
   * persisted, along with any lesson it proposed). Nothing schedules off this —
   * it is the repaint, so the Causes reading and the lessons list are current the
   * moment the account lands rather than on the next pulse.
   */
  remedy: [{ agentId: string; taskId: string; originRef: string }];
  /**
   * An agent wrote down what it learned about working this repository, or agreed
   * with something already written (already persisted). `filed` is false when the
   * call landed as a corroboration on a standing claim rather than as a new one.
   *
   * Nothing schedules off this — no rule, desk or gate reads a fact. It is the
   * repaint, so the Knowledge page hears a proposal the moment it is filed rather
   * than on the next pulse, exactly as `finding` and `remedy` do.
   */
  fact: [{ agentId: string; taskId: string; fact: KnowledgeFact; filed: boolean; corroborations: number }];
  /** The file-events hook recorded one or more written files (the "files changed" list grew). */
  files: [{ agentId: string; taskId: string }];
  /**
   * A parked agent was seen making a tool call — i.e. it carried on working rather
   * than waiting, so the open alert against it is probably stale. Already persisted
   * as `Agent.resumedAt`; emitted so the cockpit learns now rather than next poll.
   */
  resumed: [{ agentId: string; taskId: string; resumedAt: string }];
  /**
   * The account's usage limit ran out under this agent, so it is parked rather than
   * failed (issue #318). Already persisted as `waiting` with `reason` on the row;
   * emitted so a listener hears the *cause*, which the row alone only spells out in
   * prose. `resetsAt` is null when `claude` did not say when the window turns over.
   */
  limited: [{ agentId: string; taskId: string; reason: string; resetsAt: string | null }];
}

/**
 * What a retrospective's claim carries as its observation.
 *
 * A retrospective has no separate evidence to give — the write-up beside it *is*
 * the evidence — so the corroboration says where the claim came from instead,
 * which is what an operator reads when deciding whether one voice should have been
 * two. Stated once for the reason the operator's own sentence is: two rows in one
 * table have to be comparable, and a sentence composed at the call site is free to
 * say something else next time.
 */
const RETRO_EVIDENCE = 'Written up in the retrospective for this goal, as something working it taught.';

/**
 * A retrospective's claim as a proposal.
 *
 * Fleet-scoped and standing because that is what a write-up's lesson is: something
 * working *this repository* taught, with no scope and no clock the retrospective
 * ever had to give. `report_remedy` builds its own in `validateRemedy`, where the
 * knowledge store's bounds can refuse before anything is written; this one has
 * nothing to refuse that `validateClaimText` has not already refused inside
 * `parseRetro`.
 */
function retroClaim(claim: string): FactProposal {
  return {
    claim,
    scope: 'fleet',
    lifetime: 'standing',
    expiresInHours: null,
    evidence: RETRO_EVIDENCE,
    supersedes: null,
    resolvesWhen: null,
    aboutRef: null,
    where: null,
  };
}

/**
 * Owns the fleet of live PTY agent sessions: spawn, stream, detect
 * waiting/done, feed input, kill. It maps {@link PtySession} events onto store
 * updates and re-emits them for the server to broadcast. Whitelisted waiting
 * prompts are auto-answered here; everything else surfaces as a `waiting` event
 * for the harness to escalate.
 *
 * The `implements AgentToolTarget` is load-bearing: it is what makes the
 * tool-facing methods below a *checked* contract rather than a set of
 * coincidences.
 * Satisfying it structurally meant a method could be renamed, or the interface
 * grown, with nothing failing — `withCaller`'s own argument, one level up. The
 * clause costs a `import type` and nothing else: it is erased at compile time, and
 * the runtime edge it would notionally create already runs this way round (this
 * file value-imports `assessmentOrigin`, `appraiserOrigin`, `plannerOrigin` and `partConclusionOrigin`
 * from `src/mcp/`, while `src/mcp/` reaches back only for types).
 */
export class AgentManager extends EventEmitter implements AgentToolTarget {
  private readonly sessions = new Map<string, AgentSession>();
  // Exit code per agent, captured from the session's `exit` event so a `failed`
  // terminal can be recorded with its cause (the code arrives before `failed`).
  private readonly exitCodes = new Map<string, number>();
  // The two halves of a 'reaped' emission: terminal status recorded vs process
  // exit observed. Their order differs per runtime, so track both.
  private readonly terminals = new Map<string, 'done' | 'failed' | 'killed'>();
  private readonly exited = new Set<string>();
  // agentId → its file-events spool key, so we can drain (and later dispose) the
  // dir the hook writes to. Present only when a spool is wired and the launch got one.
  private readonly eventsKeys = new Map<string, string>();
  // agentId → its MCP credential, revoked when the agent leaves the fleet.
  private readonly mcpTokens = new Map<string, string>();
  // Agents currently parked on a human. The convergence latch for the two ways an
  // agent can ask: the `escalate` tool and the WAITING sentinel are two detectors
  // of one transition, so whichever arrives first owns it and the second is a
  // no-op until the park is released. Same discipline as `noteSentinel`'s two PTY
  // detectors, and for the same reason — two detectors that quietly disagree is a
  // bug this codebase has already paid for once.
  private readonly parked = new Set<string>();
  // agentId → the park it is held on for a *spent account limit* rather than for a
  // question (issue #318). A subset of `parked` with a different ending: nobody can
  // answer it, so the way out is {@link resumeParked}, not a reply. In memory
  // because it describes a park this process is holding — a restart hands the same
  // rows to the recovery desk, which asks the operator the wider question.
  //
  // The reset time is kept as a *value* beside the sentence it is also printed in:
  // {@link resumeExpiredParks} is the one reader that has to compare it to the
  // clock, and re-parsing it back out of an operator-facing sentence would make the
  // wording load-bearing.
  private readonly limited = new Map<string, LimitPark>();
  // agentId → how many stall nudges it has been sent (see {@link handleStalled}).
  // A whole-life budget rather than a per-stop one, and deliberately the blunter of
  // the two: a counter reset by intervening work reads better and has no ceiling,
  // so an agent that does one tool call between every stop would be nudged for as
  // long as it cared to keep doing that, spending tokens with nothing to show and
  // nobody told. In memory because it describes this launch's conversation; a
  // resume starts the budget over, which is the same fresh start the agent gets.
  private readonly nudges = new Map<string, number>();
  // agentId -> when its *unannounced-stop* park settles itself as done, epoch ms.
  // A subset of `parked` with a third kind of ending, beside a limit park's window
  // turning over and a question park's answer: nobody has to do anything, and if
  // nobody does, the stop is read as the finish it almost always is.
  //
  // Two parks are entered here and they are not the same observation — a stop the
  // nudges could not settle ({@link handleStalled}), and a session that has said
  // nothing at all for `agentSilenceParkMs` ({@link handleSilent}) — but they have
  // the same ending, and the ending is the whole of what this map is for.
  // Only a stop the nudges could not settle is entered here. A park an agent asked
  // for — the `escalate` tool, the WAITING sentinel — is a real question, and a
  // question that answers itself after five minutes is worse than no question at
  // all. In memory for `limited`'s reason: it describes a park *this process* is
  // holding, and a restart hands the same rows to the recovery desk instead.
  //
  // The exclusion holds however the two arrive in order, and that is not a detail:
  // arming reads the other latches, and every path that *ends* a stop drops the
  // clock with it — `respond`, `releasePark`, `handleLimited`, `resumeParked` — with
  // `completeExpiredStalls` re-checking `limited` as the backstop. Entered-once-then-
  // never-rechecked is the shape that settles a limit park, and a resumed agent, as
  // `done`.
  private readonly stalled = new Map<string, StallClock>();

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
  ) {
    super();
  }

  /**
   * Spawn an agent for a task in the given working directory.
   *
   * `resumeSessionId` re-dispatches an origin **into the conversation its last
   * agent had** instead of a cold one (issue #333), so attempt two does not re-read
   * the repository and `CLAUDE.md` to re-derive what attempt one already worked
   * out. Ignored by a runtime that cannot resume, which is what makes it safe to
   * pass unconditionally: the caller reads the returned row's `sessionId` to learn
   * whether the re-attach actually happened.
   *
   * **This is a spawn, not {@link AgentManager.resume}, and the difference is the
   * whole reason it is here.** `resume` reuses the agent row, so its in-memory maps
   * are already occupied and a caller must tear the dead launch down first or leak
   * a spool dir and leave an MCP bearer token bound with nothing to revoke it. A
   * retry gets a *new* agent row — `sessions`, `eventsKeys` and `mcpTokens` are all
   * keyed by agent id, so there is nothing to write over and nothing to tear down.
   * The previous agent's teardown already ran when it was reaped.
   *
   * Two rows then share one `sessionId`, which is correct: `--resume` appends to
   * that transcript rather than forking a new id (see `buildClaudeStreamArgs`), so
   * the id names the conversation and the rows name the attempts that spoke into
   * it. Nothing keys on the id being unique per agent — `isRecoveryCandidate` gates
   * on the *task* being outstanding, and attempt one's is settled by the time this
   * runs.
   */
  spawn(task: Task, cwd: string, resumeSessionId?: string | null): Agent {
    // A runtime that cannot resume has no conversation to inherit, so it falls back
    // to a cold launch rather than refusing the dispatch.
    const inherited = this.opts.resumable ? (resumeSessionId ?? null) : null;
    // Choose the session id up front so we own it and can `--resume` this exact
    // conversation after a restart. Only resumable runtimes get one. A retry takes
    // the previous agent's id instead of minting one — the one path where this is
    // not a fresh conversation.
    const sessionId = inherited ?? (this.opts.resumable ? randomUUID() : null);
    // The file-events spool key is independent of the resume session id, so stream
    // agents (no session id) still get one. Minted before the session so the env
    // carries it; mapped to the agent id below for draining.
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    // Minted before the session so the launch config exists to point `--mcp-config`
    // at, and bound to the agent row the moment it exists. Nothing can call a tool
    // in between: `createSession` only builds the session, `start()` is below.
    const mcp = this.opts.mcp?.open() ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: sessionId ?? '',
        // `--resume` on an inherited id, `--session-id` on a minted one, and never
        // both — `appendSessionFlags` owns that choice, and `claude` exits 1 with no
        // stream event at all if a pinned id already has a transcript.
        resume: inherited !== null,
        mcpConfigPath: mcp?.configPath ?? null,
        // Decided at dispatch and stored on the row, so this forwards two strings
        // and never re-derives either from config.
        model: task.model ?? null,
        effort: task.effort ?? null,
      }),
      cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.eventsDirEnv(eventsKey),
      },
      waitingPatterns: this.opts.waitingPatterns,
      sessionId,
      resume: inherited !== null,
    });

    const agent = this.store.createAgent({ taskId: task.id, cwd, pid: null, status: 'starting', sessionId });
    if (eventsKey) this.eventsKeys.set(agent.id, eventsKey);
    if (mcp) {
      this.opts.mcp?.bind(mcp.token, agent.id);
      this.mcpTokens.set(agent.id, mcp.token);
    }
    debugLog(
      'agent',
      `spawn agent=${agent.id} cwd=${cwd} eventsDir=${this.fileEventsDir(agent.id) ?? '<file-events off>'}` +
        `${inherited ? ` resumed=${inherited}` : ''}`,
    );
    this.store.updateTask(task.id, { status: 'running', agentId: agent.id });
    this.sessions.set(agent.id, session);
    this.wireSession(session, agent.id, task);
    try {
      session.start();
    } catch (err) {
      // A synchronous spawn failure (e.g. the claude command can't be resolved)
      // must not leave a half-created agent stuck in `starting`. Tear it down and
      // record the reason on the transcript, then rethrow so the executor surfaces
      // it as a rejected dispatch instead of a mystery `failed` agent.
      this.failSpawn(agent.id, task.id, err as Error);
      throw err;
    }

    // Hand the agent its task. For a real `claude` REPL this is typed in after a
    // short boot delay; the mock agent takes its prompt from the environment and
    // opts out by returning null.
    this.deliverAfterBoot(agent.id, session, this.opts.initialInput?.(task) ?? null);

    return agent;
  }

  /**
   * Re-attach to an agent orphaned by a server restart, continuing its Claude
   * session in the same worktree rather than starting over. Reuses the existing
   * agent row, session id and cwd — no new agent is created. Best-effort: returns
   * false (caller falls back to interrupting) if the runtime can't resume or the
   * agent has no session id. Idempotent: a no-op if the agent is already live.
   *
   * `nudge` overrides the message a mid-work agent is restarted with. Boot passes
   * nothing and gets `resumeInput`'s "you were resumed after a server restart",
   * which is the truth there and a lie to an agent resumed off a usage-limit park
   * — see {@link resumeParked}.
   */
  resume(agent: Agent, task: Task, nudge?: string): boolean {
    if (!this.opts.resumable || !agent.sessionId) return false;
    if (this.sessions.has(agent.id)) return true;

    // `waitingReason` survives the restart and tells us whether the agent was
    // parked on a human question (keep it waiting) or mid-work (nudge it on).
    const wasWaiting = agent.status === 'waiting' || agent.waitingReason != null;
    // A restart wiped the old spool, so mint a fresh key for the resumed session.
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    // A restart revoked the old credential with the process that held it, so a
    // resume mints a fresh one — same agent row, same identity, new bearer token.
    const mcp = this.opts.mcp?.open() ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: agent.sessionId,
        resume: true,
        mcpConfigPath: mcp?.configPath ?? null,
        // The stored values, which is why a restart cannot move a half-finished
        // conversation onto a different model or a different depth.
        model: task.model ?? null,
        effort: task.effort ?? null,
      }),
      cwd: agent.cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.eventsDirEnv(eventsKey),
      },
      waitingPatterns: this.opts.waitingPatterns,
      sessionId: agent.sessionId,
      resume: true,
    });
    if (eventsKey) this.eventsKeys.set(agent.id, eventsKey);
    if (mcp) {
      this.opts.mcp?.bind(mcp.token, agent.id);
      this.mcpTokens.set(agent.id, mcp.token);
    }
    debugLog(
      'agent',
      `resume agent=${agent.id} cwd=${agent.cwd} eventsDir=${this.fileEventsDir(agent.id) ?? '<file-events off>'}`,
    );

    this.sessions.set(agent.id, session);
    // The row goes live again, shedding the death markers from the last run.
    this.store.updateAgent(agent.id, { status: 'running', pid: null, endedAt: null, waitingReason: null });
    this.store.updateTask(task.id, { status: 'running' });
    this.wireSession(session, agent.id, task);
    try {
      session.start();
    } catch (err) {
      // Resume is best-effort; a spawn failure here just drops the session so the
      // boot reconciler falls back to marking the agent interrupted.
      this.sessions.delete(agent.id);
      throw new Error(`resume spawn failed for agent ${agent.id}: ${(err as Error).message}`);
    }

    if (wasWaiting) {
      this.restoreWaiting(agent, task);
    } else {
      const carryOn = nudge ?? this.opts.resumeInput?.() ?? null;
      // Echoed, unlike a fresh dispatch's prompt: this is a short sentence telling a
      // conversation the operator has already been reading to carry on, and a
      // transcript that resumed with the agent answering it unasked is the gap
      // {@link noteSent} exists to close.
      if (carryOn !== null) this.noteSent(agent.id, session, carryOn);
      this.deliverAfterBoot(agent.id, session, carryOn);
    }

    return true;
  }

  /**
   * End a usage-limit park: the account can work again (issue #318).
   *
   * Two callers, one path. {@link resumeExpiredParks} calls it off the pulse once the
   * window `claude` named has turned over, and the cockpit's Resume calls it when an
   * operator says so — for a park that carries no reset time, or ahead of one that
   * does. Both are the same claim about the account, so both get the same guards, the
   * same teardown and the same message; a second way in is how the two would drift.
   *
   * Two shapes of the same park, because exhaustion does not always kill the
   * process. If the session is still up, this is one message down the stdin that
   * is already open. If `claude` exited with the limit — the common case — the
   * conversation is re-opened through {@link resume}, which is why the park keeps
   * the row's `session_id` and its worktree rather than settling anything.
   *
   * Only an agent *this process* parked on a limit is a candidate. A park held
   * across a restart is the recovery desk's question, not this one: the desk
   * offers restore/requeue/remove over a wider choice than "carry on", and two
   * surfaces resuming one row would race for its session id.
   *
   * The park is put back on any failure, so a refused resume leaves the operator
   * where they were rather than with an agent that is neither parked nor running.
   */
  resumeParked(agentId: string): { ok: true } | { ok: false; error: string } {
    const park = this.limited.get(agentId);
    if (park === undefined) return { ok: false, error: 'this agent is not parked on a usage limit' };
    return this.withCaller(agentId, ({ agent, task }) => {
      const session = this.sessions.get(agentId);
      if (!session && (!this.opts.resumable || !agent.sessionId)) {
        return { ok: false, error: 'this agent runtime cannot re-open its session, so the park cannot be ended' };
      }
      this.limited.delete(agentId);
      this.parked.delete(agentId);
      // `respond`'s reason: it is working again, so there is no unanswered stop left
      // for a clock to settle. Without this the resumed agent is killed mid-turn.
      this.stalled.delete(agentId);
      this.store.setAgentResumed(agentId, null);
      // Cleared before either arm: `resume` reads the row to decide whether the agent
      // was parked on a *question* (which it re-establishes), and this park is
      // precisely the one it must not put back.
      this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
      this.store.updateTask(task.id, { status: 'running' });

      if (session) {
        this.noteSent(agentId, session, LIMIT_RESUME_MESSAGE);
        session.send(LIMIT_RESUME_MESSAGE);
        this.reflectStatus(agentId, task.id, 'running');
        return { ok: true };
      }

      const row = this.store.getAgent(agentId);
      try {
        if (!row || !this.resume(row, task, LIMIT_RESUME_MESSAGE)) throw new Error('the runtime declined the resume');
      } catch (err) {
        this.reinstateLimitPark(agentId, task, park);
        return { ok: false, error: `could not re-open the session: ${(err as Error).message}` };
      }
      return { ok: true };
    });
  }

  /**
   * End every park whose window has already turned over — the harness noticing for
   * itself what an operator otherwise had to come back and press.
   *
   * A usage-limit park is the one park with a **known end**: nobody has to decide
   * anything, and `claude` says on the way out when the account works again. Waiting
   * for a human to observe a clock is the whole of what this removes, and it removes
   * nothing else — every guard on {@link resumeParked} still applies, because this is
   * that call and not a second way in.
   *
   * **A park `claude` gave no `resetsAt` for is left alone, permanently.** There is no
   * moment to wait for, and picking one (an hour? five?) would be the harness guessing
   * at another service's accounting and waking an agent into an account still spent —
   * which costs a launch, a fresh MCP credential and a turn, and re-parks. The operator's
   * Resume stays the way out of those, so it is still a real button and not a vestige.
   *
   * **No headroom check, deliberately.** `countLiveAgents` counts `waiting`, so a parked
   * agent has held its slot the whole time it was parked; resuming it changes no count
   * and can crowd out nothing. The cap was already paid when it was dispatched.
   *
   * Returns the parks it *could not* end, for the caller to record — a resume that
   * fails puts the park back (see {@link resumeParked}), so the next pulse retries and
   * a permanently broken one would otherwise retry in silence forever.
   */
  resumeExpiredParks(): LimitResumeFailure[] {
    const now = Date.now();
    const failures: LimitResumeFailure[] = [];
    // Copied before iterating: `resumeParked` deletes from the map it walks.
    for (const [agentId, park] of [...this.limited]) {
      if (!park.resetsAt) continue;
      const resetsAt = Date.parse(park.resetsAt);
      // An unparseable time is a park with no clock, and takes the no-`resetsAt` arm:
      // this is someone else's wire format, and a reading we cannot compare is not a
      // reading that the window has turned over.
      if (!Number.isFinite(resetsAt) || resetsAt > now) continue;
      debugLog('agent', `limit park expired agent=${agentId} resetsAt=${park.resetsAt}`);
      const result = this.resumeParked(agentId);
      if (!result.ok) failures.push({ agentId, error: result.error });
    }
    return failures;
  }

  /** Every agent this process is holding parked on a spent account limit. */
  limitedAgentIds(): string[] {
    return [...this.limited.keys()];
  }

  /**
   * Every unannounced-stop park this process is holding, and when each settles
   * itself — what the cockpit draws the countdown from.
   *
   * Asked of the fleet rather than derived from the rows, for `limitedAgentIds`'
   * reason: all three parks are `waiting` with a sentence on the row, and a cockpit
   * that told them apart by reading the sentence would be one wording change away
   * from putting a countdown on a question nobody is counting down.
   */
  stallDeadlines(): StallPark[] {
    return [...this.stalled].map(([agentId, clock]) => ({ agentId, expiresAt: new Date(clock.at).toISOString() }));
  }

  /**
   * "No, wait" — push a stall park's countdown out by `agentStallExtendMs`.
   *
   * From *now* rather than from the deadline, because the operator is making a
   * claim about their own clock ("give me another quarter of an hour to look at
   * this"), not adding time to the agent's. Two presses a minute apart are
   * therefore fifteen minutes from the second, not thirty from the first.
   *
   * Only a park that is actually counting can be extended: an agent that has since
   * been answered, dismissed, killed or finished has no clock, and returning `ok`
   * for one would tell the operator they had bought time on a run that is already
   * over.
   */
  extendStallPark(agentId: string): { ok: true; expiresAt: string } | { ok: false; error: string } {
    const clock = this.stalled.get(agentId);
    if (!clock) return { ok: false, error: 'this agent is not parked on an unannounced stop' };
    const at = Date.now() + (this.opts.stallExtendMs ?? 0);
    // The grace rides through untouched: it is what the *agent* buys back by working,
    // and this is the operator buying time. Two different claims on the same clock.
    clock.at = at;
    const expiresAt = new Date(at).toISOString();
    debugLog('agent', `stall park extended agent=${agentId} until=${expiresAt}`);
    return { ok: true, expiresAt };
  }

  /**
   * Settle every stall park whose countdown has run out — the harness reading an
   * unanswered stop as the finish it almost always was.
   *
   * The sibling of {@link resumeExpiredParks}, and the same shape of act: a park
   * with an ending nobody has to decide, ended off the pulse instead of waiting for
   * a person to come back and press the button they were always going to press. It
   * is not a *verdict* about the work — it is the observation that a stop which
   * survived the nudges and then survived the operator's own window is not one
   * anybody is going to answer, and that leaving it standing costs a live slot and a
   * running agent for as long as nobody looks.
   *
   * **Nothing here is destructive, which is what makes the default safe.**
   * {@link complete} keeps the branch, its commits and its pull request, releases
   * the worktree slot rather than deleting the checkout, and settles the task
   * `done`; if there is more to do, the world says so and the pulse dispatches for
   * it again. The countdown is the operator's window to say otherwise, not the
   * harness's confidence.
   *
   * An agent that is no longer live has already ended some other way — the
   * escalation it left is dismissed by the terminal listeners — so its clock is
   * simply dropped, not an error: there is nothing to settle and nobody to tell.
   *
   * A **limit park** is dropped the same way rather than settled. That park has its
   * own ending and the account will be able to continue the conversation; the two
   * latch writes that clear the clock when the limit arrives already cover it, and
   * this is the backstop that does not depend on a future third park remembering to.
   *
   * Returns the ids it settled, for the caller to log.
   */
  completeExpiredStalls(): string[] {
    const now = Date.now();
    const settled: string[] = [];
    // Copied before iterating: `complete` deletes from the map it walks.
    for (const [agentId, clock] of [...this.stalled]) {
      if (clock.at > now) continue;
      // The backstop the two latch writes above must not be the only thing standing
      // between a limit park and `complete`. A third park added later inherits this
      // rather than needing to remember its own `stalled.delete`.
      if (this.limited.has(agentId)) {
        this.stalled.delete(agentId);
        continue;
      }
      debugLog('agent', `stall park expired agent=${agentId}`);
      if (this.complete(agentId, 'expiry')) settled.push(agentId);
      else this.stalled.delete(agentId);
    }
    return settled;
  }

  /**
   * Write a message *sent to* an agent into its transcript, as the harness or the
   * operator taking a turn in the conversation.
   *
   * **The stream runtime renders only what comes back**, so without this a message
   * typed into an agent leaves no trace at all: the drawer sits unchanged until the
   * agent happens to speak, and the cockpit deliberately does not refetch after an
   * answer — so the operator's only evidence that the answer went anywhere is the
   * agent's eventual reply to a question the pane never showed. The PTY runtime
   * carries both halves in the session file it renders, and says so with
   * {@link AgentSession.recordsSentMessages}; echoing there would double every
   * message.
   *
   * The first message of a dispatch is deliberately *not* echoed: a task prompt is
   * kilobytes, and the transcript is the agent's working record rather than a copy
   * of its brief.
   */
  private noteSent(agentId: string, session: AgentSession, text: string): void {
    if (session.recordsSentMessages) return;
    const note = renderBlocks([{ type: HUMAN_BLOCK, text }], new Date().toISOString());
    if (!note) return;
    this.store.appendTranscript(agentId, note);
    this.emit('output', { agentId, delta: note });
  }

  /**
   * Type a harness message into a live agent, without touching what it is doing.
   *
   * The difference from {@link respond} is everything this does *not* do: no park
   * is ended, no status is moved, no "it carried on anyway" is spent. Those all
   * belong to an **answer** — a human replying to a question the agent asked —
   * and an obstacle notice is not one: it is the harness volunteering something
   * that changed, and an agent parked on an escalation is still parked after it.
   *
   * A parked agent is skipped outright rather than written to. It is waiting on a
   * person, and typing past that would look to the runtime exactly like the
   * answer arriving.
   * → `docs/spec/32-obstacles.md#delivery`
   */
  notify(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session || this.parked.has(agentId)) return false;
    this.noteSent(agentId, session, text);
    try {
      session.send(text);
    } catch {
      return false; // the session went away between the read and the write
    }
    return true;
  }

  /** Type text into a live agent (a human response or a follow-up prompt). */
  respond(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    this.noteSent(agentId, session, text);
    session.send(text);
    this.parked.delete(agentId); // the park is over; the next ask is a new one
    this.limited.delete(agentId); // ...including a limit park an operator typed straight past
    this.stalled.delete(agentId); // ...and a stall park an answer overtook: it is working again
    this.store.setAgentResumed(agentId, null); // answered, so "it carried on anyway" is spent
    this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
    return true;
  }

  /**
   * Resolve the caller a tool call arrived as, and run the call against it.
   *
   * **This is `token -> agent -> task -> origin`, and it is the step the whole
   * tool channel rests on.** No write tool takes an agent, task or issue
   * argument: the credential minted at spawn is what says who is calling, so an
   * agent cannot name itself and therefore cannot address another's work. That
   * guarantee is only as good as the resolution, and the resolution used to be
   * copied into all eleven tool-facing methods below — so it held eleven times by
   * inspection rather than once by construction. A twelfth method written from
   * scratch, or one that dropped the `!task` half because its store call happens
   * to take only an `agentId` (as {@link recordProgress}'s genuinely does), would
   * have inherited nothing and failed nothing.
   *
   * A wrapper rather than a `resolveCaller()` a caller may forget to check: the
   * body **cannot run** without a resolved `{agent, task}` in hand, and the
   * refusal it returns is the same sentence for every tool.
   *
   * It deliberately does **not** check liveness — a finding, a note or a verdict
   * cast on an agent's last breath is still true, and {@link ask} is the one
   * caller that needs a live session, which it tests for itself before asking.
   */
  private withCaller<R extends { ok: true } | { ok: false; error: string }>(
    agentId: string,
    fn: (caller: { agent: Agent; task: Task }) => R,
  ): R | { ok: false; error: string } {
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    return fn({ agent, task });
  }

  /**
   * Park an agent on a human question raised through the `escalate` MCP tool.
   *
   * This is the *same* transition the WAITING sentinel drives — deliberately, and
   * routed through the same {@link handleWaiting} so the whitelist, the drain and
   * the store writes can't diverge between the two. The tool is the richer signal
   * (it carries a kind and options); the sentinel is the one that always works.
   * Whichever fires first parks the agent, and the latch makes the second a no-op,
   * so an agent that calls `escalate` *and* prints the sentinel raises one
   * escalation, not two.
   *
   * Returns the escalation the park produced, or `null` for `escalationId` when an
   * operator whitelist rule auto-answered it and the agent was never parked at all.
   */
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string } {
    if (!this.sessions.has(agentId)) return { ok: false, error: 'agent is no longer live' };
    return this.withCaller(agentId, ({ task }) => {
      const question = ask.question.trim();
      if (!question) return { ok: false, error: 'question must not be empty' };
      this.handleWaiting(agentId, task, question, ask);
      // Listeners are synchronous, so by now the inbox has either created the
      // escalation or the whitelist answered and moved the agent back to running.
      const open = this.store.listOpenEscalations().find((e) => e.agentId === agentId) ?? null;
      return { ok: true, escalationId: open?.id ?? null };
    });
  }

  /**
   * Ask for work only a person can do (the `request_human_task` tool). Routed
   * through the manager for {@link proposeFact}'s reason: the cockpit should
   * hear about it the moment it is filed, and the `humanTask` event is what
   * carries it.
   *
   * Not requiring a live session is deliberate here too, and for a sharper reason
   * than a finding's: the commonest moment to realise a person is needed is the
   * moment an agent is giving up on doing something itself.
   */
  requestHumanTask(
    agentId: string,
    input: HumanTaskInput,
  ): { ok: true; task: HumanTask } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const { task: humanTask, created } = this.store.recordHumanTask({
        ...input,
        agentId,
        taskId: task.id,
        originRef: task.originRef,
      });
      this.emit('humanTask', { agentId, taskId: task.id, humanTask, created });
      return { ok: true, task: humanTask };
    });
  }

  /**
   * What this agent was dispatched to file, resolved from its credential — a
   * finding an agent reported, or a bug an operator raised on a story.
   *
   * Split out of {@link linkTicket} because the harness now *creates* the item
   * (issue #394) and needs to know which of the two arms it is in **before** it
   * files: a bug is created as a different work item type and linked back to its
   * story, and neither fact is the agent's to pass. The credential resolves it —
   * agent → task → the `job:<id>` origin it was dispatched on → the row that job
   * was created for — so there is no id to point at someone else's.
   */
  filingTarget(agentId: string): FilingTargetResult {
    return this.withCaller(agentId, ({ task }): FilingTargetResult => {
      const jobId = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
      const graduation = jobId ? this.store.findGraduationByJobId(jobId) : null;
      if (graduation && graduation.exit === 'ticket') return { ok: true, kind: 'claim', storyNumber: null };
      const bug = jobId ? this.store.findBugFilingByJobId(jobId) : null;
      if (bug) {
        // `issue:12` — the story the operator raised it from, and the one number
        // the create needs so the two ends up related in the tracker.
        const parsed = Number(bug.originRef.replace(/^issue:/, '').split(':')[0]);
        return { ok: true, kind: 'bug', storyNumber: Number.isInteger(parsed) ? parsed : null };
      }
      return {
        ok: false,
        error:
          `link_ticket is only for a job dispatched to file a claim as a ticket or to raise a bug ` +
          `an operator reported. This task's origin is ${task.originRef ?? '(none)'}, which was ` +
          `created from neither.`,
      };
    });
  }

  /**
   * Record the ticket a filing job produced (the `link_ticket` tool): the claim's
   * graduation lands, or the bug it was dispatched for moves `filing -> filed`.
   *
   * The row is reached from the credential exactly as {@link filingTarget} reaches
   * it, so the tool takes only a ref. An agent on any other task resolves to
   * nothing and is told so, which is the whole access check.
   *
   * Routed through the manager for the same reason as {@link proposeFact}: the
   * `finding` event is what repaints the cockpit now rather than next pulse.
   */
  linkTicket(agentId: string, ticketRef: string): LinkTicketResult {
    return this.withCaller(agentId, ({ task }): LinkTicketResult => {
      const jobId = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
      const graduation = jobId ? this.store.findGraduationByJobId(jobId) : null;
      const filing = graduation && graduation.exit === 'ticket' ? graduation : null;
      // A job is created for at most one of the two, so there is nothing to
      // disambiguate — the credential resolves to a filing graduation, a bug
      // filing, or neither, and neither is the whole access check.
      const bug = jobId && !filing ? this.store.findBugFilingByJobId(jobId) : null;
      if (!filing && !bug) {
        return {
          ok: false,
          error:
            `link_ticket is only for a job dispatched to file a claim as a ticket or to raise a bug ` +
            `an operator reported. This task's origin is ${task.originRef ?? '(none)'}, which was ` +
            `created from neither.`,
        };
      }

      if (bug) {
        // A bug is an issue in both trackers the harness reads, and a `pr:` ref here
        // would be a link the cockpit draws as a work item and the tracker knows as
        // something else.
        if (!ticketRef.startsWith('issue:')) {
          return {
            ok: false,
            error: `A bug must be an issue ref like "issue:314"; got "${ticketRef}".`,
          };
        }
        // Idempotence in the write, as in the arm below.
        const linked = this.store.linkBugFiling(bug.jobId, ticketRef);
        if (!linked) {
          return {
            ok: false,
            error: `the bug raised on ${bug.originRef} is ${bug.status}, not awaiting a ticket — nothing to link.`,
          };
        }
        return { ok: true, bug: linked };
      }

      // Idempotence lives in the write, not in a read-then-check here. The same
      // call is what takes the claim to `graduated`: the ticket existing *is* the
      // exit being taken, and the store makes both writes in one transaction.
      const linked = this.store.linkGraduationTicket(filing!.id, ticketRef);
      if (!linked) {
        return {
          ok: false,
          error: `the filing for ${filing!.factId} has already been answered — nothing left to link.`,
        };
      }
      this.emit('fact', {
        agentId,
        taskId: task.id,
        fact: this.store.getFact(linked.factId)!,
        filed: false,
        corroborations: distinctCorroborators(this.store.listCorroborations(linked.factId)),
      });
      return { ok: true, graduation: linked };
    });
  }

  /**
   * Record what an agent says it is working on (the `note_progress` tool). Like
   * {@link proposeFact} it goes through the manager rather than straight to the
   * store, so the cockpit repaints on the note rather than on the next pulse —
   * a note that lands twenty minutes late has already failed at its one job.
   *
   * Also like a finding, this does not require a *live* session: the note is a
   * durable line on the agent's row, and one written on an agent's last breath is
   * the summary of the run.

   */
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const notedAt = this.store.recordAgentNote(agentId, note);
      this.emit('progress', { agentId, taskId: task.id, note, notedAt });
      return { ok: true, notedAt };
    });
  }

  /**
   * Append to the shared pad for the issue this agent is working (the
   * `scratch_append` tool).
   *
   * The pad is resolved from the credential by {@link padWriteTarget} — an agent
   * cannot name it, so it cannot reach another goal's record — and it is refused
   * outright outside an issue's or a pull request's subtree rather than scoped
   * down, because an agent handed a silent success believes its note was recorded.
   * A `decision` beside the note makes the entry a fork of the witness log; it
   * arrives already normalised by the tool.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordProgress}'s reason: the event is what lets a reader hear about
   * this now rather than on the next pulse.

   */
  appendScratch(
    agentId: string,
    note: string,
    topic: string | null,
    decision: PadDecision | null,
  ): { ok: true; entry: ScratchEntry } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const target = padWriteTarget(task.originRef);
      if (!target.ok) return { ok: false, error: target.error };
      const entry = this.store.appendScratchEntry({
        padRef: target.padRef,
        authorOriginRef: task.originRef ?? target.padRef,
        agentId,
        taskId: task.id,
        topic,
        note,
        decision,
      });
      this.emit('scratch', { agentId, taskId: task.id, entry });
      return { ok: true, entry };
    });
  }

  /**
   * Read the whole pad for this agent's issue — every agent on the goal, in the
   * order they wrote (the `scratch_read` tool).
   *
   * Same access rule as the write, and a caller outside an issue subtree is
   * **refused** rather than handed an empty pad: an empty pad reads as "nobody has
   * written anything", which is a different and untrue answer.

   */
  readScratch(agentId: string): { ok: true; padRef: string; entries: ScratchEntry[] } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const target = padWriteTarget(task.originRef);
      if (!target.ok) return { ok: false, error: target.error };
      return { ok: true, padRef: target.padRef, entries: this.store.listScratchEntries(target.padRef) };
    });
  }

  /**
   * Record the retrospective this agent was dispatched to write (the `retro_submit`
   * tool).
   *
   * {@link retroSubmitOrigin} resolves the issue from the credential and refuses
   * every other caller by name, so the agent that *did* the work cannot write the
   * account of it. Idempotence is in the store's upsert: a second submission
   * revises one row.
   *
   * The lessons ride on the same call (issue #355 phase 2) rather than on a tool
   * of their own, which is what makes them **atomic with the write-up**: there is
   * no submission that filed lessons but no document, or a document whose lessons
   * were lost to a second call the agent never got to make. They land `proposed`,
   * carrying the issue as provenance, and reach no agent — promotion is a click in
   * the cockpit and stays one.
   *
   * The `retrospective` event already repaints the cockpit, and the lessons ride
   * that repaint: they are written *before* it is emitted, so a listener never
   * sees a retrospective whose lessons have not landed yet.

   */
  recordRetrospective(
    agentId: string,
    summary: string,
    document: string,
    lessons: string[],
  ): { ok: true; issueOrigin: string; lessonsFiled: number } | { ok: false; error: string } {
    return this.withCaller(agentId, (caller) => {
      const { task } = caller;
      const origin = retroSubmitOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      this.store.recordRetrospective({
        originRef: origin.issueOrigin,
        summary,
        document,
        agentId,
        taskId: task.id,
      });
      // Raised as claims, through the one store that now holds them. A
      // resubmission revises the document and lands its claims as corroborations
      // of the rows already standing rather than as second copies — `claimsMatch`
      // is what decides, so the dedupe `proposeLesson` did by exact text on one
      // goal is now the matching every other writer gets.
      //
      // Counted by what actually landed. A claim an operator rejected is refused
      // by name and reaches nobody however many times it is filed, and telling the
      // agent it filed one is exactly the silence the by-name refusal exists to
      // remove.
      const filed = lessons.filter((claim) => this.fileFact(caller, retroClaim(claim)).outcome !== 'barred').length;
      this.emit('retrospective', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin });
      return { ok: true, issueOrigin: origin.issueOrigin, lessonsFiled: filed };
    });
  }

  /**
   * Record the Feature summary this agent was dispatched to write (the
   * `feature_summary` tool).
   *
   * {@link featureSummarySubmitOrigin} resolves the container from the credential
   * and refuses every other caller by name, so an agent working one goal cannot
   * write the account of the Feature that goal sits under — it has an opinion
   * about its own story and no view of the rest, which is exactly the reading a
   * summary must not be.
   *
   * The standing key is stamped **here**, from where the children stand at
   * submission — see {@link AgentManagerOptions.featureStanding} for why a key
   * taken at dispatch would silently retire the Feature from ever being
   * summarised again. Idempotence is the store's upsert: a second submission
   * revises one row.
   *
   * **No event, deliberately** — the one write in this class that emits nothing.
   * `retrospective` and `scratch` exist because what they wrote rides inside
   * `/api/state`, which the cockpit polls; the feature board is fetched when it is
   * opened and never polled, so there is no surface to repaint. An event nobody
   * listens to is a promise the next reader would believe.
   */
  recordFeatureSummary(
    agentId: string,
    input: FeatureSummaryInput,
  ): { ok: true; featureOrigin: string } | { ok: false; error: string } {
    return this.withCaller(agentId, (caller) => {
      const { task } = caller;
      const origin = featureSummarySubmitOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      this.store.recordFeatureSummary({
        originRef: origin.featureOrigin,
        ...input,
        standingKey: this.opts.featureStanding?.(origin.featureOrigin) ?? '',
        agentId,
        taskId: task.id,
      });
      return { ok: true, featureOrigin: origin.featureOrigin };
    });
  }

  /**
   * Record why this agent had to come back to a pull request (the `report_remedy`
   * tool).
   *
   * {@link remedyOrigin} resolves the kind and the pull request from the
   * credential and refuses every other caller by name, so a review agent cannot
   * file a CI remedy and no agent can file against another pull request. The
   * **checks come from the task row**, never from the submission, for the same
   * reason the kind does: `Task.ciChecks` is what the harness dispatched this
   * agent about, and a list an agent could assert is a column reporting whatever
   * it remembered.
   *
   * The claim rides on the same call rather than on a second tool, exactly as
   * `recordRetrospective`'s lessons do and for their reason: there is no
   * submission that raised a claim but recorded no remedy, and none that lost its
   * claim to a follow-up call the agent never got to make.
   *
   * **The two are not folded together.** The remedy row is the *event* record of
   * one return to a pull request, with its counts and its dollars
   * (`docs/spec/18-observability.md`); the claim is a durable statement about
   * working this repository. Folding an account of an event into a durable claim
   * would lose the counts, so this writes both and neither stands in for the
   * other — and the remedy lands whatever becomes of the claim, including when an
   * operator has already rejected it.
   *
   * The claim goes through {@link fileFact}, which is the path `raise` uses: the
   * observer is the credential's, so an agent hitting a wall two other agents have
   * already documented is recorded as **agreeing with them** rather than filing a
   * third copy of it. The goal it carries is `corroborationGoal`'s reading of this
   * task's origin, which for a `pr:<n>:ci` or `pr:<n>:comments` dispatch is
   * `pr:<n>` — the pull request the remedy was filed on, exactly as the lesson's
   * `originRef` was, and resolved from the credential rather than asserted.
   *
   * Routed through the manager rather than straight to the store so the cockpit
   * repaints now rather than on the next pulse — {@link proposeFact}'s reason —
   * and, like a finding, it needs no *live* session: a remedy filed on an agent's
   * last breath is still the account of the run.
   */
  recordRemedy(
    agentId: string,
    submission: RemedySubmission,
  ): { ok: true; remedy: Remedy; raised: FactProposalOutcome | null } | { ok: false; error: string } {
    return this.withCaller(agentId, (caller) => {
      const { task } = caller;
      const scope = remedyOrigin(task.originRef);
      if (!scope.ok) return { ok: false, error: scope.error };
      const remedy = this.store.recordRemedy({
        kind: scope.kind,
        originRef: scope.originRef,
        prNumber: scope.prNumber,
        cause: submission.cause,
        guard: submission.guard,
        summary: submission.summary,
        checks: task.ciChecks ?? [],
        agentId,
        taskId: task.id,
      });
      const raised = submission.claim === null ? null : this.fileFact(caller, submission.claim);
      this.emit('remedy', { agentId, taskId: task.id, originRef: scope.originRef });
      return { ok: true, remedy, raised };
    });
  }

  /**
   * File what this agent learned about working the repository, or record that it
   * saw what somebody else had already filed (a `raise` matching a standing claim).
   *
   * **The observer is the credential's**, exactly as a finding's reporter is, and
   * for a stronger reason: corroboration is what carries a claim out of one
   * agent's head, so an agent that could name the goal it was observed on could
   * promote its own claim by asserting two of them. The goal is
   * {@link corroborationGoal}'s reading of the caller's own origin — `pr:412:ci`
   * and `pr:412:comments` collapse to one goal — and the session id is carried
   * beside it so an agent that inherited a conversation through a re-dispatch
   * (`spawn`'s `resumeSessionId`) cannot corroborate its own predecessor.
   *
   * Like a finding, it needs no *live* session: a claim written on an agent's last
   * breath is still what it learned.
   */
  proposeFact(
    agentId: string,
    proposal: FactProposal,
  ): { ok: true; outcome: FactProposalOutcome } | { ok: false; error: string } {
    return this.withCaller(agentId, (caller) => ({ ok: true, outcome: this.fileFact(caller, proposal) }));
  }

  /**
   * The one path a claim reaches the store by, whichever tool the agent was
   * holding.
   *
   * Split out of {@link proposeFact} when `report_remedy` grew its own arm
   * (`docs/spec/27-knowledge.md#the-remedy-arm`), because a second writer that
   * assembled its own observer would be a second answer to *who said this* — and
   * the count that carries a claim to `lookup` is a count of observers. The
   * caller is already resolved, so a path that writes a row *and* raises a claim
   * does both under one credential lookup rather than re-entering the tool seam.
   *
   * Three callers now: `raise`, `report_remedy`, and the retrospective's write-up,
   * whose claims were `lessons` rows until the stores merged. That is the whole
   * point of the seam — a claim is attributed identically whatever submission it
   * rode in on, so nothing about where it came from changes what it takes to carry
   * it anywhere.
   *
   * @public the fact-writing seam shared by `raise`, `report_remedy` and `retro_submit`
   */
  private fileFact(caller: { agent: Agent; task: Task }, proposal: FactProposal): FactProposalOutcome {
    const { agent, task } = caller;
    const outcome = this.store.proposeFact(proposal, {
      agentId: agent.id,
      taskId: task.id,
      goalRef: corroborationGoal(task.originRef),
      sessionId: agent.sessionId,
      // The agent's own words, never the claim restated: the count is what
      // promotes a fact and this is what an operator reads to decide whether it
      // should have.
      words: proposal.evidence,
    });
    // A barred proposal wrote nothing, so there is nothing to repaint — and an
    // event on it would put a claim an operator killed back in front of them as
    // if it had just arrived.
    if (outcome.outcome !== 'barred') {
      this.emit('fact', {
        agentId: agent.id,
        taskId: task.id,
        fact: outcome.fact,
        filed: outcome.outcome === 'filed',
        corroborations: outcome.corroborations,
      });
    }
    return outcome;
  }

  /**
   * Say that this agent saw for itself what a claim already says (a `raise` naming
   * `agreeWith`).
   *
   * The observer is the credential's, exactly as {@link proposeFact}'s is and for
   * the same reason with nothing softened: this call *is* a corroboration, and the
   * count of corroborators from different goals is what carries a claim to
   * `lookup`. An agent that could name the goal it was observed on could promote a
   * claim by asserting two of them, which is the whole of what the gate is for.
   */
  agreeWithFact(
    agentId: string,
    factId: string,
    evidence: string,
  ): { ok: true; outcome: FactAgreementOutcome } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ agent, task }) => {
      const outcome = this.store.agreeWithFact(factId, {
        agentId,
        taskId: task.id,
        goalRef: corroborationGoal(task.originRef),
        sessionId: agent.sessionId,
        // The agent's own observation, never the claim restated: it is what an
        // operator reads to decide whether the claim should have carried.
        words: evidence,
      });
      // Only a recorded agreement repaints, for the contradiction arm's reason: a
      // refusal wrote nothing, and an event on one would put a claim in front of an
      // operator as though the fleet had just agreed with it.
      if (outcome.outcome === 'recorded') {
        this.emit('fact', {
          agentId,
          taskId: task.id,
          fact: outcome.fact,
          filed: false,
          corroborations: outcome.corroborations,
        });
      }
      return { ok: true, outcome };
    });
  }

  /**
   * Say that a claim this agent was shown is contradicted by what it is looking
   * at, with the sentence it should have said instead (a `raise` naming `contradicts`
   * tool).
   *
   * The observer is the credential's, exactly as {@link proposeFact}'s is and for
   * the same reason twice over: the amendment filed alongside is a proposal, whose
   * first corroboration this call is, and the contradiction ratio counts by goal —
   * so an agent that could name its own goal could both promote its amendment and
   * inflate the dispute on the claim it replaces.
   *
   * The words are the agent's evidence rather than its amendment: what an operator
   * reads to choose between the two sentences is what the agent actually saw, and
   * the amendment is already a claim they can read on its own row.
   */
  contradictFact(
    agentId: string,
    contradiction: FactContradiction,
  ): { ok: true; outcome: FactContradictionOutcome } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ agent, task }) => {
      const outcome = this.store.contradictFact(contradiction, {
        agentId,
        taskId: task.id,
        goalRef: corroborationGoal(task.originRef),
        sessionId: agent.sessionId,
        words: contradiction.evidence,
      });
      // Only a recorded contradiction repaints: a refusal wrote nothing, and an
      // event on one would put a claim in front of an operator as though the fleet
      // had just disputed it.
      if (outcome.outcome === 'recorded') {
        this.emit('fact', {
          agentId,
          taskId: task.id,
          // The amendment is the fact that moved — it is the new row, and the
          // claim it names is exactly where it was.
          fact: outcome.amendment,
          filed: true,
          corroborations: 1,
        });
      }
      return { ok: true, outcome };
    });
  }

  /**
   * Answer what the fleet knows, for this caller (the `knowledge_ask` tool).
   *
   * The default scopes are the caller's own: the fleet's, its goal's, and one per
   * check it was dispatched about — resolved here rather than asked for, so the
   * answer to "what does anyone know about this" cannot be another goal's record.
   * A named scope narrows that; it never widens it past what an agent may see,
   * because every visible fact has already reached at least `lookup`.
   */
  askKnowledge(
    agentId: string,
    query: { question: string | null; scopes: readonly string[] | null },
  ): { ok: true; scopes: string[]; facts: AnsweredFact[] } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ agent, task }) => {
      const goalRef = corroborationGoal(task.originRef);
      const scopes = query.scopes
        ? [...query.scopes]
        : ['fleet', ...(goalRef ? [`goal:${goalRef}`] : []), ...(task.ciChecks ?? []).map((c) => `check:${c}`)];
      const answered = this.store.askFacts({ scopes, question: query.question });
      // How often a claim was actually wanted, recorded **here** rather than in
      // `askFacts` — which is a read path the cockpit calls twice on every poll to
      // project its delivery view. A counter inside the store would count the
      // operator's own browser as fleet demand; what keeps it out is that this
      // write is attributed to an asker resolved from the credential, and a poll
      // has none. Delivery by a matching scope is deliberately not an ask: it is
      // the harness putting a claim in front of an agent that did not want it.
      this.store.recordFactAsks(
        answered.map((fact) => fact.id),
        { agentId, taskId: task.id, goalRef, sessionId: agent.sessionId },
      );
      const facts = answered.map((fact) => ({
        fact,
        corroborations: distinctCorroborators(this.store.listCorroborations(fact.id)),
      }));
      return { ok: true, scopes, facts };
    });
  }

  /**
   * Record whether the issue an agent was dispatched for is finished (the
   * `conclude_work` tool).
   *
   * The issue is reached from the credential — agent → task → its `issue:<n>`
   * origin — so the tool takes no issue argument and an agent working anything
   * else resolves to nothing it may conclude. That check is
   * {@link conclusionOrigin}'s, and it is the structural half of "done means the
   * issue is finished, not my bit of it": a part agent is *refused* rather than
   * having its verdict quietly scoped to its part.
   *
   * Routed through the manager rather than straight to the store for the same
   * reason as {@link proposeFact}: the `conclusion` event repaints the cockpit
   * now rather than on the next pulse. Like a finding it needs no *live* session
   * — a verdict cast on an agent's last breath is the one that matters most.

   */
  recordConclusion(
    agentId: string,
    verdict: IssueConclusionVerdict,
    note: string,
  ): { ok: true; conclusion: IssueConclusion } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = conclusionOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      const conclusion = this.store.recordIssueConclusion({
        originRef: origin.originRef,
        verdict,
        note,
        by: 'agent',
        agentId,
        taskId: task.id,
      });
      // The operator's standing instructions were in this agent's prompt, and this
      // note is its answer to them — so concluding settles them, whichever verdict
      // it cast. `more_work` is not an exception: the note reaches the next agent
      // through `outstandingWorkNote`, and an instruction that also survived would
      // reach it twice, in two voices, with no way to tell whether the agent had
      // already acted on it. Settling on *dispatch* instead would lose one to any
      // agent that died before doing anything — see `src/store/instructions.ts`.
      this.store.settleInstructions(origin.originRef);
      this.emit('conclusion', { agentId, taskId: task.id, conclusion });
      return { ok: true, conclusion };
    });
  }

  /**
   * Park the goal this agent could not finish behind the obstacle that stopped it.
   *
   * **It writes no conclusion.** `done` and `more_work` are the agent's statement
   * about the *work*; this says the work could not be attempted, so there is
   * nothing to declare about whether the goal is finished — and a `more_work` row
   * written here would send the goal straight back to pickup, which is the next
   * agent hitting the same wall. The park's exit is the **obstacle**: the
   * ownership desk clears the block the moment the row stops reaching agents, and
   * nobody has to remember the goal.
   *
   * The same {@link conclusionOrigin} gate as a conclusion, so a part agent, a
   * planner and an assessor are refused here for the reasons they are refused
   * there — with the same sentences, since being blocked does not change whose
   * verdict it is.
   *
   * The obstacle must exist: an id that names nothing is a park with nothing to
   * lift it, and a typo an agent can fix this turn is worth refusing over.
   * → `docs/spec/32-obstacles.md#blocked-is-an-answer`
   */
  recordBlocked(
    agentId: string,
    obstacleId: string,
    note: string,
  ): { ok: true; block: ObstacleBlock } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = conclusionOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      const obstacle = this.store.getObstacle(obstacleId);
      if (!obstacle) {
        return {
          ok: false,
          error:
            `No obstacle has that id (${obstacleId}), so nothing was recorded and your goal is not parked. ` +
            `Name the id raise answered with — and if you have not raised what stopped you, raise it first: ` +
            `a block that names nothing is a goal nothing brings back.`,
        };
      }
      const block = this.store.recordObstacleBlock({
        originRef: origin.originRef,
        obstacleId,
        agentId,
        taskId: task.id,
        note,
      });
      // Settled for {@link recordConclusion}'s reason and with no exception for
      // this arm: the operator's standing instructions were in this agent's
      // prompt, and this note is its answer to them.
      this.store.settleInstructions(origin.originRef);
      return { ok: true, block };
    });
  }

  /**
   * Record an assessor's verdict on the issue it was dispatched to judge.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse.
   *
   * The two verdicts land in two different rows, because they are two verdicts
   * with opposite polarity. `delivered` is the harness's park and **gates pickup**;
   * a shortfall gates nothing and exists to *release* work, which is why it is a
   * table of its own rather than a column on the delivery (see
   * {@link IssueShortfall}). Their mutual exclusion is enforced in the store, so it
   * is not re-implemented here.
   *
   * It deliberately no longer writes `issue_conclusions`. That row is the working
   * agent's own declaration about its own run, keyed on the issue — so an assessor
   * writing into it overwrote the agent's note, author and timestamp, with no
   * precedence between the two parties for the resolver to read. That was a bug
   * independent of this feature (issue #159), and `resolveIssueConclusion` now
   * ranks the two records instead.
   *
   * **The plan-aware refusals are here rather than in `validateAssessment`**
   * because they are store questions, and they are the tool channel's whole point:
   * a structured payload whose rejection the agent never hears costs a whole agent
   * to discover, which is the `plan.json` lesson. Each names the alternative, the
   * way `conclusionOrigin` and `partConclusionOrigin` do.

   */
  recordAssessment(
    agentId: string,
    verdict: AssessmentVerdict,
    summary: string,
    detail: string | null = null,
    cause: ShortfallCause | null = null,
    part: string | null = null,
  ): { ok: true; issueOrigin: string; verdict: AssessmentVerdict } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = assessmentOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };

      if (verdict === 'delivered') {
        this.store.recordDelivery({
          originRef: origin.issueOrigin,
          summary,
          detail,
          by: 'assessor',
          agentId,
          taskId: task.id,
        });
        this.emit('assessment', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
        return { ok: true, issueOrigin: origin.issueOrigin, verdict };
      }

      // The discriminator is the plan *row*, not its parts: a `single` verdict is a
      // plan, and replanning one is the honest response to "one pull request was not
      // enough" — it re-runs the planner, which may now decompose it.
      const plan = this.store.listPlans().find((p) => p.originRef === origin.issueOrigin) ?? null;
      const parts = plan ? liveParts(this.store.listPlanParts(plan.id)) : [];

      if (plan === null && (cause === 'plan' || cause === 'part')) {
        return {
          ok: false,
          error:
            `cause "${cause}" says the delivery plan is what fell short, and ${origin.issueOrigin} has no plan — ` +
            `there is nothing to re-plan and no part to follow up. If the issue's own goal is the problem, say ` +
            `cause "goal". If the work simply is not finished, say more_work with no cause: the issue comes ` +
            `back round for pickup with your summary against it.`,
        };
      }
      if (plan !== null && cause === null) {
        return {
          ok: false,
          error:
            `${origin.issueOrigin} has a delivery plan, so a shortfall has to say what fell short or the harness ` +
            `cannot route it: cause "plan" (the split itself is wrong, or a part is missing), "part" (one named ` +
            `part missed its own scope — name it in \`part\`), or "goal" (the issue itself is wrong, and no ` +
            `planner can fix that).`,
        };
      }
      if (cause === 'part' && !parts.some((p) => p.slug === part)) {
        return {
          ok: false,
          error:
            parts.length === 0
              ? `${origin.issueOrigin}'s plan declares no parts — it is a single-pull-request verdict, so there ` +
                `is no "${part}" to follow up. Say cause "plan" if one pull request was not enough; the planner ` +
                `will see your summary and may decompose it.`
              : `"${part}" is not a live part of ${origin.issueOrigin}'s plan. Its parts are: ` +
                `${parts.map((p) => p.slug).join(', ')}. Name one of those, or say cause "plan" if the part you ` +
                `have in mind is one the decomposition is missing.`,
        };
      }

      this.store.recordShortfall({
        originRef: origin.issueOrigin,
        cause,
        partSlug: part,
        summary,
        detail,
        by: 'assessor',
        agentId,
        taskId: task.id,
      });
      this.emit('assessment', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
      return { ok: true, issueOrigin: origin.issueOrigin, verdict };
    });
  }

  /**
   * Record a planner's "there is nothing to build here — this goal is already met"
   * (the `plan_not_needed` tool).
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse. Identity is structural — the issue is the credential's
   * own planning origin, and {@link plannerOrigin} refuses every other kind of
   * caller by name.
   *
   * **The two refusals below are here rather than in `validatePlanNotNeeded`**
   * because both are store questions, and both are silent if they are not asked:
   *
   * - **An issue that already has a plan row** is a *replan*, and this verdict
   *   cannot speak for it. The row would park pickup while the plan went on
   *   owning the issue — `planInFlight` reads `planning` as more work, so the
   *   cockpit would show a goal both delivered and mid-decomposition — and parts
   *   already dispatched or in review would keep running underneath it. The
   *   planner that believes the goal is met on a replan has somewhere honest to
   *   say so, and it is the operator who asked for the replan.
   * - **A standing shortfall** is an assessor saying, with the delivered state in
   *   front of it, that this goal is *not* reached. Writing a delivery would clear
   *   that row through the exclusion matrix — the assessor's verdict gone, with
   *   nothing anywhere red — and it would be the harness overturning its own
   *   better-informed judgement with its less-informed one.
   */
  recordGoalMet(
    agentId: string,
    summary: string,
    detail: string,
  ): { ok: true; issueOrigin: string } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = plannerOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };

      const plan = this.store.getPlanByOrigin(origin.issueOrigin);
      if (plan) {
        return {
          ok: false,
          error:
            `${origin.issueOrigin} already has a delivery plan, so this is a replan and plan_not_needed ` +
            `cannot settle it: the plan would go on owning the issue, and any part already dispatched or ` +
            `in review would go on running underneath a goal marked delivered. Submit the amended plan ` +
            `with plan_submit — a part that turned out to be unnecessary is one you leave out, and one ` +
            `already in flight is a part whose agent closes it with conclude_part. If you believe the ` +
            `whole goal is already met, raise it: the operator asked for this replan and it is theirs to end.`,
        };
      }

      const shortfall = this.store.getShortfall(origin.issueOrigin);
      if (shortfall) {
        return {
          ok: false,
          error:
            `An assessment of ${origin.issueOrigin} standing right now says the goal is *not* reached — ` +
            `"${shortfall.summary}" — and it was cast against the delivered state rather than against a ` +
            `plan. Recording a delivery here would erase it. Read what it says is missing; if it is wrong, ` +
            `raise that, and if it is right, plan the work it names.`,
        };
      }

      this.store.recordDelivery({
        originRef: origin.issueOrigin,
        summary,
        detail,
        by: 'planner',
        agentId,
        taskId: task.id,
      });
      this.emit('goalMet', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin });
      return { ok: true, issueOrigin: origin.issueOrigin };
    });
  }

  /**
   * Record an appraiser's verdict on the goal it was dispatched to judge.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse.
   *
   * **The fingerprint is taken from the task, not from the world**, and that is
   * the load-bearing line. `originTitle`/`originSummary` are the issue's title and
   * body captured at dispatch — the exact text this agent was handed and therefore
   * the exact text it judged. Re-reading the issue here would stamp the verdict
   * with whatever the ticket says *now*, so an edit made while the appraiser was
   * running would be silently swallowed: the verdict would claim to be about text
   * nobody appraised, and `appraisalHold`'s first arm — the one that re-opens the
   * question when the ticket changes — could never fire for it.

   */
  recordAppraisal(
    agentId: string,
    verdict: GoalAppraisalVerdictName,
    summary: string,
    profile: string | null,
    placement?: { parent: number | null; areaPath: string | null },
  ):
    | { ok: true; issueOrigin: string; verdict: GoalAppraisalVerdictName; profileHeld: boolean }
    | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = appraiserOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };

      // Whether the proposal needs a human is decided **here**, once, because this
      // is where the ticket's own tag and the operator's config are both in hand.
      // Deciding it at read time instead would put a config lookup inside
      // `appraisalHold`, and a caller that forgot to wire it would gate the whole
      // fleet rather than none of it.
      const proposedProfile = this.opts.goalProfile && profile ? profile : null;
      const profileHeld =
        proposedProfile !== null && proposedProfile !== this.opts.goalProfile?.effective(origin.issueOrigin);
      this.store.recordAppraisal({
        originRef: origin.issueOrigin,
        verdict,
        summary,
        goalRef: goalFingerprint(task.originTitle, task.originSummary),
        by: 'appraiser',
        proposedProfile,
        profileDiverges: profileHeld,
        // Stored exactly as proposed, with **no check here that the work item is
        // still missing the field**. That reading is derived where the question is
        // drawn, off the live item — so an operator who sets the parent by hand
        // while the appraiser is running ends the question with no write at all,
        // and this stays a record of what was said rather than a second opinion
        // about the tracker.
        proposedParent: placement?.parent ?? null,
        proposedAreaPath: placement?.areaPath ?? null,
        agentId,
        taskId: task.id,
      });
      this.emit('appraisal', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
      return { ok: true, issueOrigin: origin.issueOrigin, verdict, profileHeld };
    });
  }

  /**
   * Record what a plan part produced, for a part that finished without a pull
   * request — a write-up, or the determination that nothing needed building.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse. Identity is structural — the part is resolved from the
   * credential's task origin, so an agent cannot conclude a sibling's work, and
   * {@link partConclusionOrigin} refuses every other kind of caller by name.

   */
  recordPartOutcome(
    agentId: string,
    kind: PartOutcomeKind,
    summary: string,
    ref: string | null,
  ): { ok: true; part: PlanPart } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = partConclusionOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      const plan = this.store.getPlanByOrigin(issueOrigin(origin.issueNumber));
      const part = plan ? this.store.listPlanParts(plan.id).find((p) => p.slug === origin.slug) : undefined;
      if (!part) {
        return { ok: false, error: `no part "${origin.slug}" is recorded for issue #${origin.issueNumber}.` };
      }
      // The store's guard does the work: only a part still being worked moves, so a
      // second call merges nothing and a merged or retired part cannot be re-labelled.
      const concluded = this.store.concludePlanPart(part.id, { kind, ref, summary });
      if (!concluded) {
        return {
          ok: false,
          error:
            `part "${origin.slug}" is "${part.status}", and only a part being worked can be concluded. ` +
            `A merged part already finished; a retired one was dropped by a replan.`,
        };
      }
      this.emit('partOutcome', { agentId, taskId: task.id, part: concluded });
      return { ok: true, part: concluded };
    });
  }

  /**
   * Send Ctrl-C (raw ETX) to a live agent to interrupt its current work. Status
   * is not mutated here — the agent's own output/exit drives what happens next.
   */
  interrupt(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    session.sendRaw('\x03');
    return true;
  }

  kill(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    // A usage-limit park is the one state with no live session and no ending: the
    // process went with the limit and the row is deliberately still unsettled. The
    // operator must be able to abandon one — "resume" cannot be the only verdict on
    // a park that could otherwise sit there until the next restart offers recovery.
    if (!session && !this.limited.has(agentId)) return false;
    session?.kill();
    this.disposeFileEvents(agentId); // fold any last writes in, then drop the spool
    this.releaseMcp(agentId); // the credential dies with the agent, not with the process
    this.parked.delete(agentId);
    this.limited.delete(agentId); // a killed agent's park is over, and nothing may resume it
    this.stalled.delete(agentId); // ...as is its countdown; there is nothing left to settle
    this.store.flushTranscript(agentId); // make the killed agent's transcript durable
    const agent = this.store.getAgent(agentId);
    this.store.updateAgent(agentId, { status: 'killed', endedAt: new Date().toISOString(), pid: null });
    if (agent) this.store.updateTask(agent.taskId, { status: 'interrupted' });
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId); // a deliberate kill's exit code is not a failure cause
    // A killed agent still has to be reaped — the worktree lease outlives the process
    // otherwise — so record the terminal and let `maybeReap` decide when the other
    // half (`exited`) is in hand, exactly as `handleTerminal` does for `done`/`failed`.
    this.terminals.set(agentId, 'killed');
    if (!session) {
      // The usage-limit-park arm: the process already exited before the park began,
      // and `shedLimitedSession` cleared `exited` for it at the time — there is no
      // live session left to fire a future `exit` event, so nothing will complete
      // the rendezvous unless it happens here, synchronously.
      this.exited.add(agentId);
    }
    if (agent) {
      this.reflectStatus(agentId, agent.taskId, 'killed');
      this.maybeReap(agentId, agent.taskId);
    }
    return true;
  }

  /**
   * The operator declaring an agent finished — the sibling of {@link kill}, and
   * its inverse in exactly one respect.
   *
   * The clean `done` terminal was reachable only by the *agent*, via the sentinel.
   * An agent that does the work and never prints one (in stream mode a turn ending
   * without it doesn't fail — it parks `waiting` awaiting direction) could then be
   * ended only by `kill`, which records the opposite: task `interrupted`, worktree
   * kept, and an abandonment in the log. This is the missing verdict.
   *
   * It stops the process and then routes through the *same* {@link handleTerminal}
   * the sentinel drives, so nothing about a completed agent differs from a finished
   * one. `session.kill()` marking the session `killed` internally is fine and
   * load-bearing: that flag only stops the *session* reclassifying its own exit —
   * here the manager decides the record, and it decides `done`.
   *
   * Both `complete` and `kill` now drive the same reap rendezvous — the difference
   * is only which terminal `maybeReap` finds waiting: `done` here, `killed` there.
   * Both runtimes emit `exit` before their killed early-return, so the exit still
   * lands, {@link maybeReap} finds the `done` terminal `handleTerminal` records
   * below, and the reap fires — the clean finish, which is the whole point of
   * saying done instead of killing. Credential revocation and spool disposal ride
   * along there as usual.
   *
   * Liveness is the whole guard: an agent that has already ended is not a candidate,
   * since re-labelling a settled record is a different question with a different
   * answer. Returns false in that case, which the route turns into a 409.
   */
  complete(agentId: string, by: 'operator' | 'expiry' = 'operator'): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    const agent = this.store.getAgent(agentId);
    if (!agent) return false;
    // Everything below names the agent by the id on the row we just loaded, never
    // by the argument. They are equal by construction — the two lookups above both
    // hit, and the session map is keyed on ids this class minted — so this is about
    // provenance: `complete` is the one path here reached straight from a request
    // parameter (`POST /api/agents/:id/complete`), and these ids go on to be written
    // into an audit row and, on the failure arm downstream, a log line. Reading the
    // canonical value back off the record keeps a caller's string out of both.
    const id = agent.id;
    session.kill();
    this.handleTerminal(id, agent.taskId, 'done', by);
    // Audited under the cycle id the cockpit reads as yours, the way an act decided
    // outside a pulse already is. No proposal: there is nothing to authorize — the
    // act is the operator's own and already taken, where a proposal is a standing
    // verdict a rule re-reads every pulse.
    const task = this.store.getTask(agent.taskId);
    this.store.recordDecision({
      // `human:` for the click and `stall:` for the countdown, because the audit log
      // is read to answer "who ended this run" and the two answers are different.
      cycleId: `${by === 'operator' ? 'human' : 'stall'}:${id}`,
      action: {
        type: 'no_op',
        reason:
          by === 'operator'
            ? 'operator marked the work complete'
            : 'an unannounced stop stood unanswered until its park expired',
      },
      outcome: 'executed',
      detail: `Marked agent ${id} done (task ${agent.taskId}${task?.originRef ? `, ${task.originRef}` : ''})`,
    });
    return true;
  }

  isLive(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  /**
   * Stop every live agent because the *server* is going down — distinct from
   * {@link kill}, which is a deliberate per-agent stop. Agents are left in the
   * resumable `interrupted` state (not `killed`) so the next boot re-attaches
   * them; `waitingReason` and the task status are preserved as the signal for
   * how to resume. A cockpit kill stays dead because it alone marks `killed`.
   */
  interruptAll(): void {
    const at = new Date().toISOString();
    for (const id of [...this.sessions.keys()]) {
      const session = this.sessions.get(id);
      try {
        session?.kill();
      } catch {
        /* process already gone */
      }
      this.disposeFileEvents(id); // fold any pending writes in; a resume mints a fresh spool
      this.releaseMcp(id); // a resume mints a fresh credential, same as the spool
      this.store.flushTranscript(id); // make the transcript durable before we exit
      this.store.updateAgent(id, { status: 'interrupted', endedAt: at, pid: null });
      this.sessions.delete(id);
      this.exitCodes.delete(id);
      this.exited.delete(id);
      // Not `parked`: `waitingReason` is preserved as the resume signal, and
      // `restoreWaiting` re-establishes the latch when the agent comes back.
      this.parked.delete(id);
      // The row keeps its reason, so the desk still says why it was parked; what
      // does not survive is this process's offer to resume it.
      this.limited.delete(id);
    }
  }

  // -- internals -----------------------------------------------------------

  /** The LUBBDUBB_STATUS_FILE env entry for a launch, when status capture is wired. */
  /** The LUBBDUBB_EVENTS_DIR env entry for a launch, when the file-events hook is wired. */
  private eventsDirEnv(key: string | null): Record<string, string> {
    if (!key || !this.opts.fileEvents) return {};
    const env: Record<string, string> = { LUBBDUBB_EVENTS_DIR: this.opts.fileEvents.dirFor(key) };
    // Turn the hook's own breadcrumb logging on so a "did it even fire?" answer
    // survives on the agent's side too, not just ours.
    if (debugEnabled()) env.LUBBDUBB_EVENTS_DEBUG = '1';
    return env;
  }

  /** The spool dir an agent's writes land in (where LUBBDUBB_EVENTS_DIR points), or null. */
  fileEventsDir(agentId: string): string | null {
    const key = this.eventsKeys.get(agentId);
    return key && this.opts.fileEvents ? this.opts.fileEvents.dirFor(key) : null;
  }

  /**
   * Drain the file-events spool for an agent, folding each captured write into
   * the files list (and, for report-like paths, an artifact chip). Public so the
   * composition root / tests can force a drain; also called opportunistically as
   * output flows and once more when the agent finishes. Idempotent — the spool
   * hands each record out exactly once.
   */
  drainFileEvents(agentId: string): void {
    const key = this.eventsKeys.get(agentId);
    if (!key || !this.opts.fileEvents) return;
    const records = this.opts.fileEvents.drain(key);
    if (records.length === 0) return;
    const agent = this.store.getAgent(agentId);
    if (!agent) return;
    debugLog('fileEvents', `agent=${agentId} drained ${records.length} record(s)`);
    for (const rec of records) this.ingestFileEvent(agent, rec);
  }

  /** Record one captured write; promote report-like paths to an artifact chip. */
  private ingestFileEvent(agent: Agent, rec: FileEventRecord): void {
    const path = toWorktreeRelative(agent.cwd, rec.path);
    const { promoted, kind } = classifyArtifact(path, this.opts.docsFolderPrefix);
    debugLog(
      'fileEvents',
      `agent=${agent.id} write path=${path} tool=${rec.tool ?? '?'} promoted=${promoted} kind=${kind}`,
    );
    this.store.recordFile(agent.id, { path, tool: rec.tool, promoted });
    this.emit('files', { agentId: agent.id, taskId: agent.taskId });
    // The planner's side channel rides the same hook. It has to be read *here*,
    // inside the drain, while `agent.cwd` still exists: the composition root
    // removes a done agent's worktree on the reap, so any later read finds nothing.
    if (isPlanFile(path)) this.ingestPlan(agent, path);
    if (promoted) {
      // Reuse the flag path so a report becomes a chip through the exact same
      // dedup / artifact-serving machinery as an explicitly-flagged one.
      const flag = this.store.recordFlag(agent.id, { kind, label: basename(path), ref: path });
      this.emit('flag', { agentId: agent.id, taskId: agent.taskId, flag });
    }
  }

  /**
   * Persist a planning agent's plan from the `plan.json` it just wrote.
   *
   * The plan is stored whatever its size — a one-part plan is a first-class
   * row — because without one the planner re-runs on the same issue every cycle.
   * This is also where a **replan** lands: same file, same hook, and the merge on
   * slug is what lets an in-flight part keep its branch and PR across an amendment.
   */
  private ingestPlan(agent: Agent, relPath: string): void {
    const task = this.store.getTask(agent.taskId);
    const number = planOriginIssue(task?.originRef ?? null);
    if (!task || number === null) {
      debugLog('fileEvents', `agent=${agent.id} wrote ${PLAN_FILE} but is not a planning agent — ignored`);
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(join(agent.cwd, relPath), 'utf8');
    } catch (err) {
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id} flagged ${PLAN_FILE} for issue #${number} but it could not be read: ${(err as Error).message}`,
      });
      return;
    }
    const parsed = parsePlanDocument(raw);
    if (!parsed.ok) {
      // No plan row is written, so the issue stays in the funnel: the planner is
      // retried, and the attempt cap eventually fails it open to `single`.
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id} wrote an invalid ${PLAN_FILE} for issue #${number}: ${parsed.error}`,
      });
      return;
    }
    const doc = parsed.document;
    const origin = issueOrigin(number);
    // The write itself is shared with the `plan_submit` tool, so the file path and
    // the tool path cannot drift into two different notions of what a plan means.
    const result = ingestPlanDocument(this.store, {
      doc,
      originRef: origin,
      title: task.originTitle ?? task.title,
    });
    debugLog(
      'fileEvents',
      `agent=${agent.id} plan ingested issue=#${number} parts=${doc.parts.length} status=${result.status} ` +
        `retired=${result.retired.length}`,
    );
    // Fire-and-forget, and deliberately: the drain is synchronous and the reading
    // is a process spawn per declared check. A refusal has no author to go back to
    // on this path, so it is recorded rather than returned — the alternative is a
    // failure nothing anywhere mentions.
    void this.opts.watch?.run(origin).then(
      (refusals) => {
        if (refusals.length === 0) return;
        this.opts.errors?.record({
          source: 'agent',
          message:
            `Agent ${agent.id} declared a watch on issue #${number} whose queries did not resolve: ` +
            refusals.join('; '),
        });
      },
      (err: unknown) => {
        this.opts.errors?.record({
          source: 'agent',
          message: `The watch dry run for issue #${number} failed: ${(err as Error).message}`,
        });
      },
    );
  }

  /** Final drain + spool teardown for an agent that's leaving the fleet. */
  private disposeFileEvents(agentId: string): void {
    const key = this.eventsKeys.get(agentId);
    if (!key || !this.opts.fileEvents) return;
    this.drainFileEvents(agentId); // catch writes from the last turn before dropping the dir
    // One-shot dump of the hook's own breadcrumbs before the dir goes away. Empty
    // lines here (with debug on) mean the hook never ran — the fault is upstream of
    // the spool (`--settings`/matcher/PATH), not in draining or classification.
    if (debugEnabled()) {
      const crumbs = this.opts.fileEvents.readDebug(key);
      debugLog('fileEvents', `agent=${agentId} hook fired ${crumbs.length} time(s)`);
      for (const c of crumbs) debugLog('fileEvents', `agent=${agentId} hook: ${c}`);
    }
    this.opts.fileEvents.dispose(key);
    this.eventsKeys.delete(agentId);
  }

  /** Attach the store-update + re-emit listeners shared by fresh spawns and resumes. */
  private wireSession(session: AgentSession, agentId: string, task: Task): void {
    session.on('output', (delta: string) => {
      this.store.appendTranscript(agentId, delta);
      this.emit('output', { agentId, delta });
      // Piggyback the spool drain on the output stream: an agent that writes a
      // file also produces output around it, so captured writes surface promptly
      // without a polling timer. A no-op when no spool is wired / nothing pending.
      this.drainFileEvents(agentId);
    });

    session.on('status', (status) => {
      if (status === 'running') {
        this.store.updateAgent(agentId, { status: 'running', pid: session.pid, waitingReason: null });
        this.reflectStatus(agentId, task.id, 'running');
      }
    });

    session.on('usage', (usage: AgentUsage) => {
      this.store.recordAgentUsage(agentId, usage);
      this.emit('usage', { agentId, taskId: task.id, usage });
    });

    // The account's usage windows, which every live agent reports the same values
    // for. Landed straight in the store rather than re-emitted: there is one
    // account, so this is not news *about this agent*, and the store's own
    // freshest-wins guard is what keeps interleaved reports in order.
    session.on('limits', (limits: AccountRateLimits) => this.store.recordRateLimits(limits));

    // An artifact/link the agent surfaced: persist (deduped by ref) and re-emit
    // the stored flag so the server can stream it to the cockpit.
    session.on('flag', (flag: ParsedFlag) => {
      const saved = this.store.recordFlag(agentId, flag);
      this.emit('flag', { agentId, taskId: task.id, flag: saved });
    });

    session.on('activity', () => this.noteResumed(agentId, task.id));

    session.on('waiting', (reason: string) => this.handleWaiting(agentId, task, reason));
    session.on('stalled', (lastWords: string) => this.handleStalled(session, agentId, task, lastWords));
    session.on('silent', (silenceMs: number) => this.handleSilent(agentId, task, silenceMs));
    session.on('limited', (park: RateLimitPark) => this.handleLimited(agentId, task, park));
    // Both runtimes emit `exit` (with the process exit code) before `failed`, so
    // the code is in hand by the time the terminal transition is recorded.
    session.on('exit', (code: number) => {
      this.exitCodes.set(agentId, code);
      this.exited.add(agentId);
      // A limit park usually outlives its process: `claude` exits with the exhausted
      // account and no terminal transition follows, so the resources the launch held
      // have to be given back here or they are held for as long as the park is.
      if (this.limited.has(agentId)) this.shedLimitedSession(agentId);
      this.maybeReap(agentId, task.id);
    });
    session.on('done', () => this.handleTerminal(agentId, task.id, 'done'));
    session.on('failed', () => {
      const attempts = this.autoResume(session, agentId, task);
      if (attempts === null) return; // re-attached; the row and the task stay live
      this.handleTerminal(
        agentId,
        task.id,
        'failed',
        'agent',
        attempts > 0 ? `after ${attempts} automatic resume${attempts === 1 ? '' : 's'}` : undefined,
      );
    });
  }

  /**
   * A live agent's process died mid-run: re-open its own conversation rather than
   * settling the task (issue #318).
   *
   * The death of the process is not the death of the session. On a resumable
   * runtime the transcript is on disk and `--resume` picks it up in the same
   * worktree with everything the agent had learned — so failing the task throws
   * away a run that is recoverable, and `requeue` (which exists, and starts over)
   * is not the same thing. What makes that safe rather than a crash loop is the
   * budget: {@link AgentManagerOptions.resumeAttempts}, counted on the agent row so
   * it spans restarts, with the `N+1`th death settling as `failed` naming the count.
   *
   * Returns null when it re-attached, else how many resumes had been spent — which
   * the caller puts in the error, so a loop reads as a loop instead of as a crash.
   *
   * **The teardown is the load-bearing part.** {@link resume} was written for boot,
   * where the in-memory maps are empty; here they are not, and it neither drops the
   * dead session (so its own `sessions.has` guard would return a silent no-op
   * success) nor disposes what the dead process held — it would `set` straight over
   * the spool key and the MCP token, leaking a spool directory and, worse, leaving a
   * bearer credential bound and live with nothing left to revoke it.
   */
  private autoResume(session: AgentSession, agentId: string, task: Task): number | null {
    const limit = this.opts.resumeAttempts ?? 0;
    // A session that is no longer the agent's is one the harness already ended —
    // a cockpit `kill` or an operator `complete`. Those are decided endings, and
    // resurrecting one is precisely what the recovery path must not do.
    if (limit <= 0 || !this.opts.resumable || this.sessions.get(agentId) !== session) return 0;
    const agent = this.store.getAgent(agentId);
    if (!agent?.sessionId) return agent?.resumeAttempts ?? 0;
    // Nothing to resume *into*: the worktree is the session's cwd, and `claude`
    // finds no transcript for the id once it is gone.
    if (!existsSync(agent.cwd)) return agent.resumeAttempts;
    if (agent.resumeAttempts >= limit) return agent.resumeAttempts;

    // Counted before the relaunch, not after it: a resume that dies during
    // `start()` must still have cost a life, or the budget never runs down.
    const attempts = this.store.countAgentResumeAttempt(agentId);
    this.disposeFileEvents(agentId); // fold the dead run's last writes in, then drop its dir
    this.releaseMcp(agentId); // revoke the credential the dead process held
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId); // belongs to the launch that died, not the next one
    this.exited.delete(agentId); // ...and this agent has not been reaped: it is coming back
    debugLog('agent', `auto-resume agent=${agentId} attempt=${attempts}/${limit}`);
    try {
      // `resume` reads `waitingReason` off the row, so an agent that crashed while
      // parked comes back parked on the same still-open escalation.
      if (this.resume({ ...agent, resumeAttempts: attempts }, task)) return null;
    } catch (err) {
      this.store.appendTranscript(agentId, `\nResume after crash failed: ${(err as Error).message}\n`);
    }
    return attempts;
  }

  /**
   * Deliver a first message once the process has had `promptDelayMs` to boot.
   * Stream transport is ready at once (deliver synchronously); an interactive
   * terminal needs the REPL to come up first. No-op when `text` is null.
   */
  private deliverAfterBoot(agentId: string, session: AgentSession, text: string | null): void {
    if (text === null) return;
    const delay = this.opts.promptDelayMs ?? 0;
    const deliver = (): void => {
      if (!this.sessions.has(agentId)) return; // killed/finished before we could send
      try {
        session.send(text);
      } catch {
        /* session already gone */
      }
    };
    if (delay <= 0) deliver();
    else setTimeout(deliver, delay).unref?.();
  }

  /**
   * Put a resumed agent back into the parked `waiting` state it held before the
   * restart. The escalation raised then is persisted and, now that the session is
   * live again, an answer routes straight into it; if it's somehow gone, re-raise
   * one so the human is still prompted.
   */
  private restoreWaiting(agent: Agent, task: Task): void {
    const reason = agent.waitingReason ?? 'Resumed agent is awaiting your input.';
    this.parked.add(agent.id); // still parked across the restart; don't re-park on a re-announce
    this.store.updateAgent(agent.id, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agent.id, task.id, 'waiting');
    const hasOpen = this.store.listOpenEscalations().some((e) => e.agentId === agent.id);
    if (!hasOpen) this.emit('waiting', { agentId: agent.id, taskId: task.id, reason });
  }

  /**
   * An agent ended a turn with no sentinel in it — it stopped, and did not say
   * whether that was finished, blocked or neither.
   *
   * **The stop is not itself a question, and treating it as one is what filled the
   * inbox.** The two things that actually produce it are an agent that did the work
   * and narrated it instead of printing the done sentinel, and an agent that started
   * a build, a test run or a CI check and stopped as though something would wake it
   * when that finished. Neither wants a human, and a human sent to one of them can
   * only read the transcript to find out which it was — the diagnosis cost that made
   * these items expensive out of proportion to what they were.
   *
   * So the agent is asked first, up to `stallNudges` times, and only a stop that
   * survives the budget is put to a person. {@link STALL_NUDGE} states the three
   * exits rather than picking one, because the harness genuinely cannot tell them
   * apart and the agent can.
   *
   * The nudge is written to the transcript as a sent message before it goes out. It
   * is the harness taking a turn in the agent's conversation, and a transcript that
   * showed the agent apparently answering a question nobody asked would be the same
   * unexplained gap in a different place.
   */
  private handleStalled(session: AgentSession, agentId: string, task: Task, lastWords: string): void {
    // A park already owns this agent: it asked mid-turn (`escalate`) and the turn
    // that asked has now ended, or the account ran out. Neither is an unannounced
    // stop, and nudging either would type into an agent that is waiting on a person.
    if (this.parked.has(agentId)) return;
    const budget = this.opts.stallNudges ?? 0;
    const spent = this.nudges.get(agentId) ?? 0;
    // A dead process cannot be asked anything — the stop is all there is, so park it.
    if (spent < budget && !this.exited.has(agentId)) {
      this.nudges.set(agentId, spent + 1);
      this.noteSent(agentId, session, STALL_NUDGE);
      debugLog('agent', `stall nudge agent=${agentId} attempt=${spent + 1}/${budget}`);
      try {
        session.send(STALL_NUDGE);
        return;
      } catch {
        // The session went away between the turn ending and the nudge. Fall through:
        // an agent that cannot be asked is one the operator has to be told about.
      }
    }
    this.handleWaiting(agentId, task, stallReason(lastWords));
    this.armStallClock(agentId, this.opts.stallParkMs ?? 0, 'stall');
  }

  /**
   * The runtime has heard nothing from a session for `agentSilenceParkMs` — the
   * agent is wedged *inside* a turn rather than stopped at the end of one.
   *
   * **It is not nudged, and that is the difference from {@link handleStalled}.** A
   * nudge is a message written to stdin, which `claude` reads at the end of the turn
   * it is in; an agent that has not produced a byte has not reached that end and is
   * not going to, so the nudge would sit in the pipe of a process nobody is going to
   * hear from again while its budget was spent asking. The stop at a turn boundary
   * can be asked something. This one can only be told about.
   *
   * So it goes straight to the park and the countdown, which settle it exactly as
   * they settle an unanswered stop: `complete` kills the session (reaping the
   * subtree, which is the point here — the wedged tool call's own children are what
   * hold the worktree open), keeps the branch and its commits, and releases the
   * slot. If there was more to do, the world still says so and the pulse dispatches
   * for it again.
   */
  private handleSilent(agentId: string, task: Task, silenceMs: number): void {
    // A park already owns this agent, and every one of them is legitimately quiet: a
    // question waiting on a person, a limit waiting on the window. Silence is only
    // evidence about an agent nobody is already waiting on.
    if (this.parked.has(agentId)) return;
    debugLog('agent', `silence park agent=${agentId} after=${silenceMs}ms`);
    this.handleWaiting(agentId, task, silenceReason(silenceMs));
    // The countdown the operator sees is the same one every park gets, but the grace
    // is this agent's own silence window: it has just demonstrated that its work goes
    // quiet for longer than the operator's window, so re-arming on the shorter one
    // would settle it the moment it came back and started something else long.
    this.armStallClock(agentId, this.opts.stallParkMs ?? 0, 'silence', this.opts.silenceParkMs ?? 0);
  }

  /**
   * Start a park's countdown — the one place either park's clock is armed.
   *
   * Read off the latches rather than from what the caller just did, because both
   * arms are decided in {@link handleWaiting}: it auto-answers a whitelisted reason
   * and returns with the agent running, and an agent already parked on a question of
   * its own keeps that park. Neither is a stop waiting on a clock.
   */
  private armStallClock(agentId: string, window: number, kind: 'stall' | 'silence', grace = window): void {
    if (window <= 0 || !this.parked.has(agentId) || this.limited.has(agentId)) return;
    this.stalled.set(agentId, { at: Date.now() + window, grace: grace > 0 ? grace : window });
    debugLog('agent', `${kind} park armed agent=${agentId} window=${window}ms grace=${grace}ms`);
  }

  private handleWaiting(agentId: string, task: Task, reason: string, ask?: AgentAsk): void {
    // The convergence point for the two ways an agent asks (see `parked`). An
    // agent already parked is not parked again: re-running the whitelist would
    // auto-answer the same prompt twice, and re-emitting `waiting` would race the
    // inbox's own per-agent dedup rather than relying on it.
    if (this.parked.has(agentId)) return;
    // Parking on a human is the other point where pending writes must surface: the
    // escalation often *is* "review the file I just wrote", and a waiting agent
    // reaches no terminal drain.
    this.drainFileEvents(agentId);
    const rule = this.opts.whitelistedApprovals.find((r) => reason.includes(r.match));
    if (rule) {
      // Auto-answer whitelisted prompts without bothering the human. No latch: the
      // agent is running again, so its next question is a fresh park.
      this.respond(agentId, rule.response);
      this.emit('autoAnswered', { agentId, taskId: task.id, reason, response: rule.response });
      return;
    }
    this.parked.add(agentId);
    // A fresh park is a fresh question, so last park's "it carried on anyway" must
    // not linger and mark the new alert stale on arrival.
    this.store.setAgentResumed(agentId, null);
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('waiting', { agentId, taskId: task.id, reason, ask });
  }

  /**
   * Park an agent because the *account* ran out, not because the agent asked
   * anything (issue #318).
   *
   * It is the same latch and the same three store writes as {@link handleWaiting},
   * and deliberately **not** the same event. `waiting` is what raises an escalation,
   * and an escalation is a question put to a human: this one has no answer, so an
   * inbox row carrying it would be a message nobody can reply to holding a slot in
   * the queue that means "somebody must answer this". What ends it instead is the
   * window turning over — {@link resumeExpiredParks} off the pulse, or an operator
   * ahead of it — which is why the park is announced on its own event and drawn on
   * the agent rather than in the inbox.
   *
   * Nothing is settled: the row keeps its session id, the task stays `waiting`
   * (outstanding, so the work is neither lost nor re-dispatched on top), and the
   * worktree stays on disk — all three are what {@link resumeParked} needs, and all
   * three are what recording this as `failed` used to throw away.
   */
  private handleLimited(agentId: string, task: Task, park: RateLimitPark): void {
    if (this.limited.has(agentId)) return;
    const reason = rateLimitParkReason(park);
    // Same reason as a question park: whatever the agent wrote before the limit bit
    // is part of the record an operator reads before deciding to resume.
    this.drainFileEvents(agentId);
    this.store.flushTranscript(agentId);
    const asked = this.parked.has(agentId);
    this.limited.set(agentId, { reason, resetsAt: park.resetsAt });
    this.parked.add(agentId);
    // The stop's countdown does not survive the account running out. A limit park
    // has its own ending — the window turning over — and settling it `done` on the
    // stop's clock throws away a conversation the account will continue in an hour.
    // The arm-time guard above cannot see this: the limit arrived *after* the clock.
    this.stalled.delete(agentId);
    this.store.setAgentResumed(agentId, null);
    // An agent that asked a question and *then* ran the account out keeps its
    // question on the row: the escalation it raised is still open and still the
    // thing a human must answer, and overwriting the reason with this one would
    // leave that inbox row pointing at a sentence about a limit. The limit is drawn
    // on the agent either way, from the park this registers.
    this.store.updateAgent(agentId, asked ? { status: 'waiting' } : { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('limited', { agentId, taskId: task.id, reason, resetsAt: park.resetsAt });
    // The process may have exited before it declared the park. In that order the
    // exit handler saw no limit yet, so shed the dead launch after the park lands.
    if (this.exited.has(agentId)) this.shedLimitedSession(agentId);
  }

  /**
   * Give back what the dead launch held while keeping the park itself — the
   * teardown a terminal transition would have done, minus the terminal.
   *
   * The spool and the MCP credential die with the process either way; leaving them
   * bound would leak a live bearer token for the length of a park, which can be
   * hours. `exited`/`exitCodes` are dropped for {@link kill}'s reason: no reap is
   * owed for a process whose work is unfinished, and a stale `exited` entry would
   * make the *resumed* run's first terminal reap a worktree out from under a live
   * agent.
   */
  private shedLimitedSession(agentId: string): void {
    this.disposeFileEvents(agentId);
    this.releaseMcp(agentId);
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exited.delete(agentId);
    this.store.updateAgent(agentId, { pid: null });
  }

  /** Put a limit park back after a resume that could not be carried out. */
  private reinstateLimitPark(agentId: string, task: Task, park: LimitPark): void {
    this.limited.set(agentId, park);
    this.parked.add(agentId);
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: park.reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
  }

  /**
   * Record that a *parked* agent made a tool call — it is working, not waiting.
   *
   * Deliberately does **not** un-park it. The park is a latch (see {@link parked})
   * and the runtime's own session status is `waiting` too, so flipping the row back
   * to `running` here would desynchronise the two and let the next turn-end file a
   * *second* escalation on top of the one this is meant to cast doubt on. The park
   * is the harness's model of the session; this is an observation about that model
   * being out of date, and the human resolves the disagreement by answering or
   * dismissing. Idempotent by intent — repeated tool calls just refresh the stamp.
   */
  private noteResumed(agentId: string, taskId: string): void {
    if (!this.parked.has(agentId)) return;
    // A tool call from a parked agent is the one thing that contradicts its clock:
    // whatever the park says, this agent is working, and settling it `done` under
    // its own hands is the one outcome the countdown must not have. The clock is
    // pushed out rather than dropped — dropping it would leave an agent that works
    // for one more minute and then goes quiet for good parked forever, which is the
    // state the countdown exists to end. Never pulled *in*: an operator's Extend
    // outlives any grace, so the later of the two stands.
    const clock = this.stalled.get(agentId);
    if (clock) clock.at = Math.max(clock.at, Date.now() + clock.grace);
    const resumedAt = new Date().toISOString();
    this.store.setAgentResumed(agentId, resumedAt);
    this.emit('resumed', { agentId, taskId, resumedAt });
  }

  /**
   * Drop the park latch without typing anything into the agent — what dismissing an
   * alert does. Releasing it is the whole point rather than a detail: while the
   * latch is held {@link handleWaiting} early-returns, so an agent whose alert was
   * dismissed could never raise another one. It leaves `status` alone, because the
   * session's own status is untouched and a dismissed alert makes no claim about
   * whether the agent is working.
   */
  releasePark(agentId: string): void {
    this.parked.delete(agentId);
    // Dismissing the alert is the operator saying the stop is not theirs to settle,
    // so the countdown goes with it: it is the clock on *that* item, and one left
    // running would finish an agent nobody is looking at any more.
    this.stalled.delete(agentId);
    this.store.setAgentResumed(agentId, null);
  }

  /** Roll back a spawn that threw before the session ever came up. */
  private failSpawn(agentId: string, taskId: string, err: Error): void {
    this.sessions.delete(agentId);
    this.store.appendTranscript(agentId, err.message);
    this.store.flushTranscript(agentId);
    this.store.updateAgent(agentId, { status: 'failed', endedAt: new Date().toISOString(), pid: null });
    this.store.updateTask(taskId, { status: 'failed' });
    this.opts.errors?.record({
      source: 'agent',
      message: `Agent ${agentId} failed to spawn (task ${taskId}): ${err.message}`,
    });
    this.reflectStatus(agentId, taskId, 'failed');
  }

  private handleTerminal(
    agentId: string,
    taskId: string,
    status: 'done' | 'failed',
    by: TerminalBy = 'agent',
    /** Appended to the recorded failure, e.g. how many automatic resumes were spent. */
    failureNote?: string,
  ): void {
    this.drainFileEvents(agentId); // catch a report written just before finishing
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.nudges.delete(agentId);
    this.stalled.delete(agentId);
    this.store.flushTranscript(agentId); // make the finished agent's transcript durable
    this.store.updateAgent(agentId, { status, endedAt: new Date().toISOString(), pid: null });
    this.store.updateTask(taskId, { status });
    this.sessions.delete(agentId);
    const exitCode = this.exitCodes.get(agentId);
    this.exitCodes.delete(agentId);
    if (status === 'failed') {
      // Surface the crash with its cause: the exit code (when the session exposed
      // one) plus a tail of the agent's output, so "why did it die" is answerable
      // from the Errors panel without digging through the transcript.
      this.opts.errors?.record({
        source: 'agent',
        message:
          `Agent ${agentId} failed (task ${taskId})` +
          `${exitCode !== undefined ? `, exit code ${exitCode}` : ''}${failureNote ? `, ${failureNote}` : ''}`,
        detail: recentOutputExcerpt(this.store.getTranscript(agentId)) || null,
      });
    }
    this.reflectStatus(agentId, taskId, status);
    this.emit('done', { agentId, taskId, status, by });
    this.terminals.set(agentId, status);
    this.maybeReap(agentId, taskId);
  }

  /** Emit 'reaped' once a finished agent's process has also exited (whichever came second). */
  private maybeReap(agentId: string, taskId: string): void {
    const status = this.terminals.get(agentId);
    if (!status || !this.exited.has(agentId)) return;
    this.terminals.delete(agentId);
    this.exited.delete(agentId);
    this.disposeFileEvents(agentId); // process is gone; drop its spool dir
    this.releaseMcp(agentId); // ...and with it the bridge that held the credential
    this.emit('reaped', { agentId, taskId, status });
  }

  /** Revoke an agent's MCP credential and remove its launch config. Idempotent. */
  private releaseMcp(agentId: string): void {
    const token = this.mcpTokens.get(agentId);
    if (!token) return;
    this.mcpTokens.delete(agentId);
    this.opts.mcp?.release(token);
  }

  private reflectStatus(agentId: string, taskId: string, status: AgentStatus): void {
    this.emit('status', { agentId, taskId, status });
  }

  // Typed emit/on overrides for a nicer call site.
  override emit<K extends keyof AgentManagerEvents>(event: K, ...args: AgentManagerEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof AgentManagerEvents>(event: K, listener: (...args: AgentManagerEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

/**
 * What a resumed agent is told. Deliberately not `buildResumeMessage`'s "you were
 * resumed after a server restart": nothing restarted, and an agent that believes
 * otherwise re-reads its branch looking for work it did itself minutes ago.
 */
const LIMIT_RESUME_MESSAGE =
  'This account hit its usage limit mid-turn, so the harness parked you. The limit has cleared and ' +
  'you have been resumed. Nothing else changed — the worktree and the conversation are the ones you ' +
  'left. Continue the task from where you stopped.';

/** How `claude` names each usage window, in words an operator reads. */
const LIMIT_WINDOWS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'seven-day',
  seven_day_opus: 'seven-day Opus',
  seven_day_sonnet: 'seven-day Sonnet',
  seven_day_overage_included: 'seven-day (overage included)',
  overage: 'overage',
};

/**
 * The sentence that goes on the row — and so onto every surface that draws a
 * parked agent. It has one job the status cannot do: say that the *account* ran
 * out rather than the agent, since "waiting" on its own reads as a question
 * somebody has failed to answer.
 *
 * An unknown window name is printed verbatim rather than dropped: `claude` may
 * add one, and a park that names no limit is the failure this exists to prevent.
 *
 * It ends on which of the two ways *this* park comes back, because they ask
 * different things of the person reading it: a park with a reset time needs
 * nothing from them, and one without needs them to come back. Telling every park
 * to "resume it once the limit clears" would have the cockpit ask for a press
 * that, on the overwhelming majority of parks, has already happened by itself.
 */
function rateLimitParkReason(park: RateLimitPark): string {
  const window = park.limitType ? (LIMIT_WINDOWS[park.limitType] ?? park.limitType) : null;
  const what = park.overage
    ? `this account's overage allowance is spent${window ? ` (${window})` : ''}`
    : `this account's ${window ? `${window} ` : ''}usage limit is spent`;
  const when = park.resetsAt ? `, and it resets at ${park.resetsAt}` : '';
  const ending = park.resetsAt
    ? 'the run carries on by itself once the window turns over'
    : 'resume it once the limit clears';
  return `Parked on a usage limit: ${what}${when}. Nothing is wrong with the run — ${ending}.`;
}

/**
 * Reduce a hook-reported write path to worktree-relative when it landed inside the
 * agent's cwd (so the artifact route — confined to the worktree — can serve it),
 * else leave it as reported. `claude`'s file tools report absolute paths.
 *
 * The result is normalised to forward slashes: on Windows `relative()` yields
 * `out\summary.md`, but the stored path is used as an artifact *ref* — served by
 * the URL-oriented `/api/artifacts/:id` route and displayed/linked in the cockpit
 * — so it must match the forward-slash form every other platform produces. `\` is
 * always a separator on the Windows paths these tools report, never a filename
 * char, and POSIX `relative()`/claude already emit `/`, so this is a no-op there.
 */
function toWorktreeRelative(cwd: string, p: string): string {
  const toPosix = (s: string): string => s.replace(/\\/g, '/');
  if (!isAbsolute(p)) return toPosix(p);
  const rel = relative(cwd, p);
  return toPosix(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p);
}
