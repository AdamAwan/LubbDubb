import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { IntegrationSelection } from './integrations/integration.js';
import { DEFAULT_CONTAINER_TYPES } from './issueRelations.js';
import { DEFAULT_PLANNING, type PlanningPolicy } from './plans/planning.js';
import { DEFAULT_VALIDATION, type ValidationPolicy } from './validation/policy.js';
import { DEFAULT_ASSESSMENT, type AssessmentPolicy } from './delivery/assessment.js';
import { DEFAULT_ASSAY, type AssayPolicy } from './intake/assay.js';
import { DEFAULT_RETROSPECTIVE, type RetrospectivePolicy } from './retro/retro.js';
import { validateCiPolicy, type CiPolicy } from './ci/ciPolicy.js';
import { validatePolicyCheckModes, type PolicyCheckModes } from './integrations/azure/policyKinds.js';

/** Operator control over the MCP tool channel. See {@link Config.mcp}. */
interface McpPolicy {
  /**
   * Wire the tool channel into agent launches. Off leaves every agent on the
   * sentinels and the `plan.json` file path — the same floor a failed socket
   * degrades to, so this is an escape hatch rather than a distinct mode.
   */
  enabled: boolean;
  /**
   * The permission backstop (issue #130 phase B). When on, a tool call the
   * `agentAllowedTools` allow-list doesn't cover is routed to the operator via
   * Claude Code's `--permission-prompt-tool` — it files an escalation in "Needs
   * you" and blocks the *same* live agent until the operator allows or denies,
   * rather than the agent hanging on a prompt no human can answer. Off falls back
   * to Claude's default headless behaviour for an un-allowlisted tool (a silent
   * deny). Gated by {@link McpPolicy.enabled} — the tool lives on the MCP server.
   * Defaults on. See `docs/spec/10-agent-runtimes.md`.
   */
  permissionEscalation: boolean;
}

/**
 * Central configuration. Everything the operator can tune lives here.
 *
 * Values come from (in order of precedence): explicit overrides, a
 * `lubbdubb.config.json` file at the repo root, then these defaults.
 */
