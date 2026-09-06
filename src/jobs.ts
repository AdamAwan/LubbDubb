import type { Job } from './types.js';

// → docs/spec/13-jobs-and-tickets.md

export function jobBranch(job: Job): string | null {
  return job.kind === 'code' ? (job.branch ?? `job/${job.id}`) : null;
}

export function deriveJobTitle(prompt: string): string {
  const firstLine =
    prompt
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'Operator job';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}
