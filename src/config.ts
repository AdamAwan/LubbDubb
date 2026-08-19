import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { IntegrationSelection } from './integrations/integration.js';
import { DEFAULT_CONTAINER_TYPES } from './issueRelations.js';
import { DEFAULT_PLANNING, type PlanningPolicy } from './plans/planning.js';
import { DEFAULT_BURN, validateBurnPolicy, type BurnPolicy } from './spendBurn.js';
import type { SelfUpdatePolicy } from './selfUpdate/upgradePlan.js';
import { DEFAULT_VALIDATION, type ValidationPolicy } from './validation/policy.js';
import { validateCiPolicy, type CiPolicy } from './ci/ciPolicy.js';
import { validatePolicyCheckModes, type PolicyCheckModes } from './integrations/azure/policyKinds.js';
import { validateAgentModels, type AgentModels } from './agents/modelPolicy.js';
import { DEFAULT_FILING_TYPES } from './ticketTypes.js';

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
  /**
   * Who *you* are, to every provider the harness talks to — the one identity the
   * harness acts on behalf of, and the answer to every "me" the config used to ask
   * about separately.
   *
   * It replaces six keys that were all the same fact spelled per provider and per
   * use (`issuePickupRequireOwnLabel`, both `defaultAssignee`s, both
   * `filters.prAuthor`s, and `filters.workItemAssignedTo`). Set it and three gates
   * turn on together, because they are one intent — *this harness works my
   * queue*:
   *
   * - **Ownership.** The `${labelPrefix}-watch` tag only counts if you added it, so
   *   nobody else can tag an item onto the fleet.
   * - **Assignment.** Tickets the harness *files* are assigned to you.
   * - **Authorship.** Only pull requests you opened are surfaced.
   *
   * One string rather than one per provider because one project is worked at a
   * time and each project carries its own config file: the identity that is
   * correct is the one belonging to whichever provider `integrations` selects — a
   * GitHub login where that is `github`, an Azure UPN where that is `azure`.
   *
   * Unset, all three gates are off: any tagger counts, filed tickets go
   * unassigned, and every open pull request is surfaced. That is the first-run and
   * test posture, and it is why this is optional rather than required — the `fake`
   * provider resolves no identity at all.
   */
  userId?: string;
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
   * The prefix behind the cockpit's watch toggle, shared by PRs and issues. It
   * derives one label — `${labelPrefix}-watch` ("work this") — read by the
   * dispatcher gates and written by the toggle (see {@link watchLabelFor}/{@link
   * isWatched}). Everything is **opt-in**: an item without the tag is left alone,
   * pull requests and issues alike, and the harness tags the pull requests it opens
   * itself (`src/prWatch.ts`) so its own work never waits on a click.
   *
   * An empty prefix turns the gate off entirely — every open item is worked, which
   * is the first-run and test posture. Defaults to `"lubbdubb"`.
   *
   * A retired `${labelPrefix}-ignore` tag used to mean "leave this alone" and is no
   * longer read anywhere except the seeding carve-out: an item carrying it has no
   * watch tag, so it stays unworked by itself and needs no migration.
   */
  labelPrefix: string;
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
   * The work item types the harness may **file**, when an operator files a
   * finding, a blueprint or unrecorded work from the cockpit. The filing agent
   * picks one from this list and is told it may create nothing else — which of
   * them a given report is, is a judgement about the report, and only the agent
   * has read it.
   *
   * Defaults to `["User Story", "Bug"]`: the altitude a backlog is groomed at,
   * on the Agile process template's names. Set your own — a Scrum project files
   * `["Product Backlog Item", "Bug"]`, and a process extended with a custom type
   * lists it (`["User Story", "Tech Debt", "Bug"]`). The names are passed to
   * `az` verbatim, so they must match the project's exactly.
   *
   * Meaningful only for Azure DevOps, the one provider whose items carry a type;
   * GitHub issues have none and are unaffected. Unlike `issueContainerTypes`
   * there is no "off": `[]` falls back to the default, because a work item is
   * created *as* something.
   */
  issueFilingTypes: string[];
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
   * The live burn watch (`src/spendBurn.ts`) — what to do about a run that is
   * spending far past what its kind of work costs, while it is still running.
   * **On by default**, because it spends no agent and gates nothing: it files a
   * visible `burn` obligation and settles it when the run ends. Deep-merged, so
   * one field can be set alone.
   */
  spendBurn: BurnPolicy;
  /**
   * The self-update watch (`src/selfUpdate/`) — whether the harness checks its
   * **own** build against its upstream, and how often.
   *
   * Note what it does not name: a repo. The check runs against the directory
   * LubbDubb is installed in, resolved from the running module, and never against
   * `repoRoot` — the two are the same only when the harness is dogfooding itself,
   * and a deployment working on someone else's codebase still wants to hear that
   * its own build moved. `remote` and `branch` are configurable because a fork
   * tracks somewhere else; there is deliberately no way to point them at an
   * arbitrary path.
   *
   * **On by default and cheap**: the steady state is one `ls-remote` an hour,
   * which transfers no objects, and a real fetch only once the tip has moved.
   * Deep-merged, so one field can be set alone.
   */
  selfUpdate: SelfUpdatePolicy;
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
   * Which model each kind of work runs on, keyed on the dispatch rule that
   * proposed it (issue #321) — see {@link AgentModels}.
   *
   * Read at boot like {@link agentMode} and {@link claudeArgs}: config file only,
   * no runtime mutation and no cockpit editing, because a second mutation path
   * would need a second answer to "what did this run actually launch on". The
   * resolved model string is stored on the task at dispatch, so a run is
   * auditable after the fact and a resumed agent re-launches on what it started
   * on.
   *
   * Optional as a whole. Omitted, no launch anywhere carries `--model` and argv
   * is exactly what it was before the key existed. Unlike the policy blocks
   * below it merges whole rather than field by field, so an override that sets it
   * replaces it — which is what lets one *remove* an assignment.
   */
  agentModels?: AgentModels;
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
  /**
   * How many times an agent that ends a turn with **no** sentinel in it is asked to
   * account for itself before the stop is put to a human.
   *
   * The stream runtime has exactly two things it can read at a turn boundary — the
   * done sentinel and the waiting one — so a turn carrying neither used to raise an
   * escalation on the spot. In practice that population is dominated by agents that
   * finished and narrated it rather than printing the sentinel, and by agents that
   * started a build, a test run or a CI check and stopped as if something would wake
   * them: two stops with nothing for a person to answer, and no way to tell which
   * without reading the transcript. Asking the agent costs one turn and is answered
   * by the only party that knows.
   *
   * A whole-life budget per agent, not a per-stop one, so a stop that keeps
   * repeating still reaches the operator. 0 disables it and restores the immediate
   * park. Only the stream runtime has a turn boundary to read a stop off; the PTY
   * runtime parks on silence instead (`agentIdleWaitMs`) and ignores this.
   */
  agentStallNudges: number;
  /**
   * How many times a *live* agent whose process dies mid-run is re-attached to
   * its own session before the harness settles it as failed (issue #318).
   *
   * A crash mid-run used to end the task outright, which on a resumable runtime
   * throws away a conversation the CLI can re-open in the same worktree. The
   * bound is what separates that recovery from a crash loop: an agent whose
   * `claude` dies three seconds into every launch would otherwise relaunch
   * forever, each launch costing tokens. On the `(N+1)`th death the agent fails
   * with an error naming how many resumes were tried, so the loop is visible
   * rather than silent.
   *
   * Counted on the agent row (`agents.resume_attempts`), so it survives a harness
   * restart and covers the agent's whole life rather than its current launch. 0
   * disables automatic resume, restoring the pre-#318 behaviour. Ignored by
   * runtimes that cannot resume (mock, raw), which have no session to re-open.
   */
  agentResumeAttempts: number;
  /**
   * How many characters of promoted lessons may ride in every agent's
   * system-prompt append (issue #355 phase 3). `0` renders nothing at all.
   *
   * Characters rather than a count of lessons, because the cost being bounded is
   * **context** and a lesson runs from one line to 2,000 characters — ten of one
   * shape and ten of the other are not the same purchase. The block is a cached
   * prefix, identical across the fleet, so it is paid once rather than per
   * dispatch; the cap is what stops "paid once" turning into "unbounded and
   * unread".
   *
   * Over it, whole lessons are dropped **oldest-vouched first** — never a
   * truncated claim, which would be a claim nobody promoted. The agent is told
   * nothing about the cap or the drop, because a partial list presented as whole
   * is the failure this bound exists to prevent; the operator sees it per row in
   * the cockpit's Lessons panel and retires something to make room.
   */
  lessonBlockChars: number;
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
  /** Root under which the pool of worktree slot directories lives. */
  worktreeRoot: string;
  /**
   * How many worktree directories the pool may hold at once (issue #352).
   *
   * Unset — the default — derives it from `maxConcurrentAgents` plus slack, which
   * is the answer that stays right when an operator changes the cap. Set it only to
   * override that: a deployment on a small disk wanting fewer full checkouts, or one
   * whose slots are routinely left carrying uncommitted changes and so needs more.
   *
   * It is a **hard bound**, and exhaustion rejects the dispatch rather than blocking
   * it — the executor already settles a rejected dispatch and the next cycle tries
   * again, whereas waiting on a directory would hold the pulse. Read once at boot:
   * the live cap from `POST /api/control` moves the number of *agents*, not the
   * number of directories, so raising the cap past the pool trades dispatches for
   * rejections until the bound is raised too.
   */
  worktreePoolSize?: number;
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
}