export interface Config {
  /** How often the heartbeat fires a dispatch cycle. */
  heartbeatIntervalMs: number;
  /** Hard cap on concurrently-running agents. Runtime-adjustable via the control endpoint. */
  maxConcurrentAgents: number;
  /**
   * Boot in a paused state (no new agents dispatched until resumed). Off by
   * default. The only config-level pause knob — live pause/resume is runtime-only
   * and ephemeral, so a restart reverts to this value.
   */
  startPaused: boolean;
  /** PTY prompt substrings the harness may auto-answer instead of escalating. */
  whitelistedApprovals: WhitelistRule[];
  /** Confidence-gated auto-send policy for side-effectful actions. Off by default. */
  autoSend: AutoSendConfig;
  /**
   * Which provider fulfils each integration capability. The swap switch: point a
   * capability at a different provider (e.g. `sourceControl: "github"`) to change
   * where that slice of the world comes from — no code change. Defaults to the
   * built-in `fake` provider for every capability.
   */
  integrations: IntegrationSelection;
  /**
   * GitHub target + optional scope filters, required when a capability uses the
   * `github` provider. The auth token is deliberately NOT here — it comes from the
   * `GITHUB_TOKEN` env var so a secret never lands in a committed config file.
   */
  github?: GitHubConfig;
  /**
   * Azure DevOps target + optional scope filters, required when a capability uses
   * the `azure` provider. Auth is deliberately NOT here: a PAT comes from the
   * `AZURE_DEVOPS_PAT` env var, and if that is unset the logged-in `az` CLI is
   * used — so a secret never lands in a committed config file.
   */
  azureDevOps?: AzureDevOpsConfig;
  /**
   * The prefix behind the cockpit's watch/ignore toggle, shared by PRs and
   * issues. It derives two labels — `${labelPrefix}-watch` ("work this") and
   * `${labelPrefix}-ignore` ("leave this alone") — read by the dispatcher gates and
   * written by the toggle (see {@link watchLabelsFor}/{@link resolveWatchState}).
   * The no-tag default differs by type: PRs are opt-out (watched unless ignored),
   * issues are opt-in (ignored unless watched). Defaults to `"lubbdubb"`,
   * so `lubbdubb-ignore` keeps its historical meaning as the PR exclusion tag.
   */
  labelPrefix: string;
  /**
   * Tighten the issue *watch* gate so `${labelPrefix}-watch` only counts if *you*
   * (the authenticated account the provider runs as) added it — a tag someone else
   * adds is ignored. Stops another user from tagging a work item / issue to get an
   * agent onto it. Off by default (any tagger counts). Only meaningful with a real
   * provider (`github`/`azure`) that can resolve tag authorship; the `fake` provider
   * doesn't track it, so nothing passes the gate when this is on.
   */
  issuePickupRequireOwnLabel: boolean;
  /**
   * Label → priority weight for ordering issue pickup: when headroom is limited,
   * higher-weight issues are dispatched first. Replaced wholesale by an override
   * (not merged), so an operator can define their own scheme.
   */
  issuePriorityLabels: Record<string, number>;
  /** Weight for an issue carrying no matching priority label. */
  issueDefaultPriority: number;
  /**
   * Dispatcher-level, state-based pickup gate. When non-empty, only issues whose
   * provider-native workflow state is in this list are picked up — e.g.
   * `["Ready", "Doing"]` for Azure DevOps, so items sitting in "In Review"/"New"
   * are left alone. Meaningful only for providers with a richer state model than
   * open/closed (Azure work items); GitHub issues carry no such state and are
   * unaffected. Unset/empty (the default) = no state gate, act on all open issues.
   */
  issuePickupStates?: string[];
  /**
   * The state a work item is moved to once a pull request is open for it, so agents
   * stop re-picking work that's already done and waiting on review/CI — e.g.
   * `"In Review"` for Azure DevOps. Takes effect only alongside `issuePickupStates`
   * (the dispatcher advances an item *out of* a pickup state) and needs a provider
   * that can write the state back (Azure). Unset (the default) = no automatic
   * transition.
   */
  issueInReviewState?: string;
  /**
   * Provider-native item types that *hold* work rather than being work — Azure
   * DevOps Features and Epics. An item of one of these types is never picked up,
   * planned or assayed: its children are the work, and an agent put on the
   * container would implement a decomposition that already exists beside it in the
   * tracker. Meaningful only for providers that report an item type (Azure);
   * GitHub issues carry none and are unaffected. Defaults to
   * `["Feature", "Epic"]`; set `[]` to turn the gate off, or list your own process
   * template's names (matched case-insensitively).
   */
  issueContainerTypes: string[];
  /**
   * The planning funnel for multi-PR issues. **On by default**: every watched open
   * issue gets a planning agent before any implementation work, and its verdict —
   * one PR or several — is put to you before any agent is spent (`requireApproval`). Off
   * leaves it out entirely — rule `issue-pickup` un-narrowed, no planner ever dispatched,
   * behaviour exactly what it is without plans. Deep-merged, so one field can be
   * set alone. Only the `rule` dispatcher implements the funnel.
   */
  planning: PlanningPolicy;
  /**
   * The assessor (rule `issue-assess`) — the harness asking whether an issue that has had work
   * and has nothing in flight is actually finished, and parking it as `delivered`
   * if so. **On by default**, with the cost stated: it spends an agent per assessed
   * issue and its `delivered` verdict gates pickup. Off, no assessor is dispatched,
   * no verdict is written, and rule `issue-pickup` behaves as it did before the assessor
   * existed — which on GitHub means a merged PR's issue is picked up again.
   * Deep-merged. Only the `rule` dispatcher implements it.
   */
  assessment: AssessmentPolicy;
  /**
   * The goal assay (rule `issue-assay`) — the harness asking whether a fresh issue's *text*
   * can be worked from at all, before anything is dispatched against it (issue
   * #158). **On by default**, with the cost named rather than discovered: with
   * `planning`, `assessment`, this and the retrospective all on, one issue can
   * spend an assayer, a planner, its part agents, an assessor and a writer. Only
   * an explicit `unclear` verdict holds anything, and it ends the moment the
   * ticket is edited or anyone comments. Off, no assayer is dispatched and every
   * gate in front of an issue behaves as it did. Deep-merged. Only the `rule`
   * dispatcher implements it.
   */
  assay: AssayPolicy;
  /**
   * The retrospective (rule `issue-retro`) — one desk agent writing up a goal the harness has
   * parked as delivered: what shipped, and what came out of the process of
   * shipping it, from the issue's scratchpad plus the record the harness kept.
   * **On by default**, unlike its three neighbours above: it runs once, after the
   * work is over, and it gates nothing, so it can neither park an issue nor delay
   * anything. Off, the Goal Floor's Manifest station reads *Nothing written* and
   * no agent is spent. Deep-merged. Only the `rule` dispatcher implements it.
   */
  retrospective: RetrospectivePolicy;
  /**
   * The validation plan (`src/validation/`) — how anyone checks the *goal* was
   * met, as steps a person or an agent runs rather than as a paragraph nobody
   * ever executes. **On by default**, unlike the three funnels above, because it
   * spends no agent and gates nothing: a planner is asked for checks, a person
   * marks them off, and the only consequence is that closing a goal with checks
   * outstanding says so. Off leaves the surface out entirely. Deep-merged.
   */
  validation: ValidationPolicy;
  /**
   * The typed tool channel back to the harness — the `lubbdubb` MCP server every
   * spawned agent is wired to (issue #108).
   *
   * **On by default**, because it is purely additive: it adds tools an agent may
   * use, and changes nothing about how one is dispatched, parked or finished. The
   * sentinels remain the floor everything degrades to, and the `plan.json` side
   * channel stays wired, so turning this off — or having it fail to start — leaves
   * behaviour byte-for-byte as it was. That is the opposite trade from `planning`,
   * which is off by default precisely because it *does* change what the fleet does.
   */
  mcp: McpPolicy;
  /**
   * How far back a provider looks for pull requests that have *left* the open set,
   * so a merged or abandoned PR is observed rather than inferred from its
   * disappearance. Feeds `WorldSnapshot.closedPullRequests`, which drives the
   * cockpit's "recently closed" list, the `pr_merged`/`pr_closed` world events, and
   * plan reconciliation's ability to tell a merge from an abandonment.
   *
   * Costs one extra list request per snapshot per provider (no per-PR fan-out —
   * closed PRs are read in summary form only), bounded by this window. Defaults to
   * 6 hours; `0` disables the lookup entirely, which is a supported configuration:
   * every consumer falls back to the older "absence means merged" reading.
   */
  closedPrWindowMs: number;
  /**
   * Per-check CI policy: what the harness does about *which* check went red
   * (`src/ci/ciPolicy.ts`). Rules are ordered and matched by glob against the
   * check name; the first match wins.
   *
   * Empty by default, and empty means today's behaviour — any failing check gets
   * a code agent with the generic fix prompt. A check matching no rule keeps that
   * behaviour too, so this is purely a way to carve exceptions: a check somebody
   * else owns (`onFailure: 'ignore'`), one worth a human's eye rather than an
   * agent's (`'escalate'`), or one whose fix has a house recipe (`guidance`).
   */
  ci: CiPolicy;
  /**
   * How long an operator "Up next" priority override (issue #128) survives after
   * the harness stops tracking its origin. The override's `last_seen_at` is
   * refreshed every pulse the origin is still a live candidate or staffed, so a
   * long-running item keeps its priority; once the work is gone (merged, closed,
   * abandoned) for this long, the stale override is pruned rather than lingering
   * forever. Defaults to 7 days; `0` disables pruning entirely (supported).
   */
  upNextOverrideTtlMs: number;
  /**
   * How agents are launched.
   * - `stream`: real Claude Code over headless stream-JSON (`-p --output-format
   *   stream-json`). No TUI, runs unattended, supports the waiting/answer loop.
   *   The production default.
   * - `pty`: real Claude Code as an interactive terminal session. Requires a
   *   claude that has completed first-run onboarding; kept for interactive use.
   * - `raw`: run `claudeCommand`/`claudeArgs` verbatim, passing the prompt via
   *   the `LUBBDUBB_PROMPT` env var. Used by the mock-agent demo and tests.
   *
   * In all `claude` modes the harness injects its status protocol via an
   * appended system prompt and sets a permission mode.
   */
  agentMode: 'stream' | 'pty' | 'raw';
  /**
   * Where Claude Code keeps per-project session transcripts, which PTY mode tails
   * for its transcript. Defaults to `~/.claude/projects`; override only if the
   * agent runs with a different HOME than the server.
   */
  sessionTranscriptRoot?: string;
  /** Passed to `claude --permission-mode` so unattended tool calls don't hang the agent. */
  agentPermissionMode: string;
  /**
   * Tool allow rules handed to every agent as a `permissions.allow` fragment in
   * `--settings` (issue #130). `acceptEdits` auto-accepts *file edits only*, so a
   * headless agent with no human at the prompt hangs the moment it runs `npm run
   * check`, `git` or `gh`. These rules pre-approve exactly those mechanical
   * validate/commit/push commands so the default config completes a task
   * unattended — without the all-or-nothing `bypassPermissions`. Anything *not*
   * listed still falls through to the permission prompt, which the backstop
   * (`agentPermissionEscalation`) routes to the operator rather than hanging.
   *
   * These are **not** put on `--allowedTools`: that flag carries the MCP tool
   * grants, and mixing a Bash rule into it risks silently dropping them (the drift
   * `src/mcp/names.ts` guards against). Use Claude Code's rule syntax, e.g.
   * `"Bash(npm:*)"`, `"Bash(git diff:*)"`.
   */
  agentAllowedTools: string[];
  /** Wait this long after spawn before typing the task in, giving the REPL time to boot. */
  agentPromptDelayMs: number;
  /**
   * Gap between typing a message and sending the submitting carriage return (PTY
   * only). The claude TUI folds a single input burst into a paste and treats a
   * trailing CR as a literal newline, so a glued-on CR leaves the text sitting in
   * the input unsubmitted; the gap lands the CR as a distinct Enter keypress.
   */
  agentSubmitDelayMs: number;
  /**
   * Safety net for a turn that ends without a sentinel (PTY only). An agent that
   * asks for review in prose and stops leaves the harness with no signal at all —
   * status stays `running` and nothing reaches the inbox. After this long with no
   * terminal output at all (the TUI repaints at least once a second while it's
   * working, so silence means it's parked at the prompt), the session is parked as
   * waiting. Unlatched: output resuming un-parks it. 0 disables.
   */
  agentIdleWaitMs: number;
  /** Extra literal substrings that mean "the CLI is waiting for input" (backup escalation). */
  agentWaitingPatterns: string[];
  /** Command used to launch an agent session (overridable for tests). */
  claudeCommand: string;
  /** Extra args passed to the agent command. */
  claudeArgs: string[];
  /**
   * Folder(s) the file-events hook treats as the artifacts area: any file an
   * agent writes *under* a prefix is promoted to an artifact chip regardless of
   * extension (on top of the built-in report/doc heuristic). Accepts one prefix
   * or a list; a file promotes if it's under *any* entry. E.g. `"docs"` promotes
   * everything the agent drops in `docs/`. Unset = fall back to the extension
   * allowlist + `reports/` convention only.
   *
   * A **relative** entry is worktree-relative (matched per agent worktree). An
   * **absolute** entry (e.g. `"D:/docs"`) matches files written under that real
   * directory even when it lives *outside* the worktree, and — being operator
   * configured — widens the artifact-serving boundary to include that root (see
   * `resolveConfinedArtifact`). Not resolved at load: relative stays relative
   * (each agent's worktree differs), absolute stays absolute.
   */
  docsFolderPrefix?: string | string[];
  /**
   * Directory of operator overrides for the rule dispatcher's agent/escalation
   * prompts. Each `<prompt-id>.md` file replaces that prompt's built-in default
   * (see `src/dispatcher/promptTemplates.ts`); ids without a file keep the
   * default. A file may start with an `<!-- ... -->` doc header describing what
   * it's for — that header is stripped before the prompt reaches the agent.
   * Defaults to `.lubbdubb/prompts`; absent directory => all built-in defaults.
   */
  promptTemplatesDir: string;
  /** Root under which per-branch worktrees are created. */
  worktreeRoot: string;
  /** Root under which desk (no-code) scratch dirs are created. */
  deskRoot: string;
  /**
   * Root under which images attached to a blueprint are stored (issue #249).
   * Deliberately **outside every worktree**, so a screenshot can never be
   * committed onto a branch, and canonical rather than copied per dispatch — one
   * file is what lets the planner, each part agent and the retrospective read the
   * same image.
   *
   * Every agent the harness launches is granted read access to this whole root
   * via `permissions.additionalDirectories`, for the life of the launch. That is a
   * real widening: an agent working an unrelated goal can read another goal's
   * attachments. It is the harness's own directory and nothing else writes there,
   * and it is a config key so a deployment that wants it elsewhere (a tmpfs, a
   * per-tenant path) can say so.
   */
  attachmentRoot: string;
  /**
   * Root under which a goal's validation resources are kept — the fixtures,
   * reference material and sample data a check needs, one directory per goal
   * (`<root>/issue-284/`).
   *
   * `attachmentRoot`'s storage rule, argument for argument, because it is the
   * same problem: **outside every worktree**, so a fixture can never be committed
   * onto a branch and outlives the worktree reap that removes the agent that used
   * it; **canonical rather than copied per dispatch**, so the planner, each
   * validating agent and the operator read one file; and **a config key**, so a
   * deployment wanting a tmpfs or a per-tenant path can say so. Every launched
   * agent is granted read access to the whole root, the same real widening
   * attachments already make.
   */
  validationRoot: string;
  /** The git repo the harness operates on (worktrees are cut from here). */
  repoRoot: string;
  /**
   * The repository's integration branch — what a new agent branch is cut from and
   * what a PR is expected to target. Defaults to `"main"`. It was previously an
   * incidental fallback in two places rather than real config, which meant a new
   * agent branch actually forked from whatever `repoRoot` happened to be checked
   * out on. Not auto-detected: the harness may run against a clone whose HEAD is
   * anywhere, and a wrong guess silently mis-bases work.
   */
  defaultBranch: string;
  /**
   * Delete the branch behind a pull request once the harness observes it **merged**
   * — the worktree and local ref, then the branch on the remote. On by default:
   * leaving a dead branch on both sides of every landed PR is an omission rather
   * than a policy, and a long-running deployment accumulates one per merge forever.
   *
   * Set `false` on a repository where a merged branch is somebody else's
   * expectation (a deploy pipeline that reads it, a mirror that tracks it). Nothing
   * else changes: the reap writes nothing that another rule reads.
   *
   * Only the harness's own pull requests are ever reaped, on the same
   * `filters.prAuthor` test the naming convention uses, and never a branch another
   * open PR still targets. → `src/branchReap.ts`.
   */
  reapMergedBranches: boolean;
  /** SQLite file. */
  dbPath: string;
  /** HTTP/WS port. */
  port: number;
  /**
   * Address the HTTP/WS server binds to. Defaults to `127.0.0.1`: the cockpit can
   * queue a job, which spawns an agent with write access to the repo and the
   * launching shell's environment, so reachability is a decision an operator
   * should make deliberately rather than inherit. Set `"0.0.0.0"` to expose it on
   * the network — `auth.enabled: false` is refused in that combination at load.
   */
  host: string;
  /** Cockpit access control. See `src/server/auth.ts`. */
  auth: AuthConfig;
}

