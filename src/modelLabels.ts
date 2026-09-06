import { orderedProfiles, profileRank, type AgentModels } from './agents/modelPolicy.js';

// → docs/spec/10-agent-runtimes.md

function modelLabelFor(prefix: string, profile: string): string {
  return prefix ? `${prefix}-model-${profile}` : '';
}

export function modelLabelsFor(prefix: string, models: AgentModels | undefined): { profile: string; label: string }[] {
  if (!prefix) return [];
  return orderedProfiles(models).map((p) => ({ profile: p.name, label: modelLabelFor(prefix, p.name) }));
}

interface ModelTag {
  profile: string | null;
  ignored: string[];
}

export function resolveModelTag(
  labels: string[] | undefined,
  prefix: string,
  models: AgentModels | undefined,
): ModelTag {
  const present = labels ?? [];
  if (!prefix || !models) return { profile: null, ignored: [] };
  const known = new Map(modelLabelsFor(prefix, models).map((m) => [m.label, m.profile]));
  const marker = `${prefix}-model-`;
  let profile: string | null = null;
  const ignored: string[] = [];
  for (const label of present) {
    if (!label.startsWith(marker)) continue;
    const named = known.get(label);
    if (named === undefined) {
      ignored.push(label);
      continue;
    }
    if (profile === null) {
      profile = named;
      continue;
    }
    const standing: string = profile;
    const [deeper, shallower]: [string, string] =
      (profileRank(models, named) ?? 0) > (profileRank(models, standing) ?? 0) ? [named, standing] : [standing, named];
    profile = deeper;
    ignored.push(modelLabelFor(prefix, shallower));
  }
  return { profile, ignored };
}