export interface AzureDevOpsConfig {
  /** Organization (the `dev.azure.com/{organization}` segment). */
  organization: string;
  /** Project name — work items are scoped to it. */
  project: string;
  /** Git repository name within the project. */
  repository: string;
  /**
   * Optional filters narrowing what the harness picks up.
   *
   * Identity-based narrowing is **not** here: who the harness acts as is
   * {@link Config.userId}, which drives PR authorship and work-item assignment for
   * every provider at once. What remains is the one filter that is about the
   * *tracker's* shape rather than about you.
   */
  filters?: {
    /** Only surface work items carrying this tag. Unset = all open work items. */
    workItemTag?: string;
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

const DEFAULTS: Config = {
  heartbeatIntervalMs: 5 * 60 * 1000,
  maxConcurrentAgents: 3,
  startPaused: false,
  whitelistedApprovals: [],
  integrations: { sourceControl: 'fake', issues: 'fake' },
  labelPrefix: 'lubbdubb',
  issuePriorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  issueDefaultPriority: 2,
  issueContainerTypes: [...DEFAULT_CONTAINER_TYPES],
  issueFilingTypes: [...DEFAULT_FILING_TYPES],
  // Each policy's own module owns the operator default; the dispatcher's fallback
  // for an *omitted* policy is a separate answer (off) and lives with the rules.
  planning: DEFAULT_PLANNING,
  spendBurn: DEFAULT_BURN,
  selfUpdate: { enabled: true, remote: 'origin', branch: 'main', checkIntervalMs: 60 * 60 * 1000 },
  validation: DEFAULT_VALIDATION,
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
  agentStallNudges: 2,
  agentResumeAttempts: 3,
  lessonBlockChars: 6_000,
  claudeCommand: 'claude',
  claudeArgs: [],
  promptTemplatesDir: '.lubbdubb/prompts',
  worktreeRoot: '.lubbdubb/worktrees',
  deskRoot: '.lubbdubb/desk',
  attachmentRoot: '.lubbdubb/attachments',
  validationRoot: '.lubbdubb/validation',
  repoRoot: process.cwd(),
  defaultBranch: 'main',
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
  autoSend:
    'the harness never acts on a pull request autonomously — a reply or a merge is always put to you as a proposal',
};

/**
 * Keys that used to be switches and are not any more, each with the reason.
 *
 * These **warn and are dropped**, where {@link REMOVED_KEYS} refuses — and the
 * difference is what the operator's file is asking for. A removed key names a
 * capability that no longer exists on any setting, so refusing is the only honest
 * answer. Everything here named a subsystem that is now **unconditional**, so a
 * file setting one is asking for something the harness either already does or
 * will never do again: refusing would take a running deployment down at boot over
 * one stale line. Dropped rather than left to merge into nothing, so the value
 * cannot survive on the policy object and be read by something later.
 *
 * A file asking for `false` is the case the warning is for: that deployment is
 * getting the funnel it switched off, and it has to hear so from the boot log
 * rather than from the fleet's behaviour. The entries are permanent — a config
 * written before the removal outlives the release that made it.
 *
 * A key is either a top-level name or one `block.key` path. Both forms are here
 * because a block whose every field went unconditional is removed whole, and an
 * operator's file names the block, not just the field inside it.
 */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  'planning.enabled': 'the planning funnel is always on — every goal is planned',
  'validation.enabled': 'validation plans are always on',
  'validation.desktopSkill': 'the /lubbdubb skill is always installed and refreshed when the desktop channel starts',
  assessment: 'the assessor is always on — a goal with work behind it and nothing in flight is always assessed',
  'assessment.enabled': 'the assessor is always on',
  assay: 'the goal assay is always on — every fresh goal is assayed before anything is dispatched against it',
  'assay.enabled': 'the goal assay is always on',
  retrospective: 'the retrospective is always on — every delivered goal is written up',
  'retrospective.enabled': 'the retrospective is always on',
  mcp: 'the agent tool channel and its permission backstop are always on',
  'mcp.enabled': 'the agent tool channel is always on',
  'mcp.permissionEscalation': 'the permission backstop is always on',
  reapMergedBranches: 'the branch behind a merged pull request of yours is always reaped',
  reviewReminderMs: 'the cockpit ages every pull request waiting on a reviewer, with no threshold to cross',
  issuePickupRequireOwnLabel: 'the ownership gate follows "userId" — set it, and only tags you added count',
  'github.defaultAssignee': 'tickets the harness files are assigned to "userId"',
  'azureDevOps.defaultAssignee': 'tickets the harness files are assigned to "userId"',
  'github.filters': 'pull requests are filtered to the ones "userId" opened',
  'azureDevOps.filters.prAuthor': 'pull requests are filtered to the ones "userId" opened',
  'azureDevOps.filters.workItemAssignedTo': 'work items are filtered to the ones assigned to "userId"',
};

function dropRetiredKeys(fromFile: Partial<Config>, filePath: string): void {
  for (const [path, why] of Object.entries(RETIRED_KEYS)) {
    // Walk to the object that owns the final segment, so a `block.key` path drops
    // the field and a bare name drops the whole block.
    const segments = path.split('.');
    const key = segments.pop() as string;
    let owner: unknown = fromFile;
    for (const segment of segments) {
      if (typeof owner !== 'object' || owner === null) break;
      owner = (owner as Record<string, unknown>)[segment];
    }
    if (typeof owner !== 'object' || owner === null || !Object.hasOwn(owner, key)) continue;
    delete (owner as Record<string, unknown>)[key];
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
  if (lower.integrations ?? upper.integrations)
    merged.integrations = { ...DEFAULTS.integrations, ...lower.integrations, ...upper.integrations };
  if (lower.planning ?? upper.planning)
    merged.planning = { ...DEFAULTS.planning, ...lower.planning, ...upper.planning };
  if (lower.spendBurn ?? upper.spendBurn)
    merged.spendBurn = { ...DEFAULTS.spendBurn, ...lower.spendBurn, ...upper.spendBurn };
  if (lower.selfUpdate ?? upper.selfUpdate)
    merged.selfUpdate = { ...DEFAULTS.selfUpdate, ...lower.selfUpdate, ...upper.selfUpdate };
  if (lower.validation ?? upper.validation)
    merged.validation = { ...DEFAULTS.validation, ...lower.validation, ...upper.validation };
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

  // integrations is a nested per-capability map: deep-merge it, so an override
  // can swap just one capability's provider without having to re-list the
  // defaults for the others.
  merged.integrations = { ...DEFAULTS.integrations, ...overrides.integrations };

  // planning is nested too — deep-merge so `{"requireApproval": true}` alone keeps
  // the default part-concurrency cap instead of leaving it undefined.
  merged.planning = { ...DEFAULTS.planning, ...overrides.planning };
  // And the burn watch, so `{"spendBurn": {"multiple": 6}}` keeps the default
  // floor and run minimum rather than leaving them undefined — which would read
  // as a watch that fires on any run above six times nothing.
  merged.spendBurn = { ...DEFAULTS.spendBurn, ...overrides.spendBurn };
  // And the self-update watch, so `{"selfUpdate": {"enabled": false}}` keeps the
  // remote and branch rather than blanking them — a disabled watch that is later
  // re-enabled must not come back pointed at nothing.
  merged.selfUpdate = { ...DEFAULTS.selfUpdate, ...overrides.selfUpdate };
  merged.validation = { ...DEFAULTS.validation, ...overrides.validation };

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

  // Same argument for the model policy: a profile name that resolves to nothing,
  // or a rule id that can never match, would both run as if the operator had
  // configured nothing at all.
  validateAgentModels(merged.agentModels);

  // And the burn watch, for the same reason: a multiple at or below 1, or a
  // minimum of no runs, leaves a watch that is on, files constantly and teaches
  // the operator to stop reading it.
  validateBurnPolicy(merged.spendBurn);

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