/**
 * Bearer-token access control for the cockpit surface.
 *
 * There is deliberately **no `token` field**: `Config` holds no secrets (the same
 * rule that keeps the GitHub token in `GITHUB_TOKEN` alone), and this file is the
 * one an operator pastes when asking for help. The token comes from
 * `LUBBDUBB_TOKEN` or is minted into {@link AuthConfig.tokenFile} at 0600.
 */
interface AuthConfig {
  /**
   * Master switch, **on by default** — unlike `autoSend` and `planning`, which
   * are off because they act on the world. This one only refuses callers, and an
   * off-by-default guard is one nobody turns on.
   */
  enabled: boolean;
  /** Where a minted token is persisted. Relative paths resolve against the launch directory. */
  tokenFile: string;
}

export interface GitHubConfig {
  /** Repository owner (user or org). */
  owner: string;
  /** Repository name. */
  repo: string;
  /**
   * Login that issues **the harness files** are assigned to — the operator who
   * asked for them. Rides in the tracker coordinates every filing prompt renders
   * (`src/ticketAssignment.ts`); unset means filed unassigned, which is in
   * nobody's queue. Not a filter: it never narrows what is picked up.
   */
  defaultAssignee?: string;
  /** Optional filters narrowing what the harness picks up. */
  filters?: {
    /** Only surface PRs opened by this login. Unset = all open PRs. */
    prAuthor?: string;
  };
}

