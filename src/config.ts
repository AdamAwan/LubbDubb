import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { IntegrationSelection } from './integrations/integration.js';
import type { PlanningPolicy } from './plans/planning.js';
import type { AssessmentPolicy } from './delivery/assessment.js';

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
  /** Optional ordered hints injected into the dispatcher prompt. Empty by default. */
  steeringPriorities: string[];
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
   * The prefix behind the cockpit's watch/ignore toggle, shared by PRs, issues and
   * stories. It derives two labels — `${labelPrefix}-watch` ("work this") and
   * `${labelPrefix}-ignore` ("leave this alone") — read by the dispatcher gates and
   * written by the toggle (see {@link watchLabelsFor}/{@link resolveWatchState}).
   * The no-tag default differs by type: PRs are opt-out (watched unless ignored),
   * issues/stories are opt-in (ignored unless watched). Defaults to `"lubbdubb"`,
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
   * The planning funnel for multi-PR issues. **Off by default**, and off leaves it
   * out entirely: rule 4 stays un-narrowed, no planner is ever dispatched, and
   * behaviour is exactly what it is without plans. On, every watched open issue
   * gets a planning agent before any implementation work — a real change in what
   * the fleet spends its slots on. Deep-merged, so one field can be set alone.
   * Only the `rule` dispatcher implements the funnel.
   */
  planning: PlanningPolicy;
  /**
   * The assessor (rule 3e) — the harness asking whether an issue that has had work
   * and has nothing in flight is actually finished, and parking it as `delivered`
   * if so. **Off by default**, like `planning` and unlike `mcp`: it is not purely
   * additive, since it gates pickup and spends an agent per assessed issue. Off,
   * no assessor is dispatched, no verdict is written, and rule 4 behaves exactly
   * as it does today. Deep-merged. Only the `rule` dispatcher implements it.
   */
  assessment: AssessmentPolicy;
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
   * How long an operator "Up next" priority override (issue #128) survives after
   * the harness stops tracking its origin. The override's `last_seen_at` is
   * refreshed every pulse the origin is still a live candidate or staffed, so a
   * long-running item keeps its priority; once the work is gone (merged, closed,
   * abandoned) for this long, the stale override is pruned rather than lingering
   * forever. Defaults to 7 days; `0` disables pruning entirely (supported).
   */
  upNextOverrideTtlMs: number;
  /** Which dispatcher to use. `rule` is deterministic; `claude` drives a PTY session. */
  dispatcher: 'rule' | 'claude';
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
   * Only the `rule` dispatcher uses these; the `claude` dispatcher composes its
   * own prompts.
   */
  promptTemplatesDir: string;
  /** Root under which per-branch worktrees are created. */
  worktreeRoot: string;
  /** Root under which desk (no-code) scratch dirs are created. */
  deskRoot: string;
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
  /** Optional filters narrowing what the harness picks up. */
  filters?: {
    /** Only surface PRs opened by this uniqueName (UPN). Unset = all active PRs. */
    prAuthor?: string;
    /** Only surface work items carrying this tag. Unset = all open work items. */
    workItemTag?: string;
    /** Only surface work items assigned to this uniqueName (UPN). Unset = all assignees. */
    workItemAssignedTo?: string;
  };
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
  steeringPriorities: [],
  autoSend: { enabled: false, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] },
  integrations: { sourceControl: 'fake', issues: 'fake', backlog: 'fake' },
  labelPrefix: 'lubbdubb',
  issuePickupRequireOwnLabel: false,
  issuePriorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  issueDefaultPriority: 2,
  planning: { enabled: false, maxConcurrentPartsPerIssue: 2, requireApproval: true, gitFetchIntervalMs: 60_000 },
  assessment: { enabled: false },
  mcp: { enabled: true, permissionEscalation: true },
  closedPrWindowMs: 6 * 60 * 60 * 1000,
  upNextOverrideTtlMs: 7 * 24 * 60 * 60 * 1000,
  dispatcher: 'rule',
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
  repoRoot: process.cwd(),
  defaultBranch: 'main',
  dbPath: '.lubbdubb/lubbdubb.sqlite',
  port: 4300,
  host: '127.0.0.1',
  auth: { enabled: true, tokenFile: '.lubbdubb/cockpit-token' },
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const filePath = resolve(process.cwd(), 'lubbdubb.config.json');
  let fromFile: Partial<Config> = {};
  if (existsSync(filePath)) {
    try {
      fromFile = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Config>;
    } catch (err) {
      throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
    }
  }
  const fromEnv: Partial<Config> = {};
  if (process.env.PORT) fromEnv.port = Number(process.env.PORT);
  if (process.env.LUBBDUBB_HOST) fromEnv.host = process.env.LUBBDUBB_HOST;
  if (process.env.LUBBDUBB_DB) fromEnv.dbPath = process.env.LUBBDUBB_DB;
  if (process.env.LUBBDUBB_REPO_ROOT) fromEnv.repoRoot = process.env.LUBBDUBB_REPO_ROOT;
  const merged = { ...DEFAULTS, ...fromFile, ...fromEnv, ...overrides };

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

  // Prompt overrides belong to the repo being operated on, like the worktree
  // roots above — resolve relative to repoRoot, honour an absolute override.
  merged.promptTemplatesDir = resolve(merged.repoRoot, merged.promptTemplatesDir);

  // autoSend is a nested object: deep-merge it so a config file (or override)
  // can set just one field (e.g. only `enabled`) without dropping the defaults
  // for the rest.
  merged.autoSend = { ...DEFAULTS.autoSend, ...fromFile.autoSend, ...overrides.autoSend };

  // integrations is a nested per-capability map: deep-merge it too, so a config
  // file (or override) can swap just one capability's provider without having to
  // re-list the defaults for the others.
  merged.integrations = { ...DEFAULTS.integrations, ...fromFile.integrations, ...overrides.integrations };

  // planning is nested too — deep-merge so `{"enabled": true}` alone keeps the
  // default part-concurrency cap instead of leaving it undefined.
  merged.planning = { ...DEFAULTS.planning, ...fromFile.planning, ...overrides.planning };
  merged.assessment = { ...DEFAULTS.assessment, ...fromFile.assessment, ...overrides.assessment };

  // Same treatment for the tool channel, so `{"mcp": {}}` is the default rather
  // than an accidental off.
  merged.mcp = { ...DEFAULTS.mcp, ...fromFile.mcp, ...overrides.mcp };

  // And for auth, so `{"auth": {"tokenFile": "..."}}` doesn't silently disable it.
  merged.auth = { ...DEFAULTS.auth, ...fromFile.auth, ...overrides.auth };

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
