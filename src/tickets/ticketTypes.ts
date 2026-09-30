import type { Config } from '../config/config.js';

// → docs/spec/13-jobs-and-tickets.md

export const DEFAULT_FILING_TYPES = ['User Story', 'Bug'];

const DEFAULT_BUG_TYPE = 'Bug';

export function filingType(config: Config): string | null {
  if (config.integrations.issues !== 'azure' || !config.azureDevOps) return null;
  const named = (config.issueFilingTypes ?? []).map((t) => t.trim()).find((t) => t.length > 0);
  return named ?? DEFAULT_FILING_TYPES[0]!;
}

export function bugFilingType(config: Config): string | null {
  if (config.integrations.issues !== 'azure' || !config.azureDevOps) return null;
  return config.issueBugType?.trim() || DEFAULT_BUG_TYPE;
}

export function knownFilingTypes(config: Config): string[] {
  const head = filingType(config);
  if (head === null) return [];
  const named = [...(config.issueFilingTypes ?? []), bugFilingType(config)!, ...(config.issueContainerTypes ?? [])];
  return [...new Set([head, ...named.map((t) => t.trim()).filter((t) => t.length > 0)])];
}

type ChosenType = { ok: true; type: string | null } | { ok: false; error: string };

export function chooseFilingType(config: Config, requested: string | null): ChosenType {
  const fallback = filingType(config);
  if (requested === null) return { ok: true, type: fallback };
  if (fallback === null)
    return {
      ok: false,
      error: `type "${requested}" cannot be set: the "${config.integrations.issues}" tracker does not create items as a type.`,
    };
  return { ok: true, type: requested };
}