export interface AzureDevOpsConfig {
  /** Organization (the `dev.azure.com/{organization}` segment). */
  organization: string;
  /** Project name — work items are scoped to it. */
  project: string;
  /** Git repository name within the project. */
  repository: string;
  /**
   * uniqueName (UPN) that work items **the harness files** are assigned to.
   * Defaults to `filters.workItemAssignedTo` when unset: where that filter is
   * set, an item filed to anyone else is not surfaced by the harness that filed
   * it. → `src/ticketAssignment.ts`.
   */
  defaultAssignee?: string;
  /** Optional filters narrowing what the harness picks up. */
  filters?: {
    /** Only surface PRs opened by this uniqueName (UPN). Unset = all active PRs. */
    prAuthor?: string;
    /** Only surface work items carrying this tag. Unset = all open work items. */
    workItemTag?: string;
    /** Only surface work items assigned to this uniqueName (UPN). Unset = all assignees. */
    workItemAssignedTo?: string;
  };
  /**
   * Which branch-policy kinds become CI checks, and how.
   *
   * `check` makes a kind an ordinary check — visible, routable by a `ci.checks`
   * rule, dispatchable. `advisory` makes it visible and structurally unable to
   * dispatch or escalate. `off` drops it. Unset kinds take the defaults: `build`
   * and `status` are `check` (Optional policies included), `comments` is
   * `advisory`, everything else is `off`.
   *
   * Widening this can never make a PR read as unable to merge: the aggregate
   * `ciStatus` folds enabled, blocking build/status policies only, and nothing
   * here reaches it.
   */
  policyChecks?: PolicyCheckModes;
}

