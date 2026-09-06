import { CONFIG_FIELDS, readPath } from './configFields.js';
import type { Config } from './config.js';
import type { CiPolicy } from './ci/ciPolicy.js';
import type { RuntimeControl } from './runtimeControl.js';

// → docs/spec/02-configuration.md

export interface ConfigChange {
  path: string;
  from: unknown;
  to: unknown;
  applied: boolean;
}

interface LiveConfigDeps {
  running: Config;
  runtimeControl: RuntimeControl;
  dispatcher: CiPolicyHolder;
}

interface CiPolicyHolder {
  setCiPolicy(ci: CiPolicy): void;
}

type LiveArm = (next: Config, deps: LiveConfigDeps) => void;

const LIVE_ARMS: Readonly<Record<string, LiveArm>> = {
  maxConcurrentAgents: (next, deps) => {
    deps.running.maxConcurrentAgents = next.maxConcurrentAgents;
    deps.runtimeControl.apply({ cap: next.maxConcurrentAgents });
  },
  sendPrRepliesWithoutApproval: (next, deps) => {
    deps.running.sendPrRepliesWithoutApproval = next.sendPrRepliesWithoutApproval;
  },
  issueStateColours: (next, deps) => {
    deps.running.issueStateColours = next.issueStateColours;
  },
  issueBoardStates: (next, deps) => {
    deps.running.issueBoardStates = next.issueBoardStates;
  },
  'localRun.instruction': (next, deps) => {
    deps.running.localRun = next.localRun;
  },
  'localRun.stopInstruction': (next, deps) => {
    deps.running.localRun = next.localRun;
  },
  'localRun.resumeInstruction': (next, deps) => {
    deps.running.localRun = next.localRun;
  },
  'localRun.refreshInstruction': (next, deps) => {
    deps.running.localRun = next.localRun;
  },
  'localRun.url': (next, deps) => {
    deps.running.localRun = next.localRun;
  },
  'localValidation.instruction': (next, deps) => {
    deps.running.localValidation = next.localValidation;
  },
  'localValidation.browser': (next, deps) => {
    deps.running.localValidation = next.localValidation;
  },
  'pets.visible': (next, deps) => {
    deps.running.pets.visible = next.pets.visible;
  },
  'ci.checks': (next, deps) => {
    deps.running.ci = next.ci;
    deps.dispatcher.setCiPolicy(next.ci);
  },
};

export function isLiveField(path: string): boolean {
  return Object.hasOwn(LIVE_ARMS, path);
}

export function liveFieldPaths(): readonly string[] {
  return Object.keys(LIVE_ARMS);
}

export function diffConfig(running: Config, next: Config): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const field of CONFIG_FIELDS) {
    const from = readPath(running, field.path);
    const to = readPath(next, field.path);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ path: field.path, from, to, applied: isLiveField(field.path) });
  }
  return changes;
}

export class LiveConfig {
  private readonly deps: LiveConfigDeps;
  private pendingChanges: ConfigChange[] = [];

  constructor(deps: LiveConfigDeps) {
    this.deps = deps;
  }

  apply(next: Config): ConfigChange[] {
    const changes = diffConfig(this.deps.running, next);
    for (const change of changes) LIVE_ARMS[change.path]?.(next, this.deps);
    this.pendingChanges = diffConfig(this.deps.running, next);
    return changes;
  }

  pending(): readonly ConfigChange[] {
    return this.pendingChanges;
  }
}
