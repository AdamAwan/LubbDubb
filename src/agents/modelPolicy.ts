import { DISPATCH_PIPELINE } from '../dispatcher/rules.js';

// → docs/spec/10-agent-runtimes.md

export interface AgentModels {
  profiles: Record<string, AgentProfile>;
  default?: string;
  byRule?: Record<string, string>;
}

interface AgentProfile {
  rank: number;
  description: string;
  model: string;
  effort?: AgentEffort;
}

type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

interface ResolvedProfile {
  name: string;
  model: string;
  effort: string | null;
  source: ProfileSource;
}

export type ProfileSource = 'pin' | 'rule' | 'default';

const STAGE_RULE_IDS: ReadonlySet<string> = new Set(DISPATCH_PIPELINE.map((r) => r.id));

export function validateAgentModels(models: AgentModels | undefined): void {
  if (!models) return;
  const profiles = models.profiles;
  if (typeof profiles !== 'object' || profiles === null)
    throw new Error('Refusing to start: agentModels.profiles must be an object of profile name to model string.');
  for (const [name, profile] of Object.entries(profiles)) {
    if (typeof profile !== 'object' || profile === null)
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}" must be an object — {"model": "...", "effort": "..."}. ` +
          `A bare model string is no longer accepted; write {"model": ${JSON.stringify(profile)}} instead.`,
      );
    if (typeof profile.model !== 'string' || profile.model.length === 0)
      throw new Error(`Refusing to start: agentModels.profiles."${name}".model must be a non-empty model string.`);
    if (profile.effort !== undefined && !EFFORT_LEVELS.includes(profile.effort))
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}".effort is "${profile.effort}", which is not an effort ` +
          `level. Known levels: ${EFFORT_LEVELS.join(', ')}.`,
      );
    if (typeof profile.rank !== 'number' || !Number.isFinite(profile.rank))
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}".rank must be a number — where this profile sits on ` +
          `the cheap-to-deep ladder, low first. It is what lets the goal-profile gate say whether a proposal ` +
          `is cheaper or deeper than what is standing.`,
      );
    if (typeof profile.description !== 'string' || profile.description.trim().length === 0)
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}".description must be a non-empty sentence saying what ` +
          `this profile is for. It is the whole of what the appraiser is told about your profiles when it ` +
          `proposes one, so a missing or empty one makes every proposal a guess.`,
      );
  }
  const byRank = new Map<number, string>();
  for (const [name, profile] of Object.entries(profiles)) {
    const clash = byRank.get(profile.rank);
    if (clash !== undefined)
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}" and "${clash}" both have rank ${profile.rank}. ` +
          `Ranks order the profiles cheapest-first and must be unique.`,
      );
    byRank.set(profile.rank, name);
  }
  const known = (name: string): boolean => Object.hasOwn(profiles, name);
  if (models.default !== undefined && !known(models.default))
    throw new Error(
      `Refusing to start: agentModels.default names profile "${models.default}", which is not in agentModels.profiles.`,
    );
  for (const [rule, profile] of Object.entries(models.byRule ?? {})) {
    if (!STAGE_RULE_IDS.has(rule))
      throw new Error(
        `Refusing to start: agentModels.byRule."${rule}" is not a dispatch rule id — it would never match. ` +
          `Known ids: ${[...STAGE_RULE_IDS].join(', ')}.`,
      );
    if (!known(profile))
      throw new Error(
        `Refusing to start: agentModels.byRule."${rule}" names profile "${profile}", which is not in agentModels.profiles.`,
      );
  }
}

export function resolveAgentProfile(
  models: AgentModels | undefined,
  rule: string | null | undefined,
  pinned?: string | null,
): ResolvedProfile | null {
  if (!models) return null;
  const pin = pinned && Object.hasOwn(models.profiles, pinned) ? pinned : undefined;
  const source: ProfileSource = pin ? 'pin' : rule && models.byRule?.[rule] ? 'rule' : 'default';
  const name = pin ?? (rule ? models.byRule?.[rule] : undefined) ?? models.default;
  if (name === undefined) return null;
  const profile = models.profiles[name];
  if (profile === undefined) return null;
  return { name, model: profile.model, effort: profile.effort ?? null, source };
}

export function orderedProfiles(models: AgentModels | undefined): { name: string; description: string }[] {
  if (!models) return [];
  return Object.entries(models.profiles)
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([name, profile]) => ({ name, description: profile.description }));
}

export function profileRank(models: AgentModels | undefined, name: string | null | undefined): number | null {
  if (!models || !name) return null;
  const profile = models.profiles[name];
  return profile ? profile.rank : null;
}