export interface WhitelistRule {
  /** Substring matched against the agent's waiting prompt. */
  match: string;
  /** The text automatically typed back into the session. */
  response: string;
}

/**
 * When may the harness take a side-effectful action (e.g. posting a PR reply)
 * on its own, instead of drafting it and escalating for sign-off?
 *
 * Disabled by default: with `enabled: false` the harness never sends
 * autonomously — it always drafts and escalates, preserving the v1 guarantee
 * that nothing side-effectful leaves without an explicit human action.
 */
export interface AutoSendConfig {
  /** Master switch. Off by default. */
  enabled: boolean;
  /** Minimum dispatcher confidence (0..1) required to send instead of escalate. */
  confidenceThreshold: number;
  /** Which action types are eligible for auto-send (e.g. `["reply_on_pr"]`). */
  allowedActions: string[];
}

const DEFAULTS: Config = {
  heartbeatIntervalMs: 5 * 60 * 1000,
  maxConcurrentAgents: 3,
  startPaused: false,
  whitelistedApprovals: [],
  autoSend: { enabled: false, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] },
  integrations: { sourceControl: 'fake', issues: 'fake' },
  labelPrefix: 'lubbdubb',
  issuePickupRequireOwnLabel: false,
  issuePriorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  issueDefaultPriority: 2,
  issueContainerTypes: [...DEFAULT_CONTAINER_TYPES],
  // Each policy's own module owns the operator default; the dispatcher's fallback
  // for an *omitted* policy is a separate answer (off) and lives with the rules.
  planning: DEFAULT_PLANNING,
  assessment: DEFAULT_ASSESSMENT,
  assay: DEFAULT_ASSAY,
  retrospective: DEFAULT_RETROSPECTIVE,
  validation: DEFAULT_VALIDATION,
  mcp: { enabled: true, permissionEscalation: true },
  closedPrWindowMs: 6 * 60 * 60 * 1000,
  ci: { checks: [] },
  upNextOverrideTtlMs: 7 * 24 * 60 * 60 * 1000,
  agentMode: 'stream',
  agentPermissionMode: 'acceptEdits',
  // The mechanical validate/commit/push commands a coding agent must run to take
  // an issue through to an opened PR unattended: the JS toolchain (validate), git
  // (commit/push) and gh (open the PR). Everything else still prompts and is
  // routed to the operator by the permission backstop rather than hanging (#130).
  agentAllowedTools: [
    'Bash(npm:*)',
    'Bash(npx:*)',
    'Bash(pnpm:*)',
    'Bash(yarn:*)',
    'Bash(node:*)',
    'Bash(git:*)',
    'Bash(gh:*)',
  ],
  agentPromptDelayMs: 1200,
  agentSubmitDelayMs: 60,
  agentIdleWaitMs: 90_000,
  agentWaitingPatterns: [],
  claudeCommand: 'claude',
  claudeArgs: [],
  promptTemplatesDir: '.lubbdubb/prompts',
  worktreeRoot: '.lubbdubb/worktrees',
  deskRoot: '.lubbdubb/desk',
  attachmentRoot: '.lubbdubb/attachments',
  validationRoot: '.lubbdubb/validation',
  repoRoot: process.cwd(),
  defaultBranch: 'main',
  reapMergedBranches: true,
  dbPath: '.lubbdubb/lubbdubb.sqlite',
  port: 4300,
  host: '127.0.0.1',
  auth: { enabled: true, tokenFile: '.lubbdubb/cockpit-token' },
};

