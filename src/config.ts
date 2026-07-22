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
   * Dispatcher-level, provider-agnostic gate on issue pickup (rule 4). When set,
   * the dispatcher only starts an agent for an open issue whose `labels` include
   * this; untagged issues stay visible in the world/cockpit but are left alone.
   * Unset (the default) = act on all open issues, as before. Distinct from the
   * GitHub provider's `github.filters.issueLabel`, which narrows what's *ingested*
   * into the world in the first place.
   */
  issuePickupLabel?: string;
  /**
   * Label → priority weight for ordering issue pickup: when headroom is limited,
   * higher-weight issues are dispatched first. Replaced wholesale by an override
   * (not merged), so an operator can define their own scheme.
   */
  issuePriorityLabels: Record<string, number>;
  /** Weight for an issue carrying no matching priority label. */
  issueDefaultPriority: number;
  /**
   * The PR **exclusion tag**: a PR carrying this label is left alone — the
   * dispatcher never acts on it (no CI fix, base update, comment handling, or
   * merge), for PRs blocked on something the harness can't fix (a design
   * decision, an upstream dependency, a deliberate hold). An excluded PR stays
   * fully visible in the cockpit and `/api/state` (with its health verdict) — it's
   * just not acted on. Provider-agnostic: it reads `PullRequest.labels`, so it
   * gates the `fake`, `github` and `azure` providers identically. The cockpit's
   * per-PR ignore/watch toggle adds/removes this label on the PR through the
   * provider. Defaults to `lubbdubb-ignore`.
   */
  prExclusionLabel: string;
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
  /** Extra literal substrings that mean "the CLI is waiting for input" (backup escalation). */
  agentWaitingPatterns: string[];
  /** Command used to launch an agent session (overridable for tests). */
  claudeCommand: string;
  /** Extra args passed to the agent command. */
  claudeArgs: string[];
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
    /** Only surface issues carrying this label. Unset = all open issues. */
    issueLabel?: string;
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
  integrations: { sourceControl: 'fake', issues: 'fake', backlog: 'fake', calendar: 'fake' },
  issuePriorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  issueDefaultPriority: 2,
  prExclusionLabel: 'lubbdubb-ignore',
  dispatcher: 'rule',
  agentMode: 'stream',
  agentPermissionMode: 'acceptEdits',
  agentPromptDelayMs: 1200,
  agentWaitingPatterns: [],
  claudeCommand: 'claude',
  claudeArgs: [],
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
