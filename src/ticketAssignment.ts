import type { Config } from './config.js';

// → docs/spec/13-jobs-and-tickets.md

export function ticketAssignee(config: Config): string | null {
  const who = config.userId?.trim();
  if (!who) return null;
  const provider = config.integrations.issues;
  if (provider === 'github' && config.github) return who;
  if (provider === 'azure' && config.azureDevOps) return who;
  return null;
}
