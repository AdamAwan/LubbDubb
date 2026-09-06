import type { Config } from './config.js';

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
