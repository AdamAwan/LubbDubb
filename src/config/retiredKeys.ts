import type { Config } from './config.js';

const REMOVED_KEYS: Readonly<Record<string, string>> = {
  dispatcher:
    'the "claude" dispatcher was removed and the rule dispatcher is the only one, so there is nothing left to select',
  steeringPriorities: 'it was only ever injected into the removed "claude" dispatcher\'s prompt and now steers nothing',
  autoSend:
    'it gated on a confidence threshold that resolved between two constants and measured nothing — if you want the harness to send a drafted reply without asking, set "sendPrRepliesWithoutApproval": true, which is replies only and has no threshold; a merge is still authorized per pull request by landing a stack',
};

const RETIRED_KEYS: Readonly<Record<string, string>> = {
  manualDescriptions:
    'you always write a pull request\'s description, and the agent\'s is kept as a draft you can use — set "autoUseAgentDescriptions": true to use it every time',
  'planning.enabled': 'the planning funnel is always on — every goal is planned',
  'planning.requireApproval':
    'a plan is always put to you before anything is scheduled from it — the undo for a plan that started itself is a replan, which is strictly worse than not starting',
  worktreePoolSize:
    'the worktree pool is the live agent cap plus slack, so "maxConcurrentAgents" is the fleet\'s one size knob — a second bound could only sit above the cap (disk nothing can lease) or below it (the fleet\'s real limit, with nothing saying so)',
  'validation.enabled': 'validation plans are always on',
  'validation.desktop':
    'the desktop channel is always on — the cockpit offers a desktop prompt on every unrun check, so a harness that was not listening was a dead end with nothing to say so',
  'validation.desktopSkill': 'the /lubbdubb skill is always installed and refreshed when the desktop channel starts',
  assessment: 'the assessor is always on — a goal with work behind it and nothing in flight is always assessed',
  'assessment.enabled': 'the assessor is always on',
  appraisal: 'the goal appraisal is always on — every fresh goal is appraised before anything is dispatched against it',
  'appraisal.enabled': 'the goal appraisal is always on',
  retrospective: 'the retrospective is always on — every delivered goal is written up',
  'retrospective.enabled': 'the retrospective is always on',
  mcp: 'the agent tool channel and its permission backstop are always on',
  'mcp.enabled': 'the agent tool channel is always on',
  'mcp.permissionEscalation': 'the permission backstop is always on',
  reapMergedBranches: 'the branch behind a merged pull request of yours is always reaped',
  reviewReminderMs: 'the cockpit ages every pull request waiting on a reviewer, with no threshold to cross',
  issuePickupRequireOwnLabel: 'the ownership gate is "ownWorkOnly", and who "own" means is "userId"',
  'github.defaultAssignee': 'tickets the harness files are assigned to "userId"',
  'azureDevOps.defaultAssignee': 'tickets the harness files are assigned to "userId"',
  lessonBlockChars:
    'nothing is injected fleet-wide any more — the claim store this bounded is gone, and everything the obstacle board holds is keyed and delivered to the dispatches it is about',
  knowledgeBlockChars:
    'nothing is injected fleet-wide any more — the claim store this bounded is gone, and everything the obstacle board holds is keyed and delivered to the dispatches it is about',
  knowledgeScopeStaleDays: 'the Knowledge page it was a reading for is gone with the claim store behind it',
  knowledgeColdDays: 'the Knowledge page it was a reading for is gone with the claim store behind it',
  agentIdleWaitMs:
    'it was the removed "pty" runtime\'s silence watch, read off a terminal that had gone quiet — what replaced it is "agentSilenceParkMs", which reads the same silence off the stream protocol and parks on it, so a deployment that had tuned this figure boots on that key\'s default until somebody sets it',
  sessionTranscriptRoot:
    'only the removed "pty" runtime read it, to tail the transcript file `claude` writes per project — the stream transport carries the transcript in structure, so there is no file to find and no path to point at',
  'github.filters': 'pull requests are filtered to "userId"\'s while "ownWorkOnly" is on',
  'azureDevOps.filters.prAuthor': 'pull requests are filtered to "userId"\'s while "ownWorkOnly" is on',
  'azureDevOps.filters.workItemAssignedTo': 'work items are filtered to "userId"\'s while "ownWorkOnly" is on',
  'remoteValidation.runTimeoutMs':
    "the harness no longer spawns the browser suite — the remote validation run's agent invokes the runner in its own shell, under its own stall park, so there is no invocation for the harness to kill",
};

export function dropRetiredKeys(fromFile: Partial<Config>, filePath: string): void {
  for (const [path, why] of Object.entries(RETIRED_KEYS)) {
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

export function refuseRemovedKeys(fromFile: object, filePath: string): void {
  for (const [key, why] of Object.entries(REMOVED_KEYS)) {
    if (!Object.hasOwn(fromFile, key)) continue;
    throw new Error(`Refusing to start: ${filePath} sets "${key}", which no longer exists — ${why}. Delete the key.`);
  }
}
