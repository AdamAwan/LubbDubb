import type { EnvironmentConfig } from './policy.js';

// → docs/spec/24-environments.md#groups

/**
 * One band of environments read as a single place. An environment that declares no `group`
 * is a band of one named for itself, so every reader has one shape rather than two — the
 * grouped case is not a second code path that only some surfaces learned.
 */
export interface EnvironmentGroup {
  name: string;
  environments: string[];
  /** Declared with `group`, rather than an ungrouped environment standing as its own band. */
  declared: boolean;
}

export function environmentGroups(environments: readonly EnvironmentConfig[]): EnvironmentGroup[] {
  const out: EnvironmentGroup[] = [];
  const byName = new Map<string, EnvironmentGroup>();
  for (const env of environments) {
    const name = env.group ?? env.name;
    let group = byName.get(name);
    if (group === undefined) {
      group = { name, environments: [], declared: env.group !== undefined };
      byName.set(name, group);
      out.push(group);
    }
    group.environments.push(env.name);
  }
  return out;
}

/** The band each environment belongs to, keyed by the environment's own name. */
export function bandOfEnvironment(environments: readonly EnvironmentConfig[]): Map<string, EnvironmentGroup> {
  const out = new Map<string, EnvironmentGroup>();
  for (const band of environmentGroups(environments)) for (const name of band.environments) out.set(name, band);
  return out;
}

/** `prod (liveEu, liveUs)` for a declared group, and the bare name for an environment standing alone. */
export function bandSaid(band: EnvironmentGroup): string {
  if (!band.declared) return band.name;
  return `${band.name} (${band.environments.join(', ')})`;
}