/**
 * Resolve the five path fields against the roots they belong to, in place.
 *
 * Lifted out of {@link loadConfig} so a *baseline* config can be built by the
 * same rules (see {@link defaultConfig}). Comparing a running config against the
 * raw {@link DEFAULTS} would report `repoRoot`, `worktreeRoot`, `deskRoot`,
 * `attachmentRoot` and `promptTemplatesDir` as operator-customised on every
 * deployment, since these five are literals there and absolute here.
 */
function resolveRootPaths(merged: Config): void {
  // The repo defaults to wherever the app is launched (`process.cwd()`). A
  // relative override (config file or env) is resolved to absolute here: git runs
  // with `cwd: repoRoot` and agents run in a worktree/scratch cwd, so a path left
  // relative would resolve against the wrong directory once work is dispatched.
  merged.repoRoot = resolve(process.cwd(), merged.repoRoot);

  // Agents' working roots belong to the repo the harness operates on, not to
  // wherever the app happens to be launched. `git worktree add` runs with
  // `cwd: repoRoot`, but the worktree directory is built from `worktreeRoot`, and
  // the desk scratch dir from `deskRoot` — both default to relative paths. Resolve
  // them against `repoRoot` (not `process.cwd()`) so running LubbDubb from its own
  // folder against a repo elsewhere doesn't scatter that repo's worktrees into the
  // app's directory. An absolute override is honoured as-is. When repoRoot is the
  // launch dir (the single-repo default) this is a no-op.
  merged.worktreeRoot = resolve(merged.repoRoot, merged.worktreeRoot);
  merged.deskRoot = resolve(merged.repoRoot, merged.deskRoot);
  // Attachments belong to the repo being operated on for the same reason, and the
  // absolute path is load-bearing twice over: it is what an agent's prompt names,
  // and what the launch grants read access to.
  merged.attachmentRoot = resolve(merged.repoRoot, merged.attachmentRoot);
  // And validation resources for both of those reasons at once: an agent's prompt
  // names the absolute path, and the launch grants read access to it.
  merged.validationRoot = resolve(merged.repoRoot, merged.validationRoot);

  // Prompt overrides belong to the repo being operated on, like the worktree
  // roots above — resolve relative to repoRoot, honour an absolute override.
  merged.promptTemplatesDir = resolve(merged.repoRoot, merged.promptTemplatesDir);
}

/**
 * The config a deployment that configures nothing runs on — every built-in
 * default, put through the same path resolution {@link loadConfig} applies.
 *
 * Deliberately not `DEFAULTS` itself: the caller is the running-config viewer,
 * which reads this to decide which values an operator actually chose, and the
 * raw literals would make four path fields read as chosen everywhere.
 */
export function defaultConfig(): Config {
  const base: Config = { ...DEFAULTS };
  resolveRootPaths(base);
  return base;
}

