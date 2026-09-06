import { parseHealthReport, unreadable, type EnvironmentHealthReport } from './health.js';
import type { EnvironmentHealthProber } from './healthProber.js';

// → docs/spec/24-environments.md

export class FakeEnvironmentHealthProber implements EnvironmentHealthProber {
  readonly asked: string[] = [];

  constructor(private readonly output: Record<string, string> = {}) {}

  check(environment: string, _command: string): Promise<EnvironmentHealthReport> {
    this.asked.push(environment);
    const stdout = this.output[environment];
    if (stdout === undefined) return Promise.resolve(unreadable('unscripted'));
    return Promise.resolve(parseHealthReport(stdout));
  }
}
