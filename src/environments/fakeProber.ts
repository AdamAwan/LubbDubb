import type { EnvironmentHead, EnvironmentProber } from './prober.js';

// → docs/spec/24-environments.md

export class FakeEnvironmentProber implements EnvironmentProber {
  readonly asked: string[] = [];

  constructor(private readonly heads: Record<string, string[]> = {}) {}

  at(environment: string, _command: string): Promise<EnvironmentHead> {
    this.asked.push(environment);
    const commits = this.heads[environment];
    return Promise.resolve(commits === undefined ? { commits: null, detail: 'unscripted' } : { commits, detail: null });
  }
}