/**
 * Keys that used to mean something and no longer do, each with the reason.
 *
 * A removed key merges into nothing and takes the default, so an operator who
 * had chosen the behaviour watches the harness do the opposite of what their
 * file says while the file goes on saying it. Same argument as
 * {@link validatePolicyCheckModes}' typo'd kind: refuse at load, name the key,
 * say what to do. The entries are permanent — a config written before the
 * removal outlives the release that made it.
 */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
  dispatcher:
    'the "claude" dispatcher was removed and the rule dispatcher is the only one, so there is nothing left to select',
  steeringPriorities: 'it was only ever injected into the removed "claude" dispatcher\'s prompt and now steers nothing',
};

/**
 * Nested keys that used to be switches and are not any more, each with the reason.
 *
 * These **warn and are dropped**, where {@link REMOVED_KEYS} refuses — and the
 * difference is what the operator's file is asking for. A removed top-level key
 * names behaviour that no longer exists either way, so refusing is the only
 * honest answer. `planning.enabled` and `validation.enabled` named subsystems
 * that are now unconditional, so a file setting either is asking for something
 * the harness either already does or will never do again: refusing would take a
 * running deployment down at boot over one stale line. Dropped rather than left
 * to merge into nothing, so the value cannot survive on the policy object and be
 * read by something later.
 *
 * A file asking for `false` is the case the warning is for: that deployment is
 * getting the funnel it switched off, and it has to hear so from the boot log
 * rather than from the fleet's behaviour. The entries are permanent — a config
 * written before the removal outlives the release that made it.
 */
const RETIRED_NESTED_KEYS: Readonly<Record<string, string>> = {
  'planning.enabled': 'the planning funnel is always on — every goal is planned',
  'validation.enabled': 'validation plans are always on',
};

function dropRetiredKeys(fromFile: Partial<Config>, filePath: string): void {
  for (const [path, why] of Object.entries(RETIRED_NESTED_KEYS)) {
    const [block, key] = path.split('.') as [keyof Config, string];
    const nested: unknown = fromFile[block];
    if (typeof nested !== 'object' || nested === null || !Object.hasOwn(nested, key)) continue;
    delete (nested as Record<string, unknown>)[key];
    console.warn(
      `[lubbdubb] ${filePath} sets "${path}", which no longer exists — ${why}. Ignoring it; delete the key.`,
    );
  }
}

function refuseRemovedKeys(fromFile: object, filePath: string): void {
  for (const [key, why] of Object.entries(REMOVED_KEYS)) {
    if (!Object.hasOwn(fromFile, key)) continue;
    throw new Error(`Refusing to start: ${filePath} sets "${key}", which no longer exists — ${why}. Delete the key.`);
  }
}

/**
 * Deep-merge one config layer over another, the way {@link loadConfig} merges a
 * layer over {@link DEFAULTS}: the nested policy blocks merge field by field,
 * everything else is last-writer-wins.
 *
 * Only {@link loadDeploymentConfig} needs this — it has three layers (file, env,
 * explicit) to fold into the one `overrides` argument `loadConfig` takes, and a
 * shallow fold would let an explicit `{planning: {enabled: true}}` drop the
 * `planning` fields the operator's file set.
 */
function mergeLayers(lower: Partial<Config>, upper: Partial<Config>): Partial<Config> {
  const merged: Partial<Config> = { ...lower, ...upper };
  if (lower.autoSend ?? upper.autoSend)
    merged.autoSend = { ...DEFAULTS.autoSend, ...lower.autoSend, ...upper.autoSend };
  if (lower.integrations ?? upper.integrations)
    merged.integrations = { ...DEFAULTS.integrations, ...lower.integrations, ...upper.integrations };
  if (lower.planning ?? upper.planning)
    merged.planning = { ...DEFAULTS.planning, ...lower.planning, ...upper.planning };
  if (lower.assessment ?? upper.assessment)
    merged.assessment = { ...DEFAULTS.assessment, ...lower.assessment, ...upper.assessment };
  if (lower.assay ?? upper.assay) merged.assay = { ...DEFAULTS.assay, ...lower.assay, ...upper.assay };
  if (lower.retrospective ?? upper.retrospective)
    merged.retrospective = { ...DEFAULTS.retrospective, ...lower.retrospective, ...upper.retrospective };
  if (lower.validation ?? upper.validation)
    merged.validation = { ...DEFAULTS.validation, ...lower.validation, ...upper.validation };
  if (lower.mcp ?? upper.mcp) merged.mcp = { ...DEFAULTS.mcp, ...lower.mcp, ...upper.mcp };
  if (lower.auth ?? upper.auth) merged.auth = { ...DEFAULTS.auth, ...lower.auth, ...upper.auth };
  return merged;
}

