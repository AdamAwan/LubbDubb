import { parseAppErrorReport, unreadableErrors, type AppErrorReport } from './report.js';
import type { AppErrorReadRequest, AppErrorReader } from './reader.js';

// → docs/spec/39-app-errors.md

export class FakeAppErrorReader implements AppErrorReader {
  readonly asked: AppErrorReadRequest[] = [];

  constructor(private readonly output: Record<string, string> = {}) {}

  script(environment: string, stdout: string): void {
    this.output[environment] = stdout;
  }

  list(request: AppErrorReadRequest): Promise<AppErrorReport> {
    this.asked.push(request);
    const stdout = this.output[request.environment];
    if (stdout === undefined) return Promise.resolve(unreadableErrors('unscripted'));
    return Promise.resolve(parseAppErrorReport(stdout));
  }
}
