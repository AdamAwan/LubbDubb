import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Central configuration. Everything the operator can tune lives here.
 *
 * Values come from (in order of precedence): explicit overrides, a
 * `lubbdubb.config.json` file at the repo root, then these defaults.
 */
export interface Config {
  /** How often the heartbeat fires a dispatch cycle. */
  heartbeatIntervalMs: number;
  /** Hard cap on concurrently-running agents. */
  maxConcurrentAgents: number;
  /** PTY prompt substrings the harness may auto-answer instead of escalating. */
  whitelistedApprovals: WhitelistRule[];
  /** Optional ordered hints injected into the dispatcher prompt. Empty by default. */
  steeringPriorities: string[];
  /** Confidence-gated auto-send policy for side-effectful actions. Off by default. */
  autoSend: AutoSendConfig;
  /** Which dispatcher to use. `rule` is deterministic; `claude` drives a PTY session. */
  dispatcher: 'rule' | 'claude';
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
  whitelistedApprovals: [],
  steeringPriorities: [],
  autoSend: { enabled: false, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] },
  dispatcher: 'rule',
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
  const merged = { ...DEFAULTS, ...fromFile, ...fromEnv, ...overrides };

  // autoSend is a nested object: deep-merge it so a config file (or override)
  // can set just one field (e.g. only `enabled`) without dropping the defaults
  // for the rest.
  merged.autoSend = { ...DEFAULTS.autoSend, ...fromFile.autoSend, ...overrides.autoSend };

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