/**
 * The config a *deployment* runs on: {@link loadConfig} plus the two ambient
 * layers — a `lubbdubb.config.json` in the launch directory and the handful of
 * env overrides — folded in underneath the explicit ones.
 *
 * **This, not `loadConfig`, is what a process entry point calls.** The ambient
 * layers live here rather than in `loadConfig` because they make the config a
 * function of the machine it loads on: the test suite runs in a working copy of
 * this repo, so an operator's own `lubbdubb.config.json` sitting next to it would
 * merge into every test that builds a config — silently, and differently on every
 * developer's machine. A test wants defaults plus what it wrote; only a
 * deployment wants the environment.
 */
export function loadDeploymentConfig(overrides: Partial<Config> = {}): Config {
  const filePath = resolve(process.cwd(), 'lubbdubb.config.json');
  let fromFile: Partial<Config> = {};
  if (existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
    }
    if (typeof parsed === 'object' && parsed !== null) refuseRemovedKeys(parsed, filePath);
    fromFile = parsed as Partial<Config>;
    dropRetiredKeys(fromFile, filePath);
  }
  const fromEnv: Partial<Config> = {};
  if (process.env.PORT) fromEnv.port = Number(process.env.PORT);
  if (process.env.LUBBDUBB_HOST) fromEnv.host = process.env.LUBBDUBB_HOST;
  if (process.env.LUBBDUBB_DB) fromEnv.dbPath = process.env.LUBBDUBB_DB;
  if (process.env.LUBBDUBB_REPO_ROOT) fromEnv.repoRoot = process.env.LUBBDUBB_REPO_ROOT;
  return loadConfig(mergeLayers(mergeLayers(fromFile, fromEnv), overrides));
}

/**
 * Defaults, the caller's overrides, path resolution and validation — and nothing
 * ambient. Reads no file and no env var, so the same arguments give the same
 * config on any machine; {@link loadDeploymentConfig} is the entry point that
 * adds the operator's file and environment on top.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const merged = { ...DEFAULTS, ...overrides };

  resolveRootPaths(merged);

  // autoSend is a nested object: deep-merge it so an override can set just one
  // field (e.g. only `enabled`) without dropping the defaults for the rest.
  merged.autoSend = { ...DEFAULTS.autoSend, ...overrides.autoSend };

  // integrations is a nested per-capability map: deep-merge it too, so an
  // override can swap just one capability's provider without having to re-list
  // the defaults for the others.
  merged.integrations = { ...DEFAULTS.integrations, ...overrides.integrations };

  // planning is nested too — deep-merge so `{"enabled": true}` alone keeps the
  // default part-concurrency cap instead of leaving it undefined.
  merged.planning = { ...DEFAULTS.planning, ...overrides.planning };
  merged.assessment = { ...DEFAULTS.assessment, ...overrides.assessment };
  merged.assay = { ...DEFAULTS.assay, ...overrides.assay };
  merged.retrospective = { ...DEFAULTS.retrospective, ...overrides.retrospective };
  merged.validation = { ...DEFAULTS.validation, ...overrides.validation };

  // Same treatment for the tool channel, so `{"mcp": {}}` is the default rather
  // than an accidental off.
  merged.mcp = { ...DEFAULTS.mcp, ...overrides.mcp };

  // And for auth, so `{"auth": {"tokenFile": "..."}}` doesn't silently disable it.
  merged.auth = { ...DEFAULTS.auth, ...overrides.auth };

  // The CI check rules are an ordered list, so this is a replace and not a merge:
  // there is no sensible way to deep-merge two orderings, and a caller that sets
  // `ci` means the list it wrote.
  merged.ci = { checks: overrides.ci?.checks ?? DEFAULTS.ci.checks };
  validateCiPolicy(merged.ci);

  // A typo'd policy kind would otherwise be silently ignored, and the operator
  // would watch a check they believed they had configured behave as if they had not.
  if (merged.azureDevOps?.policyChecks) validatePolicyCheckModes(merged.azureDevOps.policyChecks);

  // The one configuration that is never what anyone means. Turning auth off is a
  // supported local choice (it is how the test suite runs); binding a routable
  // address is a supported deliberate one. Together they publish an endpoint that
  // spawns agents with repo write to every peer on the network, so the pair is
  // refused here rather than warned about — a warning scrolls past a boot log.
  if (merged.host !== '127.0.0.1' && merged.host !== 'localhost' && merged.host !== '::1' && !merged.auth.enabled) {
    throw new Error(
      `Refusing to start: host "${merged.host}" is reachable off this machine and auth.enabled is false. ` +
        `The cockpit can queue jobs, which spawn agents with write access to your repo. ` +
        `Either bind 127.0.0.1 (the default) or leave auth on.`,
    );
  }

  // Agents run in a worktree/scratch cwd, so any relative script path in
  // claudeArgs (e.g. the demo mock-agent) must be made absolute up front or the
  // agent's shell can't find it.
  merged.claudeArgs = merged.claudeArgs.map((arg) => {
    if (isAbsolute(arg)) return arg;
    const candidate = resolve(process.cwd(), arg);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not a file — leave the arg untouched */
    }
    return arg;
  });
  return merged;
}
