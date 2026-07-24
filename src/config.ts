import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { IntegrationSelection } from './integrations/integration.js';

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
   * Microsoft 365 target, used when a capability uses the `microsoft365` provider
   * (currently the `calendar` slice, read from Outlook/Teams via Microsoft Graph).
   * Auth is deliberately NOT here: a bearer token comes from the
   * `MICROSOFT_GRAPH_TOKEN` env var, and if that is unset the logged-in `az` CLI is
   * used — so a secret never lands in a committed config file.
   */
  microsoft365?: Microsoft365Config;
  /**
   * The prefix behind the cockpit's watch/ignore toggle, shared by PRs and issues.
   * It derives two labels — `${labelPrefix}-watch` ("work this") and
   * `${labelPrefix}-ignore` ("leave this alone") — read by the dispatcher gates and
   * written by the toggle (see {@link watchLabelsFor}/{@link resolveWatchState}).
   * The no-tag default differs by type: PRs are opt-out (watched unless ignored),
   * issues are opt-in (ignored unless watched). Defaults to `"lubbdubb"`, so
   * `lubbdubb-ignore` keeps its historical meaning as the PR exclusion tag.
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
  /** Passed to `claude --permission-mode` so unattended tool calls don't hang the agent. */
  agentPermissionMode: string;
  /** Wait this long after spawn before typing the task in, giving the REPL time to boot. */
  agentPromptDelayMs: number;
  /**
   * Gap between typing a message and sending the submitting carriage return (PTY
   * only). The claude TUI folds a single input burst into a paste and treats a
   * trailing CR as a literal newline, so a glued-on CR leaves the text sitting in
   * the input unsubmitted; the gap lands the CR as a distinct Enter keypress.
   */
  agentSubmitDelayMs: number;
  /** Extra literal substrings that mean "the CLI is waiting for input" (backup escalation). */
  agentWaitingPatterns: string[];
  /** Command used to launch an agent session (overridable for tests). */
  claudeCommand: string;
  /** Extra args passed to the agent command. */
  claudeArgs: string[];
  /**
   * Worktree-relative folder the file-events hook treats as the artifacts area:
   * any file an agent writes *under* this prefix is promoted to an artifact chip
   * regardless of extension (on top of the built-in report/doc heuristic). E.g.
   * `"docs"` promotes everything the agent drops in `docs/`. Unset = fall back to
   * the extension allowlist + `reports/` convention only.
   */
  docsFolderPrefix?: string;
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
  /** SQLite file. */
  dbPath: string;
  /** HTTP/WS port. */
  port: number;
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
  };
}

export interface Microsoft365Config {
  /**
   * Target mailbox for the calendar (UPN or object id). Required for app-only
   * (client-credential) tokens, which have no `me`; omit when using a delegated
   * token to read the signed-in user's own calendar.
   */
  userId?: string;
  /** How many days ahead to surface events. Defaults to 7. */
  windowDays?: number;
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
  integrations: { sourceControl: 'fake', issues: 'fake', calendar: 'fake' },
  labelPrefix: 'lubbdubb',
  issuePickupRequireOwnLabel: false,
  issuePriorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  issueDefaultPriority: 2,
  dispatcher: 'rule',
  agentMode: 'stream',
  agentPermissionMode: 'acceptEdits',
  agentPromptDelayMs: 1200,
  agentSubmitDelayMs: 60,
  agentWaitingPatterns: [],
  claudeCommand: 'claude',
  claudeArgs: [],
  promptTemplatesDir: '.lubbdubb/prompts',
  worktreeRoot: '.lubbdubb/worktrees',
  deskRoot: '.lubbdubb/desk',
  repoRoot: process.cwd(),
  dbPath: '.lubbdubb/lubbdubb.sqlite',
  port: 4300,
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
